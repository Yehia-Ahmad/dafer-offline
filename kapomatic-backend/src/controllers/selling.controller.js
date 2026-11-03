const mongoose = require("mongoose");
const Customer = require("../models/customer.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const ShippingSetting = require("../models/shippingSetting.model");
const ReturnLog = require("../models/returnLog.model");
const WebsiteOrder = require("../models/websiteOrder.model");
const asyncHandler = require("../utils/asyncHandler");
const { createReturnLog } = require("../services/returns.service");
const { notifyNewWebsiteOrder } = require("../services/pushNotification.service");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { buildPaginatedResponse, getPaginationParams } = require("../utils/pagination");
const { normalizeCheckoutPayment } = require("../utils/orderPayment");

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

  return [
    {
      productId,
      quantity,
      unitPrice,
    },
  ];
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
    totalPrice: item.totalPrice,
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
    invoiceId: getInvoiceIdentifier(selling),
    customerName: selling.customerName,
    customerPhone: selling.customerPhone ?? null,
    shippingLocation: selling.shippingLocation ?? null,
    government: selling.government ?? null,
    sellingDate: selling.sellingDate,
    itemCount: items.length,
    totalQuantity: options.excludeRefundedItems
      ? totals.totalQuantity
      : selling.totalQuantity ?? totals.totalQuantity,
    discountAmount: totals.discountAmount,
    shippingFees: selling.shippingFees ?? totals.shippingFees,
    totalPrice: options.excludeRefundedItems ? totals.totalPrice : selling.totalPrice ?? totals.totalPrice,
    totalProfit: roundMoney(
      items.reduce((sum, item) => sum + Number(item.profitAmount || 0), 0) - totals.discountAmount
    ),
    refundStatus: selling.refundStatus ?? "none",
    refundedQuantity: selling.refundedQuantity ?? 0,
    refundedAmount: selling.refundedAmount ?? 0,
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

const ensureCustomerExistsForSelling = async ({ customerName, customerPhone }) => {
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
  });

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

  const products = await Product.find({ _id: { $in: allProductIds } }).populate("category", "name");
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

    if (unitPrice < purchasePrice) {
      res.status(400);
      throw new Error(`سعر البيع لا يمكن أن يكون أقل من سعر الشراء للمنتج ${product.name}`);
    }
  }

  try {
    for (const productId of allProductIds) {
      const product = productsById.get(productId);
      if (!product) continue;

      const originalState = originalStates.get(productId);
      const currentQuantity = Number(currentQuantityByProductId.get(productId) || 0);
      const nextQuantity = Number(nextQuantityByProductId.get(productId) || 0);
      const autoRestockedQuantity = Number(autoRestockedByProductId.get(productId) || 0);
      const inventoryAdjustment = Number(inventoryAdjustmentsByProductId.get(productId) || 0);

      product.inventoryCount =
        originalState.inventoryCount +
        currentQuantity -
        nextQuantity +
        autoRestockedQuantity +
        inventoryAdjustment;
      product.soldItemCount = Math.max(
        0,
        originalState.soldItemCount - currentQuantity + nextQuantity
      );
      await product.save();
    }
  } catch (error) {
    for (const productId of allProductIds) {
      const product = productsById.get(productId);
      const originalState = originalStates.get(productId);
      if (!product || !originalState) continue;

      product.inventoryCount = originalState.inventoryCount;
      product.soldItemCount = originalState.soldItemCount;

      try {
        await product.save();
      } catch (_saveError) {
        // Best-effort rollback only; surface the original failure.
      }
    }

    throw error;
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

const createSellingInvoice = async ({ body, res, options = {} }) => {
  const { customerName, customerPhone } = body;
  const normalizedCustomerName = normalizeRequiredString(customerName, "اسم العميل", res);
  const normalizedCustomerPhone = normalizeRequiredString(customerPhone, "رقم هاتف العميل", res);
  const normalizedShippingLocation = options.requireShippingLocation
    ? normalizeRequiredString(body.shippingLocation, "عنوان الشحن", res)
    : normalizeOptionalString(body.shippingLocation, "عنوان الشحن", res);
  const normalizedGovernment = options.requireGovernment
    ? normalizeRequiredString(body.government, "المحافظة", res)
    : normalizeOptionalString(body.government, "المحافظة", res);
  const normalizedSellingDate =
    body.sellingDate === undefined && options.defaultSellingDate
      ? options.defaultSellingDate
      : normalizeSellingDate(body.sellingDate, res);
  const items = normalizeSellingItems(body, res, {
    defaultQuantity: options.defaultQuantity,
  });
  const invoicePricing = resolveInvoicePricing(body, {}, res);

  await ensureCustomerExistsForSelling({
    customerName: normalizedCustomerName,
    customerPhone: normalizedCustomerPhone,
  });

  const productsById = await applyInventoryForInvoiceChange({
    currentItems: [],
    nextItems: items,
    res,
    allowInsufficientInventory: body.confirmInsufficientInventory === true,
  });
  const persistedItems = buildPersistedItems(items, productsById);
  const invoiceTotals = buildInvoiceTotals(persistedItems, invoicePricing);
  let selling;

  try {
    selling = await Selling.create({
      customerName: normalizedCustomerName,
      customerPhone: normalizedCustomerPhone,
      shippingLocation: normalizedShippingLocation,
      government: normalizedGovernment,
      sellingDate: normalizedSellingDate,
      items: persistedItems,
      totalQuantity: invoiceTotals.totalQuantity,
      discountAmount: invoiceTotals.discountAmount,
      shippingFees: invoiceTotals.shippingFees,
      totalPrice: invoiceTotals.totalPrice,
    });
  } catch (error) {
    try {
      await applyInventoryForInvoiceChange({
        currentItems: items,
        nextItems: [],
        res,
        inventoryAdjustmentsByProductId: new Map(
          [...productsById.autoRestockedByProductId.entries()].map(
            ([productId, quantity]) => [productId, -quantity]
          )
        ),
      });
    } catch (_rollbackError) {
      // Best-effort rollback only; surface the create failure.
    }

    throw error;
  }

  return selling;
};

const normalizeCartCheckoutItems = (products, res) => {
  if (!Array.isArray(products)) {
    res.status(400);
    throw new Error("يجب أن تكون products مصفوفة");
  }

  if (products.length === 0) {
    res.status(400);
    throw new Error("يجب أن تحتوي products على منتج واحد على الأقل");
  }

  return products.map((product, index) => {
    const itemNumber = index + 1;
    if (!product || typeof product !== "object" || Array.isArray(product)) {
      res.status(400);
      throw new Error(`المنتج رقم ${itemNumber} غير صالح`);
    }

    return {
      productId: product.productId ?? product.id ?? product._id,
      price: product.price,
      quantity: product.quantity ?? product.quentity,
    };
  });
};

const buildWebsiteOrderItems = async (items, res) => {
  const productIds = [...new Set(items.map((item) => item.productId.toString()))];
  const products = await Product.find({ _id: { $in: productIds } }).populate("category", "name");
  const productsById = new Map(products.map((product) => [product._id.toString(), product]));

  if (products.length !== productIds.length) {
    res.status(404);
    throw new Error("تعذر العثور على أحد منتجات طلب الموقع");
  }

  return items.map((item) => {
    const product = productsById.get(item.productId.toString());
    const unitPrice = roundMoney(item.unitPrice);
    const quantity = Number(item.quantity);

    return {
      product: product._id,
      productName: product.name,
      productCode: product.code,
      categoryName: product.category?.name ?? "Uncategorized",
      quantity,
      unitPrice,
      totalPrice: roundMoney(unitPrice * quantity),
    };
  });
};

const createSelling = asyncHandler(async (req, res) => {
  const selling = await createSellingInvoice({
    body: req.body,
    res,
  });

  res.status(201).json(toSellingInvoice(selling));
});

const checkoutCart = asyncHandler(async (req, res) => {
  const government = normalizeRequiredString(
    req.body.government ?? req.body.governorate,
    "المحافظة",
    res
  );
  const shippingSetting = await ShippingSetting.findOne({ key: "default" }).lean();
  const governmentFee = shippingSetting?.governmentFees?.find(
    (item) => item.government.trim().toLowerCase() === government.toLowerCase()
  );

  if (!governmentFee) {
    res.status(400);
    throw new Error("المحافظة المحددة غير موجودة في إعدادات مصاريف الشحن");
  }

  const cartItems =
    req.body.products !== undefined
      ? normalizeCartCheckoutItems(req.body.products, res)
      : req.body.items;
  const normalizedCartItems = normalizeSellingItems(
    { items: cartItems },
    res,
    { defaultQuantity: 1 }
  );
  const cartSubtotal = roundMoney(
    normalizedCartItems.reduce(
      (total, item) => total + item.unitPrice * item.quantity,
      0
    )
  );
  const freeShippingMinimumAmount = Number(
    shippingSetting.freeShippingMinimumAmount || 0
  );
  const qualifiesForFreeShipping =
    freeShippingMinimumAmount > 0 && cartSubtotal >= freeShippingMinimumAmount;

  const normalizedCustomerName = normalizeRequiredString(req.body.customerName, "اسم العميل", res);
  const normalizedCustomerPhone = normalizeRequiredString(req.body.customerPhone, "رقم هاتف العميل", res);
  const normalizedShippingLocation = normalizeRequiredString(
    req.body.shippingLocation,
    "عنوان الشحن",
    res
  );
  const payment = normalizeCheckoutPayment(req.body, res);
  const orderItems = await buildWebsiteOrderItems(normalizedCartItems, res);
  const orderSubtotal = roundMoney(
    orderItems.reduce((total, item) => total + Number(item.totalPrice || 0), 0)
  );
  const shippingFees = qualifiesForFreeShipping ? 0 : governmentFee.shippingFees;
  const order = await WebsiteOrder.create({
    customerName: normalizedCustomerName,
    customerPhone: normalizedCustomerPhone,
    shippingLocation: normalizedShippingLocation,
    government: governmentFee.government,
    orderDate:
      req.body.sellingDate === undefined
        ? new Date()
        : normalizeSellingDate(req.body.sellingDate, res),
    items: orderItems,
    totalQuantity: orderItems.reduce((total, item) => total + Number(item.quantity || 0), 0),
    discountAmount: 0,
    shippingFees,
    totalPrice: roundMoney(orderSubtotal + Number(shippingFees || 0)),
    ...payment,
  });

  res.status(201).json({
    _id: order._id,
    orderId: order._id,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    shippingLocation: order.shippingLocation,
    government: order.government,
    orderDate: order.orderDate,
    itemCount: order.items.length,
    totalQuantity: order.totalQuantity,
    discountAmount: order.discountAmount,
    shippingFees: order.shippingFees,
    totalPrice: order.totalPrice,
    status: order.status,
    payment: {
      method: order.paymentMethod,
      status: order.paymentStatus,
      transferPhone: order.transferPhone ?? null,
      transferImage: order.transferImage ?? null,
      reference: order.paymentReference ?? null,
      notes: order.paymentNotes ?? null,
    },
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    transferPhone: order.transferPhone ?? null,
    transferImage: order.transferImage ?? null,
    paymentReference: order.paymentReference ?? null,
    paymentNotes: order.paymentNotes ?? null,
    items: order.items.map((item) => ({
      _id: item._id,
      productId: item.product,
      productName: item.productName,
      productCode: item.productCode ?? null,
      categoryName: item.categoryName ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
    })),
  });

  // Fire-and-forget: the push service never throws, and runs after the response is sent.
  setImmediate(() => notifyNewWebsiteOrder(order));
});

const getSellings = asyncHandler(async (req, res) => {
  const { categoryId, productId, customerName, customerPhone, sellingDate } = req.query;
  const sellingQuery = { refundStatus: { $ne: "full" } };
  const { page, limit, skip } = getPaginationParams(req.query);

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
      data: sellings.map((selling) =>
        toSellingInvoice(selling, {
          includeProductCode: true,
          excludeRefundedItems: true,
        })
      ),
      page,
      limit,
      totalItems,
    })
  );
});

const getSellingById = asyncHandler(async (req, res) => {
  const selling = await Selling.findById(req.params.id)
    .populate("items.product", "code")
    .populate("product", "code")
    .populate("refunds.items.product", "code");

  if (!selling) {
    res.status(404);
    throw new Error("سجل البيع غير موجود");
  }

  if (selling.refundStatus === "full") {
    res.status(404);
    throw new Error("سجل البيع غير موجود");
  }

  res.json(
    toSellingInvoice(selling, {
      includeProductCode: true,
      excludeRefundedItems: true,
    })
  );
});

const updateSelling = asyncHandler(async (req, res) => {
  const selling = await Selling.findById(req.params.id);

  if (!selling) {
    res.status(404);
    throw new Error("سجل البيع غير موجود");
  }

  const normalizedCustomerName =
    req.body.customerName !== undefined
      ? normalizeRequiredString(req.body.customerName, "اسم العميل", res)
      : selling.customerName;
  const normalizedCustomerPhone =
    req.body.customerPhone !== undefined
      ? normalizeRequiredString(req.body.customerPhone, "رقم هاتف العميل", res)
      : selling.customerPhone;
  const normalizedShippingLocation =
    req.body.shippingLocation !== undefined
      ? normalizeOptionalString(req.body.shippingLocation, "عنوان الشحن", res)
      : selling.shippingLocation;
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

  if (shouldUpdateItems) {
    if (req.body.items === undefined && currentItems.length !== 1) {
      res.status(400);
      throw new Error("يجب إرسال items لتعديل فاتورة تحتوي على أكثر من عنصر واحد");
    }

    if (req.body.items !== undefined) {
      nextItems = normalizeSellingItems(req.body, res);
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
        res
      );
    }

    productsById = await applyInventoryForInvoiceChange({
      currentItems,
      nextItems,
      res,
    });
  }

  await ensureCustomerExistsForSelling({
    customerName: normalizedCustomerName,
    customerPhone: normalizedCustomerPhone,
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
    selling.totalPrice = invoiceTotals.totalPrice;
  }

  selling.customerName = normalizedCustomerName;
  selling.customerPhone = normalizedCustomerPhone;
  selling.shippingLocation = normalizedShippingLocation;
  selling.sellingDate = normalizedSellingDate;

  let updatedSelling;
  try {
    updatedSelling = await selling.save();
  } catch (error) {
    if (shouldUpdateItems) {
      try {
        await applyInventoryForInvoiceChange({
          currentItems: nextItems,
          nextItems: currentItems,
          res,
        });
      } catch (_rollbackError) {
        // Best-effort rollback only; surface the update failure.
      }
    }

    throw error;
  }

  res.json(toSellingInvoice(updatedSelling));
});

const deleteSelling = asyncHandler(async (req, res) => {
  const selling = await Selling.findById(req.params.id);

  if (!selling) {
    res.status(404);
    throw new Error("سجل البيع غير موجود");
  }

  await selling.deleteOne();
  res.json({ message: "Selling invoice deleted successfully" });
});

const addSellingRefund = asyncHandler(async (req, res) => {
  const selling = await Selling.findById(req.params.id);
  if (!selling) { res.status(404); throw new Error("سجل البيع غير موجود"); }

  const selections = normalizeRefundSelections(selling, req.body, res);
  const refundDate = new Date(req.body.returnDate ?? req.body.refundDate ?? Date.now());
  if (Number.isNaN(refundDate.getTime())) { res.status(400); throw new Error("تنسيق تاريخ المرتجع غير صالح"); }
  const note = req.body.note;
  if (note !== undefined && (typeof note !== "string" || note.trim().length > 1000)) { res.status(400); throw new Error("ملاحظة المرتجع غير صالحة"); }

  const productIds = [...new Set(selections.map(({ invoiceItem }) => getSellingItemProductId(invoiceItem).toString()))];
  const products = await Product.find({ _id: { $in: productIds } });
  if (products.length !== productIds.length) { res.status(404); throw new Error("تعذر العثور على أحد منتجات المرتجع"); }
  const productsById = new Map(products.map((product) => [product._id.toString(), product]));
  const snapshots = products.map((product) => ({ product, inventoryCount: Number(product.inventoryCount || 0), soldItemCount: Number(product.soldItemCount || 0) }));
  const refundItems = selections.map(({ invoiceItem, quantity, returnReason }) => {
    const unitPrice = roundMoney(invoiceItem.unitPrice || 0);
    return { invoiceItemId: invoiceItem._id, product: getSellingItemProductId(invoiceItem), productName: invoiceItem.productName, quantity, unitPrice, totalPrice: roundMoney(unitPrice * quantity), returnReason };
  });
  const totalQuantity = refundItems.reduce((sum, item) => sum + item.quantity, 0);
  const subtotalReturnedAmount = roundMoney(refundItems.reduce((sum, item) => sum + item.totalPrice, 0));
  const originalInvoiceTotals = buildInvoiceTotals(getSellingItems(selling), {
    discountAmount: selling.discountAmount,
    discountPercentage: selling.discountPercentage,
    shippingFees: selling.shippingFees,
  });
  const invoiceQuantity = Number(selling.totalQuantity ?? originalInvoiceTotals.totalQuantity);
  const previousRefundedQuantity = (selling.refunds || []).reduce(
    (sum, refund) => sum + Number(refund.totalQuantity || 0),
    0
  );
  const previousRefundedAmount = (selling.refunds || []).reduce(
    (sum, refund) => sum + Number(refund.totalAmount || 0),
    0
  );
  const isFull = previousRefundedQuantity + totalQuantity === invoiceQuantity;
  const discountAmount = isFull ? originalInvoiceTotals.discountAmount : 0;
  const shippingFees = isFull ? originalInvoiceTotals.shippingFees : 0;
  const finalReturnedAmount = roundMoney(Math.max(0, subtotalReturnedAmount - discountAmount + shippingFees));
  let returnLog;

  try {
    for (const { invoiceItem, quantity } of selections) {
      const product = productsById.get(getSellingItemProductId(invoiceItem).toString());
      product.inventoryCount = Number(product.inventoryCount || 0) + quantity;
      product.soldItemCount = Math.max(0, Number(product.soldItemCount || 0) - quantity);
    }
    for (const product of products) await product.save();

    returnLog = await createReturnLog({
      returnType: "cash", invoiceId: selling._id, invoiceNumber: selling.invoiceId?.toString(),
      customerName: selling.customerName, customerPhone: selling.customerPhone,
      returnDate: refundDate, note: note?.trim() || undefined,
      items: refundItems.map((item) => ({ productId: item.product, productName: item.productName, productCode: productsById.get(item.product.toString()).code, quantity: item.quantity, price: item.unitPrice, total: item.totalPrice, returnReason: item.returnReason })),
      subtotalReturnedAmount, discountAmount, shippingFees, finalReturnedAmount,
      createdBy: req.user?._id ?? req.user?.id,
    });
    selling.refunds.push({ refundDate, note: note?.trim() || undefined, items: refundItems, totalQuantity, totalAmount: finalReturnedAmount, returnLog: returnLog._id });
    selling.refundedQuantity = previousRefundedQuantity + totalQuantity;
    selling.refundedAmount = roundMoney(previousRefundedAmount + finalReturnedAmount);
    selling.refundStatus = isFull ? "full" : "partial";
    await selling.save();
    await WebsiteOrder.updateOne(
      { selling: selling._id, status: "accepted" },
      {
        status: "refunded",
        refundedAt: new Date(),
        refundReason: note?.trim() || "Refunded from selling invoice",
      }
    );
    if (isFull) {
      await selling.deleteOne();
    }
  } catch (error) {
    if (returnLog) { try { await ReturnLog.deleteOne({ _id: returnLog._id }); } catch (_rollbackError) {} }
    for (const snapshot of snapshots) {
      snapshot.product.inventoryCount = snapshot.inventoryCount;
      snapshot.product.soldItemCount = snapshot.soldItemCount;
      try { await snapshot.product.save(); } catch (_rollbackError) {}
    }
    throw error;
  }

  if (isFull) {
    return res.status(201).json({
      success: true,
      data: {
        deletedInvoiceId: selling._id,
        returnLog,
      },
    });
  }

  await selling.populate("items.product", "code");
  await selling.populate("product", "code");
  await selling.populate("refunds.items.product", "code");
  res.status(201).json({
    success: true,
    data: {
      invoice: toSellingInvoice(selling, {
        includeProductCode: true,
        excludeRefundedItems: true,
      }),
      returnLog,
    },
  });
});

module.exports = {
  checkoutCart,
  createSellingInvoice,
  createSelling,
  getSellings,
  getSellingById,
  updateSelling,
  addSellingRefund,
  deleteSelling,
  toSellingInvoice,
};
