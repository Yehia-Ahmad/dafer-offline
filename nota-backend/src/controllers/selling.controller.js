const mongoose = require("mongoose");
const Customer = require("../models/customer.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const ReturnLog = require("../models/returnLog.model");
const asyncHandler = require("../utils/asyncHandler");
const { createReturnLog } = require("../services/returns.service");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { assertPricePrecision } = require("../utils/pricePrecision");
const { buildPaginatedResponse, getPaginationParams } = require("../utils/pagination");
const { canSellBelowCost } = require("../auth/middleware");
const { actorFields } = require("../utils/actorFields");
const { PREFIXES, nextDocumentNumber, normalizeNumberSearch } = require("../utils/documentNumber");
const { withTransaction } = require("../utils/transaction");
const { postSale, postReturn, postInventoryAdjustment, postInvoiceEdit, postInvoiceCancel } = require("../accounting/posting");
const { resolveBox, usableBoxOf } = require("../cashbox/boxes");
const { priceNewInvoice, repriceEditedInvoice, recordVatEvent, periodFor, today, assertExpectedAmount } = require("../accounting/vat");
const { computeReturnVat, computeReturnBreakdown, round2: vatRound2 } = require("../utils/vat");
const { vatInvoiceView, vatItemView, netInvoiceProfit } = require("../utils/vatView");
const CashBox = require("../models/cashBox.model");
const { audit } = require("../auth/audit");

const getRawQuantity = (body) => {
  if (body.quantity !== undefined) return body.quantity;
  if (body.quentity !== undefined) return body.quentity;
  return undefined;
};

const normalizeSellingDate = (value, res) => {
  if (value === undefined || value === null || value === "") {
    res.status(400);
    throw new Error("تاريخ البيع مطلوب");
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    res.status(400);
    throw new Error("تنسيق تاريخ البيع غير صالح");
  }

  return parsedDate;
};

const parsePositiveInteger = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseNonNegativeNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

const normalizeOptionalDiscountAmount = (value, res) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return 0;
  }

  const parsed = parseNonNegativeNumber(value);
  if (parsed === null) {
    res.status(400);
    throw new Error("قيمة الخصم يجب أن تكون رقمًا غير سالب");
  }

  return roundMoney(parsed);
};

const normalizeOptionalShippingFees = (value, res) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return 0;
  }

  const parsed = parseNonNegativeNumber(value);
  if (parsed === null) {
    res.status(400);
    throw new Error("مصاريف الشحن يجب أن تكون رقمًا غير سالب");
  }

  return roundMoney(parsed);
};

const resolveStoredDiscountPricing = (currentValues = {}) => {
  if (currentValues.discountAmount !== undefined && currentValues.discountAmount !== null) {
    return {
      discountAmount: roundMoney(currentValues.discountAmount || 0),
    };
  }

  if (
    currentValues.discountPercentage !== undefined &&
    currentValues.discountPercentage !== null
  ) {
    return {
      discountPercentage: Number(currentValues.discountPercentage || 0),
    };
  }

  return {
    discountAmount: 0,
  };
};

const resolveInvoicePricing = (body, currentValues, res) => ({
  ...(body.discountAmount !== undefined
    ? {
        discountAmount: normalizeOptionalDiscountAmount(body.discountAmount, res) ?? 0,
      }
    : resolveStoredDiscountPricing(currentValues)),
  shippingFees:
    body.shippingFees !== undefined
      ? normalizeOptionalShippingFees(body.shippingFees, res) ?? 0
      : roundMoney(currentValues.shippingFees || 0),
});

const normalizeRequiredString = (value, fieldLabel, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} مطلوب`);
  }

  return value.trim();
};

const normalizeOptionalString = (value, fieldLabel, res) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} غير صالح`);
  }

  return value.trim();
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getUtcDayRange = (dateValue) => {
  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const startOfDayUtc = new Date(
    Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
  );
  const endOfDayUtc = new Date(startOfDayUtc);
  endOfDayUtc.setUTCDate(endOfDayUtc.getUTCDate() + 1);

  return { startOfDayUtc, endOfDayUtc };
};

const getSellingItemProductId = (item) => {
  if (
    item.product &&
    typeof item.product === "object" &&
    item.product._id !== undefined
  ) {
    return item.product._id;
  }

  return item.product;
};

const normalizeSellingItems = (body, res, options = {}) => {
  // options.storedPrice: the price comes from the stored invoice (an edit that only changes the quantity), so a legacy price is kept as is.
  // options.storedPrices: productId -> the unit prices that product already has on the invoice being edited. A line that sends
  // its stored price back (a full-items edit that changes only a quantity) keeps it even with 3 decimals; a new or changed price
  // must have at most 2.
  const checkPrice = (price, label, productId) => {
    if (options.storedPrice) return;
    const stored = options.storedPrices && options.storedPrices.get(String(productId));
    if (stored && stored.has(Number(price))) return;
    assertPricePrecision(price, label);
  };
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) {
      res.status(400);
      throw new Error("يجب أن تكون items مصفوفة");
    }

    if (body.items.length === 0) {
      res.status(400);
      throw new Error("يجب أن تحتوي items على عنصر واحد على الأقل");
    }

    return body.items.map((item, index) => {
      const itemNumber = index + 1;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        res.status(400);
        throw new Error(`العنصر رقم ${itemNumber} غير صالح`);
      }

      const { productId, price } = item;
      const rawQuantity = getRawQuantity(item) ?? options.defaultQuantity;

      if (!productId) {
        res.status(400);
        throw new Error(`معرّف المنتج مطلوب في العنصر رقم ${itemNumber}`);
      }

      if (!mongoose.Types.ObjectId.isValid(productId)) {
        res.status(400);
        throw new Error(`تنسيق معرّف المنتج غير صالح في العنصر رقم ${itemNumber}`);
      }

      if (rawQuantity === undefined) {
        res.status(400);
        throw new Error(`كمية المنتج مطلوبة في العنصر رقم ${itemNumber}`);
      }

      const quantity = parsePositiveInteger(rawQuantity);
      if (quantity === null) {
        res.status(400);
        throw new Error(`يجب أن تكون كمية المنتج رقمًا صحيحًا موجبًا في العنصر رقم ${itemNumber}`);
      }

      if (price === undefined) {
        res.status(400);
        throw new Error(`السعر مطلوب في العنصر رقم ${itemNumber}`);
      }

      const unitPrice = parseNonNegativeNumber(price);
      if (unitPrice === null) {
        res.status(400);
        throw new Error(`يجب أن يكون السعر رقمًا غير سالب في العنصر رقم ${itemNumber}`);
      }
      checkPrice(price, `السعر في العنصر رقم ${itemNumber}`, productId);

      return {
        productId,
        quantity,
        unitPrice,
      };
    });
  }

  const { productId, price } = body;
  const rawQuantity = getRawQuantity(body) ?? options.defaultQuantity;

  if (!productId) {
    res.status(400);
    throw new Error("معرّف المنتج مطلوب");
  }

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    res.status(400);
    throw new Error("تنسيق معرّف المنتج غير صالح");
  }

  if (rawQuantity === undefined) {
    res.status(400);
    throw new Error("كمية المنتج مطلوبة");
  }

  const quantity = parsePositiveInteger(rawQuantity);
  if (quantity === null) {
    res.status(400);
    throw new Error("يجب أن تكون كمية المنتج رقمًا صحيحًا موجبًا");
  }

  if (price === undefined) {
    res.status(400);
    throw new Error("السعر مطلوب");
  }

  const unitPrice = parseNonNegativeNumber(price);
  if (unitPrice === null) {
    res.status(400);
    throw new Error("يجب أن يكون السعر رقمًا غير سالب");
  }
  checkPrice(price, "السعر", productId);

  return [
    {
      productId,
      quantity,
      unitPrice,
    },
  ];
};

/** productId -> Set of the unit prices the invoice being edited already has for it. */
const storedPricesOf = (items) => {
  const map = new Map();
  for (const item of items) {
    const key = String(item.productId);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(Number(item.unitPrice));
  }
  return map;
};

const hasInvoiceItems = (selling) => Array.isArray(selling.items) && selling.items.length > 0;

const resolveItemPurchasePrice = (item, product) => {
  const rawPurchasePrice =
    item.purchasePrice !== undefined
      ? item.purchasePrice
      : product?.purchasePrice ?? product?.wholesalePrice ?? 0;
  const purchasePrice = Number(rawPurchasePrice);

  return Number.isFinite(purchasePrice) ? roundMoney(Math.max(0, purchasePrice)) : 0;
};

const getSellingItems = (selling) => {
  if (hasInvoiceItems(selling)) {
    return selling.items;
  }

  if (!selling.product) {
    return [];
  }

  return [
    {
      _id: selling._id,
      product: selling.product,
      productName: selling.productName,
      categoryName: selling.categoryName,
      quantity: selling.quantity,
      unitPrice: selling.unitPrice,
      totalPrice:
        selling.unitPrice !== undefined && selling.quantity !== undefined
          ? roundMoney(Number(selling.unitPrice || 0) * Number(selling.quantity || 0))
          : selling.totalPrice,
      purchasePrice: 0,
      profitAmount: 0,
    },
  ];
};

const getInvoiceIdentifier = (selling) => selling.invoiceId ?? selling._id;

const getRefundedQuantityByItemId = (selling) => {
  const refundedQuantityByItemId = new Map();

  for (const refund of selling.refunds || []) {
    for (const item of refund.items || []) {
      if (!item.invoiceItemId) continue;

      const itemId = item.invoiceItemId.toString();
      refundedQuantityByItemId.set(
        itemId,
        Number(refundedQuantityByItemId.get(itemId) || 0) + Number(item.quantity || 0)
      );
    }
  }

  return refundedQuantityByItemId;
};

const getVisibleSellingItems = (selling) => {
  const refundedQuantityByItemId = getRefundedQuantityByItemId(selling);

  return getSellingItems(selling)
    .map((item) => {
      if (!item._id) return item;

      const refundedQuantity = Number(refundedQuantityByItemId.get(item._id.toString()) || 0);
      const originalQuantity = Number(item.quantity || 0);
      const remainingQuantity = originalQuantity - refundedQuantity;

      if (remainingQuantity <= 0) return null;

      return {
        ...(item.toObject?.() ?? item),
        quantity: remainingQuantity,
        totalPrice: roundMoney(Number(item.unitPrice || 0) * remainingQuantity),
        profitAmount:
          originalQuantity > 0
            ? roundMoney((Number(item.profitAmount || 0) / originalQuantity) * remainingQuantity)
            : 0,
      };
    })
    .filter(Boolean);
};

const toSellingInvoiceItem = (item, selling, options = {}) => {
  const sellingHistoryItem = {
    _id: item._id ?? null,
    invoiceId: getInvoiceIdentifier(selling),
    productId: getSellingItemProductId(item),
    productName: item.productName,
    categoryName: item.categoryName,
    productQuantity: item.quantity,
    productQuentity: item.quantity,
    sellingDate: selling.sellingDate,
    customerName: selling.customerName,
    customerPhone: selling.customerPhone ?? null,
    productPricePerEach: item.unitPrice,
    purchasePrice: item.purchasePrice ?? 0,
    profitAmount: item.profitAmount ?? 0,
    returnedQuantity: item.returnedQuantity ?? refundedForItem(selling, item._id),
    totalPrice: item.totalPrice,
    ...vatItemView(item),
  };

  if (options.includeProductCode) {
    sellingHistoryItem.productCode =
      item.product && typeof item.product === "object" ? item.product.code ?? null : null;
  }

  return sellingHistoryItem;
};

const toSellingInvoice = (selling, options = {}) => {
  const visibleItems = options.excludeRefundedItems
    ? getVisibleSellingItems(selling)
    : getSellingItems(selling);
  const items = visibleItems.map((item) => toSellingInvoiceItem(item, selling, options));
  const totals = buildInvoiceTotals(items, {
    discountAmount: selling.discountAmount,
    discountPercentage: selling.discountPercentage,
    shippingFees: selling.shippingFees,
  });

  return {
    _id: selling._id,
    number: selling.number ?? null,
    invoiceId: getInvoiceIdentifier(selling),
    customerName: selling.customerName,
    customerPhone: selling.customerPhone ?? null,
    sellingDate: selling.sellingDate,
    itemCount: items.length,
    totalQuantity: options.excludeRefundedItems
      ? totals.totalQuantity
      : selling.totalQuantity ?? totals.totalQuantity,
    discountAmount: totals.discountAmount,
    shippingFees: selling.shippingFees ?? totals.shippingFees,
    totalPrice: selling.totalPrice ?? totals.totalPrice,
    netTotal: roundMoney(Math.max(0, Number(selling.totalPrice ?? totals.totalPrice) - Number(selling.refundedAmount || 0))),
    totalProfit: netInvoiceProfit(selling, items) ?? roundMoney(
      items.reduce((sum, item) => sum + Number(item.profitAmount || 0), 0) - totals.discountAmount
    ),
    refundStatus: selling.refundStatus ?? "none",
    refundedQuantity: selling.refundedQuantity ?? 0,
    refundedAmount: selling.refundedAmount ?? 0,
    status: selling.status ?? "active",
    cancelledAt: selling.cancelledAt ?? null,
    cancelledBy: selling.cancelledBy ?? null,
    cancelledByName: selling.cancelledByName ?? null,
    cancellationReason: selling.cancellationReason ?? null,
    cancelRefundAmount: selling.cancelRefundAmount ?? 0,
    boxId: selling.boxId ?? null,
    // The box that paid a cancelled sale's refund (old cancels: the sale's own box).
    cancelRefundBoxId: selling.status === "cancelled" && selling.cancelRefundAmount > 0 ? (selling.cancelRefundBoxId ?? selling.boxId ?? null) : null,
    refunds: (selling.refunds || []).map((refund) => ({
      _id: refund._id,
      refundDate: refund.refundDate,
      note: refund.note ?? null,
      totalQuantity: refund.totalQuantity,
      totalAmount: refund.totalAmount,
      returnLogId: refund.returnLog ?? null,
      items: (refund.items || []).map((item) => ({
        _id: item._id,
        invoiceItemId: item.invoiceItemId,
        productId: getSellingItemProductId(item),
        productName: item.productName,
        productCode: options.includeProductCode && typeof item.product === "object" ? item.product.code ?? null : undefined,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        returnReason: item.returnReason ?? null,
      })),
    })),
    items,
    ...vatInvoiceView(selling),
    ...actorFields(selling),
  };
};

const refundedForItem = (selling, itemId) => (selling.refunds || []).reduce(
  (total, refund) => total + (refund.items || []).reduce(
    (sum, item) => sum + (item.invoiceItemId?.toString() === itemId.toString() ? Number(item.quantity) : 0), 0
  ), 0
);

const normalizeRefundSelections = (selling, body, res) => {
  if (!Array.isArray(body.items) || body.items.length === 0) { res.status(400); throw new Error("يجب أن تحتوي items على عنصر واحد على الأقل"); }
  const invoiceItems = getSellingItems(selling);
  const selections = new Map();
  body.items.forEach((input, index) => {
    const number = index + 1;
    if (!input || typeof input !== "object" || Array.isArray(input)) { res.status(400); throw new Error(`عنصر المرتجع رقم ${number} غير صالح`); }
    const itemId = typeof input.itemId === "string" ? input.itemId.trim() : "";
    const productId = typeof input.productId === "string" ? input.productId.trim() : "";
    if (!itemId && !productId) { res.status(400); throw new Error(`productId أو itemId مطلوب في العنصر رقم ${number}`); }
    if ((itemId && !mongoose.Types.ObjectId.isValid(itemId)) || (productId && !mongoose.Types.ObjectId.isValid(productId))) {
      res.status(400); throw new Error(`تنسيق المعرّف غير صالح في العنصر رقم ${number}`);
    }
    const matches = itemId
      ? invoiceItems.filter((item) => item._id?.toString() === itemId)
      : invoiceItems.filter((item) => getSellingItemProductId(item)?.toString() === productId);
    if (!matches.length) { res.status(404); throw new Error(`المنتج غير موجود في الفاتورة لعنصر المرتجع رقم ${number}`); }
    if (matches.length > 1) { res.status(400); throw new Error(`يجب استخدام itemId للعنصر رقم ${number} لتجنب التكرار`); }
    const quantity = parsePositiveInteger(input.quantity);
    if (quantity === null) { res.status(400); throw new Error(`كمية المرتجع غير صالحة في العنصر رقم ${number}`); }
    if (input.returnReason !== undefined && (typeof input.returnReason !== "string" || input.returnReason.trim().length > 500)) {
      res.status(400); throw new Error(`سبب المرتجع غير صالح في العنصر رقم ${number}`);
    }
    const invoiceItem = matches[0];
    const key = invoiceItem._id.toString();
    const selection = selections.get(key) || { invoiceItem, quantity: 0 };
    selection.quantity += quantity;
    selection.returnReason = input.returnReason?.trim() || selection.returnReason;
    if (selection.quantity > Number(invoiceItem.quantity) - refundedForItem(selling, invoiceItem._id)) {
      res.status(400); throw new Error(`كمية المرتجع تتجاوز الكمية المتاحة في العنصر رقم ${number}`);
    }
    selections.set(key, selection);
  });
  return [...selections.values()];
};

const ensureCustomerExistsForSelling = async ({ customerName, customerPhone, session }) => {
  if (
    typeof customerName !== "string" ||
    !customerName.trim() ||
    typeof customerPhone !== "string" ||
    !customerPhone.trim()
  ) {
    return null;
  }

  const existingCustomer = await Customer.findOne({
    name: customerName,
    phone: customerPhone,
  }).session(session || null);

  if (existingCustomer) {
    return existingCustomer;
  }

  return Customer.findOneAndUpdate(
    { phone: customerPhone },
    {
      $set: { name: customerName },
      $setOnInsert: { phone: customerPhone },
    },
    {
      new: true,
      runValidators: true,
      upsert: true,
      setDefaultsOnInsert: true,
      session,
    }
  );
};

const toSellingItemInput = (item) => ({
  productId: getSellingItemProductId(item)?.toString(),
  quantity: Number(item.quantity),
  unitPrice: Number(item.unitPrice),
  purchasePrice: Number(item.purchasePrice ?? 0),
});

const getSellingItemInputs = (selling) =>
  getSellingItems(selling)
    .map(toSellingItemInput)
    .filter((item) => item.productId);

const buildQuantityByProductId = (items) => {
  const quantityByProductId = new Map();

  for (const item of items) {
    const productId = item.productId.toString();
    quantityByProductId.set(
      productId,
      Number(quantityByProductId.get(productId) || 0) + Number(item.quantity)
    );
  }

  return quantityByProductId;
};

const applyInventoryForInvoiceChange = async ({
  currentItems,
  nextItems,
  res,
  allowInsufficientInventory = false,
  inventoryAdjustmentsByProductId = new Map(),
  // Stage 13: true only with NOTA_AUTH=1 for a user with sales.priceBelowCost (canSellBelowCost).
  allowBelowCost = false,
  session,
}) => {
  const currentQuantityByProductId = buildQuantityByProductId(currentItems);
  const nextQuantityByProductId = buildQuantityByProductId(nextItems);
  const allProductIds = [...new Set([
    ...currentQuantityByProductId.keys(),
    ...nextQuantityByProductId.keys(),
  ])];

  if (allProductIds.length === 0) {
    return new Map();
  }

  const products = await Product.find({ _id: { $in: allProductIds } }).populate("category", "name").session(session || null);
  const productsById = new Map(products.map((product) => [product._id.toString(), product]));
  const originalStates = new Map();

  for (const product of products) {
    originalStates.set(product._id.toString(), {
      inventoryCount: Number(product.inventoryCount || 0),
      soldItemCount: Number(product.soldItemCount || 0),
    });
  }

  const shortages = [];

  for (const [productId, nextQuantity] of nextQuantityByProductId.entries()) {
    const product = productsById.get(productId);
    if (!product) {
      res.status(404);
      throw new Error("المنتج غير موجود");
    }

    const currentQuantity = Number(currentQuantityByProductId.get(productId) || 0);
    const availableQuantity = Number(product.inventoryCount || 0) + currentQuantity;
    if (availableQuantity < nextQuantity) {
      shortages.push({
        productId,
        productName: product.name,
        requestedQuantity: nextQuantity,
        availableQuantity,
        missingQuantity: nextQuantity - availableQuantity,
      });
    }
  }

  if (shortages.length > 0 && !allowInsufficientInventory) {
    const error = new Error("الكمية المطلوبة غير متوفرة بالكامل في المخزون");
    error.statusCode = 409;
    error.responseData = {
      code: "INSUFFICIENT_INVENTORY",
      requiresConfirmation: true,
      shortages,
    };
    throw error;
  }

  const autoRestockedByProductId = new Map(
    shortages.map((shortage) => [shortage.productId, shortage.missingQuantity])
  );

  for (const item of nextItems) {
    const productId = item.productId?.toString();
    if (!productId) continue;

    const product = productsById.get(productId);
    if (!product) continue;

    const purchasePrice = resolveItemPurchasePrice(item, product);
    const unitPrice = roundMoney(Number(item.unitPrice || 0));

    // The message never includes the purchase price.
    if (unitPrice < purchasePrice && !allowBelowCost) {
      res.status(400);
      throw new Error(`سعر البيع لا يمكن أن يكون أقل من سعر الشراء للمنتج ${product.name}`);
    }
  }

  for (const productId of allProductIds) {
      const product = productsById.get(productId);
      if (!product) continue;

      const originalState = originalStates.get(productId);
      const currentQuantity = Number(currentQuantityByProductId.get(productId) || 0);
      const nextQuantity = Number(nextQuantityByProductId.get(productId) || 0);
      const autoRestockedQuantity = Number(autoRestockedByProductId.get(productId) || 0);
      const inventoryAdjustment = Number(inventoryAdjustmentsByProductId.get(productId) || 0);

      if (autoRestockedQuantity > 0) {
        await Product.updateOne({ _id: product._id }, { $inc: { inventoryCount: autoRestockedQuantity } }, { session });
      }
      const inventoryDelta = currentQuantity - nextQuantity + inventoryAdjustment;
      const soldDelta = nextQuantity - currentQuantity;
      const filter = { _id: product._id };
      if (inventoryDelta < 0) filter.inventoryCount = { $gte: -inventoryDelta };
      const result = await Product.updateOne(filter, { $inc: { inventoryCount: inventoryDelta, soldItemCount: soldDelta } }, { session });
      if (result.matchedCount === 0) {
        const stockError = new Error("الكمية المطلوبة غير متوفرة بالكامل في المخزون");
        stockError.statusCode = 409;
        stockError.responseData = { code: "INSUFFICIENT_INVENTORY" };
        throw stockError;
      }
      product.inventoryCount = originalState.inventoryCount + autoRestockedQuantity + inventoryDelta;
      product.soldItemCount = Math.max(0, originalState.soldItemCount + soldDelta);
  }

  productsById.autoRestockedByProductId = autoRestockedByProductId;
  return productsById;
};

const buildPersistedItems = (items, productsById) =>
  items.map((item) => {
    const product = productsById.get(item.productId.toString());
    const purchasePrice = resolveItemPurchasePrice(item, product);
    const totalPrice = roundMoney(item.unitPrice * item.quantity);
    const totalCost = roundMoney(purchasePrice * item.quantity);

    return {
      product: product._id,
      productName: product.name,
      categoryName: product.category ? product.category.name : "Uncategorized",
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice,
      purchasePrice,
      profitAmount: roundMoney(totalPrice - totalCost),
    };
  });

const hasLineItemChanges = (body) =>
  body.items !== undefined ||
  body.productId !== undefined ||
  body.price !== undefined ||
  getRawQuantity(body) !== undefined;

const createSellingInvoice = async ({ body, res, allowBelowCost = false, session, number, boxId }) => {
  const { customerName, customerPhone } = body;
  const normalizedCustomerName = normalizeRequiredString(customerName, "اسم العميل", res);
  const normalizedCustomerPhone = normalizeRequiredString(customerPhone, "رقم هاتف العميل", res);
  const normalizedSellingDate = normalizeSellingDate(body.sellingDate, res);
  const items = normalizeSellingItems(body, res);
  const invoicePricing = resolveInvoicePricing(body, {}, res);

  await ensureCustomerExistsForSelling({
    customerName: normalizedCustomerName,
    customerPhone: normalizedCustomerPhone,
    session,
  });

  const productsById = await applyInventoryForInvoiceChange({
    currentItems: [],
    nextItems: items,
    res,
    allowInsufficientInventory: body.confirmInsufficientInventory === true,
    allowBelowCost,
    session,
  });
  const persistedItems = buildPersistedItems(items, productsById);
  const invoiceTotals = buildInvoiceTotals(persistedItems, invoicePricing);
  // Stage 21: VAT (only when the shop has it on and the invoice date is on/after its start date).
  const vat = await priceNewInvoice({ persistedItems, productsById, invoiceTotals, businessDate: normalizedSellingDate, session });
  if (vat) invoiceTotals.totalPrice = vat.computed.totalPrice;
  // The screen's total (from its cached VAT settings) must be what the server now computes; otherwise nothing is saved (409 TOTAL_CHANGED).
  await assertExpectedAmount({ expected: body.expectedTotal, actual: invoiceTotals.totalPrice, code: "TOTAL_CHANGED", session, extra: { vatAmount: vat ? vat.computed.vatAmount : 0 } });
  const created = await Selling.create([{
      number,
      customerName: normalizedCustomerName,
      customerPhone: normalizedCustomerPhone,
      sellingDate: normalizedSellingDate,
      items: persistedItems,
      totalQuantity: invoiceTotals.totalQuantity,
      discountAmount: invoiceTotals.discountAmount,
      shippingFees: invoiceTotals.shippingFees,
      totalPrice: invoiceTotals.totalPrice,
      ...(boxId ? { boxId } : {}),
      ...(vat ? vat.fields : {}),
  }], { session });
  created[0]._autoRestockAdjustments = [...(productsById.autoRestockedByProductId || new Map()).entries()].map(([productId, quantity]) => ({ productId, quantity }));
  return created[0];
};

const createSelling = asyncHandler(async (req, res) => {
  const selling = await withTransaction(async (session) => {
    // Stage 19: the sale goes into a box (request boxId, else this PC's drawer, else the main box).
    const box = await resolveBox({ req, boxId: req.body && req.body.boxId, session });
    const number = await require("../utils/documentNumber").nextDocumentNumber(PREFIXES.CASH_INVOICE, session);
    const created = await createSellingInvoice({
      body: req.body,
      res,
      allowBelowCost: canSellBelowCost(req),
      session,
      number,
      boxId: box._id,
    });
    await audit(req, { action: "sale.created", entity: "Selling", entityId: created._id, session, strict: true });
    await postSale({ sale: created, session });
    if (created.vatRate !== undefined && created.vatRate !== null) await recordVatEvent({ kind: "sale", direction: "output", sourceType: "sale", sourceId: created._id, number: created.number, date: created.sellingDate, net: created.netAmount, vat: created.vatAmount, session });
    for (const adjustment of created._autoRestockAdjustments || []) {
      const product = await Product.findById(adjustment.productId).session(session).lean();
      const amount = roundMoney(Number(adjustment.quantity || 0) * Number(product?.purchasePrice || 0));
      if (amount > 0) await postInventoryAdjustment({ date: created.sellingDate, source: { type: "auto_restock", id: created._id, number: created.number }, amount, increase: true, session });
    }
    return created;
  });

  res.status(201).json(toSellingInvoice(selling));
});

const getSellings = asyncHandler(async (req, res) => {
  const { categoryId, productId, customerName, customerPhone, sellingDate, number } = req.query;
  const sellingQuery = {};
  const { page, limit, skip } = getPaginationParams(req.query);

  if (number !== undefined) sellingQuery.number = normalizeNumberSearch(number, PREFIXES.CASH_INVOICE);

  if (
    categoryId !== undefined &&
    (typeof categoryId !== "string" || !mongoose.Types.ObjectId.isValid(categoryId))
  ) {
    res.status(400);
    throw new Error("تنسيق معرّف الفئة غير صالح");
  }

  if (
    productId !== undefined &&
    (typeof productId !== "string" || !mongoose.Types.ObjectId.isValid(productId))
  ) {
    res.status(400);
    throw new Error("تنسيق معرّف المنتج غير صالح");
  }

  if (customerName !== undefined) {
    if (typeof customerName !== "string") {
      res.status(400);
      throw new Error("تنسيق اسم العميل غير صالح");
    }

    const normalizedCustomerName = customerName.trim();
    if (normalizedCustomerName) {
      sellingQuery.customerName = new RegExp(escapeRegex(normalizedCustomerName), "i");
    }
  }

  if (customerPhone !== undefined) {
    if (typeof customerPhone !== "string") {
      res.status(400);
      throw new Error("تنسيق رقم هاتف العميل غير صالح");
    }

    const normalizedCustomerPhone = customerPhone.trim();
    if (normalizedCustomerPhone) {
      sellingQuery.customerPhone = new RegExp(escapeRegex(normalizedCustomerPhone), "i");
    }
  }

  if (sellingDate !== undefined) {
    if (typeof sellingDate !== "string") {
      res.status(400);
      throw new Error("تنسيق تاريخ البيع غير صالح");
    }

    const normalizedSellingDate = sellingDate.trim();
    if (!normalizedSellingDate) {
      res.status(400);
      throw new Error("لا يمكن أن يكون معامل الاستعلام sellingDate فارغًا");
    }

    const dateRange = getUtcDayRange(normalizedSellingDate);
    if (!dateRange) {
      res.status(400);
      throw new Error("تنسيق تاريخ البيع غير صالح");
    }

    sellingQuery.sellingDate = {
      $gte: dateRange.startOfDayUtc,
      $lt: dateRange.endOfDayUtc,
    };
  }

  if (categoryId !== undefined || productId !== undefined) {
    const productFilter = {};
    if (categoryId !== undefined) productFilter.category = categoryId;
    if (productId !== undefined) productFilter._id = productId;

    const products = await Product.find(productFilter).select("_id").lean();
    if (products.length === 0) {
      return res.json(buildPaginatedResponse({ data: [], page, limit, totalItems: 0 }));
    }

    const matchingProductIds = products.map((product) => product._id);
    sellingQuery.$or = [
      { "items.product": { $in: matchingProductIds } },
      { product: { $in: matchingProductIds } },
    ];
  }

  const [sellings, totalItems] = await Promise.all([
    Selling.find(sellingQuery)
      .populate("items.product", "code")
      .populate("product", "code")
      .populate("refunds.items.product", "code")
      .sort({ sellingDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Selling.countDocuments(sellingQuery),
  ]);

  res.json(
    buildPaginatedResponse({
      data: await withRefundBoxNames(sellings.map((selling) =>
        toSellingInvoice(selling, {
          includeProductCode: true,
          excludeRefundedItems: true,
        })
      )),
      page,
      limit,
      totalItems,
    })
  );
});

/** Adds cancelRefundBoxName to invoices that have a cancelRefundBoxId (one lookup for the whole list). */
const withRefundBoxNames = async (invoices) => {
  const ids = [...new Set(invoices.map((invoice) => invoice.cancelRefundBoxId).filter(Boolean).map(String))];
  if (!ids.length) return invoices;
  const names = new Map((await CashBox.find({ _id: { $in: ids } }).select("name").lean()).map((box) => [String(box._id), box.name]));
  return invoices.map((invoice) => (invoice.cancelRefundBoxId ? { ...invoice, cancelRefundBoxName: names.get(String(invoice.cancelRefundBoxId)) ?? null } : invoice));
};

const getSellingById = asyncHandler(async (req, res) => {
  const selling = await Selling.findById(req.params.id)
    .populate("items.product", "code")
    .populate("product", "code")
    .populate("refunds.items.product", "code");

  if (!selling) {
    res.status(404);
    throw new Error("سجل البيع غير موجود");
  }

  const [invoice] = await withRefundBoxNames([toSellingInvoice(selling, { includeProductCode: true })]);
  res.json(invoice);
});

const updateSellingInTransaction = async (req, res, session) => {
  const selling = await Selling.findById(req.params.id).session(session);

  if (!selling) {
    res.status(404);
    throw new Error("سجل البيع غير موجود");
  }
  if (selling.status === "cancelled") {
    const error = new Error("لا يمكن تعديل فاتورة ملغية");
    error.statusCode = 409; error.responseData = { code: "CANCELLED" }; throw error;
  }

  const oldSelling = selling.toObject();
  const normalizedCustomerName =
    req.body.customerName !== undefined
      ? normalizeRequiredString(req.body.customerName, "اسم العميل", res)
      : selling.customerName;
  const normalizedCustomerPhone =
    req.body.customerPhone !== undefined
      ? normalizeRequiredString(req.body.customerPhone, "رقم هاتف العميل", res)
      : selling.customerPhone;
  const normalizedSellingDate =
    req.body.sellingDate !== undefined
      ? normalizeSellingDate(req.body.sellingDate, res)
      : selling.sellingDate;
  const invoicePricing = resolveInvoicePricing(req.body, selling, res);

  const shouldUpdateItems = hasLineItemChanges(req.body);
  const shouldUpdateInvoicePricing =
    shouldUpdateItems ||
    req.body.discountAmount !== undefined ||
    req.body.shippingFees !== undefined;
  if (shouldUpdateInvoicePricing && selling.refunds?.length) {
    res.status(400);
    throw new Error("لا يمكن تعديل عناصر أو تسعير فاتورة تحتوي على مرتجعات");
  }
  const currentItems = getSellingItemInputs(selling);

  let nextItems = currentItems;
  let productsById = new Map();
  let persistedItems = null;
  let vatEdit = null;

  if (shouldUpdateItems) {
    if (req.body.items === undefined && currentItems.length !== 1) {
      res.status(400);
      throw new Error("يجب إرسال items لتعديل فاتورة تحتوي على أكثر من عنصر واحد");
    }

    if (req.body.items !== undefined) {
      nextItems = normalizeSellingItems(req.body, res, { storedPrices: storedPricesOf(currentItems) });
    } else {
      const currentItem = currentItems[0];
      if (!currentItem) {
        res.status(400);
        throw new Error("لا يمكن تعديل عناصر الفاتورة الحالية بهذا الطلب");
      }

      nextItems = normalizeSellingItems(
        {
          productId:
            req.body.productId !== undefined ? req.body.productId : currentItem.productId,
          quantity:
            getRawQuantity(req.body) !== undefined
              ? getRawQuantity(req.body)
              : currentItem.quantity,
          price: req.body.price !== undefined ? req.body.price : currentItem.unitPrice,
        },
        res,
        { storedPrice: req.body.price === undefined }
      );
    }

    productsById = await applyInventoryForInvoiceChange({
      currentItems,
      nextItems,
      res,
      allowBelowCost: canSellBelowCost(req),
      session,
    });
  }

  await ensureCustomerExistsForSelling({
    customerName: normalizedCustomerName,
    customerPhone: normalizedCustomerPhone,
    session,
  });

  if (shouldUpdateItems) {
    persistedItems = buildPersistedItems(nextItems, productsById);
    selling.items = persistedItems;

    // Clear legacy top-level line-item fields after converting to invoice storage.
    selling.product = undefined;
    selling.productName = undefined;
    selling.categoryName = undefined;
    selling.quantity = undefined;
    selling.unitPrice = undefined;
  }

  if (shouldUpdateInvoicePricing) {
    const pricingItems = shouldUpdateItems ? persistedItems : getSellingItems(selling);
    const invoiceTotals = buildInvoiceTotals(pricingItems, invoicePricing);

    selling.totalQuantity = invoiceTotals.totalQuantity;
    selling.discountAmount = invoiceTotals.discountAmount;
    selling.discountPercentage = undefined;
    selling.shippingFees = invoiceTotals.shippingFees;
    // Stage 21: an invoice that has VAT keeps the rate and mode it was saved with; its VAT is recomputed from the new figures.
    vatEdit = repriceEditedInvoice({ invoice: oldSelling, persistedItems: pricingItems, productsById, invoiceTotals });
    if (vatEdit) {
      // The stored lines (not the plain objects that were cast on assignment) must carry the exempt flag and the line VAT.
      (selling.items || []).forEach((item, index) => { item.vatExempt = Boolean(pricingItems[index] && pricingItems[index].vatExempt); item.vatAmount = vatEdit.computed.itemVat[index]; });
      Object.assign(selling, vatEdit.fields);
      invoiceTotals.totalPrice = vatEdit.computed.totalPrice;
    }
    selling.totalPrice = invoiceTotals.totalPrice;
  }

  selling.customerName = normalizedCustomerName;
  selling.customerPhone = normalizedCustomerPhone;
  selling.sellingDate = normalizedSellingDate;

  // Stage 19: an edit that changes the cash moves money in the sale's ORIGINAL box. That box must still be active and,
  // when it uses shifts, have an open shift. The change is recorded with its time so a shift counts it when it happened.
  const cashDelta = roundMoney(Number(selling.totalPrice || 0) - Number(oldSelling.totalPrice || 0));
  if (cashDelta !== 0) {
    await usableBoxOf(selling.boxId, session);
    selling.boxMoves = [...(selling.boxMoves || []), { at: new Date(), delta: cashDelta, ...(selling.boxId ? { boxId: selling.boxId } : {}) }];
  }
  const updatedSelling = await selling.save({ session });

  await postInvoiceEdit({ Model: Selling, oldSale: oldSelling, newSale: updatedSelling, date: new Date(), session });
  if (vatEdit) {
    // The edit gets its OWN vatPeriod (its own date); the original month is never rewritten.
    const vatDelta = vatRound2(updatedSelling.vatAmount - (oldSelling.vatAmount || 0));
    const netDelta = vatRound2(updatedSelling.netAmount - (oldSelling.netAmount || 0));
    if (vatDelta !== 0 || netDelta !== 0) await recordVatEvent({ kind: "sale_edit", direction: "output", sourceType: "sale", sourceId: updatedSelling._id, number: updatedSelling.number, date: today(), net: netDelta, vat: vatDelta, session });
  }
  await audit(req, { action: "sale.updated", entity: "Selling", entityId: selling._id, session, strict: true });
  return updatedSelling;
};

const updateSelling = asyncHandler(async (req, res) => {
  const updated = await withTransaction((session) => updateSellingInTransaction(req, res, session));
  res.json(toSellingInvoice(updated));
});

const cancelSelling = asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    res.status(400);
    throw new Error("سبب الإلغاء مطلوب ويجب أن يكون بين 3 و500 حرف");
  }
  const updated = await withTransaction(async (session) => {
    const selling = await Selling.findById(req.params.id).session(session);
    if (!selling) { const error = new Error("سجل البيع غير موجود"); error.statusCode = 404; throw error; }
    if (selling.status === "cancelled") {
      const error = new Error("الفاتورة ملغية بالفعل");
      error.statusCode = 409; error.responseData = { code: "ALREADY_CANCELLED" }; throw error;
    }
    for (const item of getSellingItems(selling)) {
      const returned = refundedForItem(selling, item._id);
      const quantity = Math.max(0, Number(item.quantity || 0) - returned);
      if (!quantity) continue;
      await Product.updateOne(
        { _id: getSellingItemProductId(item) },
        { $inc: { inventoryCount: quantity, soldItemCount: -quantity } },
        { session }
      );
    }
    selling.status = "cancelled";
    selling.cancelledAt = new Date();
    selling.cancelledBy = req.user?._id ?? req.user?.id;
    selling.cancelledByName = req.user?.name;
    selling.cancellationReason = reason;
    selling.cancelRefundAmount = roundMoney(Math.max(0, Number(selling.totalPrice || 0) - Number(selling.refundedAmount || 0)));
    // Stage 19: the customer is paid back (total - already returned) out of a box: the request's boxId, else this PC's
    // drawer, else the main box. Nothing to pay back (everything was returned) needs no box.
    const refundBox = selling.cancelRefundAmount > 0 ? await resolveBox({ req, boxId: req.body && req.body.boxId, session, direction: "out" }) : null;
    if (refundBox) selling.cancelRefundBoxId = refundBox._id;
    // Stage 21: a cancel gets its own vatPeriod (its own date), never the original month.
    const hasVat = selling.vatRate !== undefined && selling.vatRate !== null;
    if (hasVat) selling.cancelVatPeriod = await periodFor(today(), session);
    await selling.save({ session });
    await postInvoiceCancel({ Model: Selling, sale: selling, session, refundBoxId: refundBox ? refundBox._id : selling.boxId || null });
    if (hasVat) {
      const vatLeft = vatRound2((selling.vatAmount || 0) - (selling.vatReturnedAmount || 0));
      const netLeft = vatRound2(Number(selling.totalPrice || 0) - Number(selling.refundedAmount || 0) - vatLeft);
      if (vatLeft !== 0 || netLeft !== 0) await recordVatEvent({ kind: "sale_cancel", direction: "output", sourceType: "sale", sourceId: selling._id, number: selling.number, date: today(), net: -netLeft, vat: -vatLeft, session });
    }
    await audit(req, { action: "sale.cancelled", entity: "Selling", entityId: selling._id, details: { reason }, session, strict: true });
    return selling;
  });
  res.json(toSellingInvoice(updated));
});

const addSellingRefund = asyncHandler(async (req, res) => {
  const result = await withTransaction(async (session) => {
    const selling = await Selling.findById(req.params.id).session(session);
    if (!selling) { const error = new Error("سجل البيع غير موجود"); error.statusCode = 404; throw error; }
    if (selling.status === "cancelled") {
      const error = new Error("لا يمكن عمل مرتجع لفاتورة ملغية");
      error.statusCode = 409; error.responseData = { code: "CANCELLED" }; throw error;
    }
    if (selling.refundStatus === "full") {
      const error = new Error("تم إرجاع الفاتورة بالكامل بالفعل");
      error.statusCode = 409; error.responseData = { code: "FULLY_RETURNED" }; throw error;
    }

    const selections = normalizeRefundSelections(selling, req.body, res);
    const refundDate = new Date(req.body.returnDate ?? req.body.refundDate ?? Date.now());
    if (Number.isNaN(refundDate.getTime())) { res.status(400); throw new Error("تنسيق تاريخ المرتجع غير صالح"); }
    const note = req.body.note;
    if (note !== undefined && (typeof note !== "string" || note.trim().length > 1000)) { res.status(400); throw new Error("ملاحظة المرتجع غير صالحة"); }

    const productIds = [...new Set(selections.map(({ invoiceItem }) => getSellingItemProductId(invoiceItem).toString()))];
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) { res.status(404); throw new Error("تعذر العثور على أحد منتجات المرتجع"); }
    const productsById = new Map(products.map((product) => [product._id.toString(), product]));
    const refundItems = selections.map(({ invoiceItem, quantity, returnReason }) => {
      const unitPrice = roundMoney(invoiceItem.unitPrice || 0);
      const product = productsById.get(getSellingItemProductId(invoiceItem).toString());
      return { invoiceItemId: invoiceItem._id, product: getSellingItemProductId(invoiceItem), productName: invoiceItem.productName, purchasePrice: roundMoney(invoiceItem.purchasePrice || 0), quantity, unitPrice, totalPrice: roundMoney(unitPrice * quantity), returnReason };
    });
    const totalQuantity = refundItems.reduce((sum, item) => sum + item.quantity, 0);
    const subtotalReturnedAmount = roundMoney(refundItems.reduce((sum, item) => sum + item.totalPrice, 0));
    const previousRefundedQuantity = Number(selling.refundedQuantity || 0);
    const previousRefundedAmount = roundMoney(selling.refundedAmount || 0);
    const invoiceQuantity = Number(selling.totalQuantity ?? getSellingItems(selling).reduce((sum, item) => sum + Number(item.quantity || 0), 0));
    const isFull = previousRefundedQuantity + totalQuantity === invoiceQuantity;
    let finalReturnedAmount = isFull
      ? roundMoney(Math.max(0, Number(selling.totalPrice || 0) - previousRefundedAmount))
      : subtotalReturnedAmount;
    let discountAmount = roundMoney(Math.max(0, subtotalReturnedAmount - finalReturnedAmount));
    let shippingFees = roundMoney(Math.max(0, finalReturnedAmount - subtotalReturnedAmount));

    for (const { invoiceItem, quantity } of selections) {
      const productId = getSellingItemProductId(invoiceItem);
      await Product.updateOne(
        { _id: productId },
        { $inc: { inventoryCount: quantity, soldItemCount: -quantity } },
        { session }
      );
      const storedItem = selling.items?.id(invoiceItem._id);
      if (storedItem) storedItem.returnedQuantity = Number(storedItem.returnedQuantity || 0) + quantity;
    }

    // Stage 21: an invoice with VAT gives back its VAT share (cumulative proportion by taxable value; the final return takes
    // what is left). With prices excluding VAT the VAT is added on top of the refund; with prices including VAT it is inside it.
    let vatReturn = null;
    if (selling.vatRate !== undefined && selling.vatRate !== null) {
      const included = selling.vatIncluded !== false;
      const share = computeReturnVat({
        invoice: { vatAmount: selling.vatAmount, shippingVat: selling.shippingVat, vatReturnedAmount: selling.vatReturnedAmount, items: (selling.items || []).map((item) => ({ unitPrice: item.unitPrice, quantity: item.quantity, returnedQuantity: item.returnedQuantity, vatExempt: item.vatExempt })) },
        isFull,
      });
      const onTop = included ? 0 : share.vatAmount;
      const base = isFull ? roundMoney(Math.max(0, Number(selling.totalPrice || 0) - previousRefundedAmount - onTop)) : subtotalReturnedAmount;
      finalReturnedAmount = roundMoney(base + onTop);
      discountAmount = roundMoney(Math.max(0, subtotalReturnedAmount - base));
      shippingFees = roundMoney(Math.max(0, base - subtotalReturnedAmount));
      const taxableLines = roundMoney(selections.reduce((sum, { invoiceItem, quantity }) => sum + (invoiceItem.vatExempt ? 0 : roundMoney(invoiceItem.unitPrice * quantity)), 0));
      vatReturn = {
        vatAmount: share.vatAmount,
        vatPeriod: await periodFor(refundDate, session),
        vatBreakdown: computeReturnBreakdown({ invoice: selling, linesValue: subtotalReturnedAmount, taxableLinesValue: taxableLines, shippingReturned: isFull ? roundMoney(selling.shippingFees || 0) : 0, shippingVat: share.vatShipping, baseRefund: base }),
      };
    }

    // Stage 19: the cash refund comes out of a box (request boxId, else this PC's drawer, else the main box).
    const refundBox = await resolveBox({ req, boxId: req.body && req.body.boxId, session, direction: "out" });
    const number = await nextDocumentNumber(PREFIXES.RETURN, session);
    const returnLog = await createReturnLog({
      number, returnType: "cash", invoiceId: selling._id, invoiceNumber: selling.number,
      customerName: selling.customerName, customerPhone: selling.customerPhone,
      returnDate: refundDate, note: note?.trim() || undefined,
      items: refundItems.map((item) => ({ invoiceItemId: item.invoiceItemId, productId: item.product, productName: item.productName, productCode: productsById.get(item.product.toString()).code, purchasePrice: item.purchasePrice, quantity: item.quantity, price: item.unitPrice, total: item.totalPrice, returnReason: item.returnReason })),
      subtotalReturnedAmount, discountAmount, shippingFees, finalReturnedAmount,
      boxId: refundBox._id,
      createdBy: req.user?._id ?? req.user?.id,
      ...(vatReturn || {}),
    }, session);
    if (vatReturn) selling.vatReturnedAmount = roundMoney(Number(selling.vatReturnedAmount || 0) + vatReturn.vatAmount);
    selling.refunds.push({ refundDate, note: note?.trim() || undefined, items: refundItems, totalQuantity, totalAmount: finalReturnedAmount, returnLog: returnLog._id });
    selling.refundedQuantity = previousRefundedQuantity + totalQuantity;
    selling.refundedAmount = roundMoney(previousRefundedAmount + finalReturnedAmount);
    selling.refundStatus = isFull ? "full" : "partial";
    await selling.save({ session });
    await postReturn({ returnLog, sale: selling, session });
    if (vatReturn) await recordVatEvent({ kind: "sale_return", direction: "output", sourceType: "return", sourceId: returnLog._id, number, date: refundDate, net: -roundMoney(finalReturnedAmount - vatReturn.vatAmount), vat: -vatReturn.vatAmount, session });
    await audit(req, { action: "sale.returned", entity: "Selling", entityId: selling._id, details: { number, amount: finalReturnedAmount }, session, strict: true });
    return { selling, returnLog };
  });

  await result.selling.populate("items.product", "code");
  await result.selling.populate("product", "code");
  await result.selling.populate("refunds.items.product", "code");
  res.status(201).json({
    success: true,
    data: {
      invoice: toSellingInvoice(result.selling, {
        includeProductCode: true,
      }),
      returnLog: result.returnLog,
    },
  });
});

module.exports = {
  createSellingInvoice,
  createSelling,
  getSellings,
  getSellingById,
  updateSelling,
  addSellingRefund,
  cancelSelling,
  toSellingInvoice,
};
