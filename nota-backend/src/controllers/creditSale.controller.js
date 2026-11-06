const mongoose = require("mongoose");
const CreditSale = require("../models/creditSale.model");
const Customer = require("../models/customer.model");
const Product = require("../models/product.model");
const ReturnLog = require("../models/returnLog.model");
const asyncHandler = require("../utils/asyncHandler");
const { createReturnLog } = require("../services/returns.service");
const { toCreditSaleInvoice } = require("../utils/creditSaleFormatter");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { buildPaginatedResponse, getPaginationParams } = require("../utils/pagination");
const { canSellBelowCost } = require("../auth/middleware");
const { PREFIXES, normalizeNumberSearch } = require("../utils/documentNumber");
const { withTransaction } = require("../utils/transaction");
const { postSale, postReceipt, postReturn, postInvoiceEdit, postInvoiceCancel, postEntry, accountMap, line } = require("../accounting/posting");
const { audit } = require("../auth/audit");
const Receipt = require("../models/receipt.model");
const PartyOpening = require("../models/partyOpening.model");
const { openingRemaining } = require("../services/customerOpenItems.service");
const { nextDocumentNumber } = require("../utils/documentNumber");

const REACTIONARY_CREDIT_SALE_STATUS = "returned";
const CREDIT_SALE_STATUSES = new Set([
  "pending",
  "partially_paid",
  "paid",
  REACTIONARY_CREDIT_SALE_STATUS,
  "cancelled",
]);
const OPEN_CREDIT_SALE_STATUSES = ["pending", "partially_paid"];
const MONEY_EPSILON = 1e-9;

const getFirstDefined = (...values) => values.find((value) => value !== undefined);

const resolveItemPurchasePrice = (item, product) => {
  const rawPurchasePrice =
    item.purchasePrice !== undefined
      ? item.purchasePrice
      : product?.purchasePrice ?? product?.wholesalePrice ?? 0;
  const purchasePrice = Number(rawPurchasePrice);

  return Number.isFinite(purchasePrice) ? roundMoney(Math.max(0, purchasePrice)) : 0;
};

const getRawQuantity = (body) => {
  if (body.quantity !== undefined) return body.quantity;
  if (body.quentity !== undefined) return body.quentity;
  return undefined;
};

const normalizeRequiredString = (value, fieldLabel, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} مطلوب`);
  }

  return value.trim();
};

const normalizeOptionalString = (value, fieldLabel, res) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    res.status(400);
    throw new Error(`${fieldLabel} غير صالح`);
  }

  const normalizedValue = value.trim();
  return normalizedValue || undefined;
};

const normalizeRequiredDate = (value, fieldLabel, res) => {
  if (value === undefined || value === null || value === "") {
    res.status(400);
    throw new Error(`${fieldLabel} مطلوب`);
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    res.status(400);
    throw new Error(`تنسيق ${fieldLabel} غير صالح`);
  }

  return parsedDate;
};

const normalizeOptionalDate = (value, fieldLabel, res) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    res.status(400);
    throw new Error(`تنسيق ${fieldLabel} غير صالح`);
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

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
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

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "true" || normalizedValue === "1") return true;
    if (normalizedValue === "false" || normalizedValue === "0") return false;
  }

  return null;
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

const getCreditSaleItemProductId = (item) => {
  if (
    item.product &&
    typeof item.product === "object" &&
    item.product._id !== undefined
  ) {
    return item.product._id;
  }

  return item.product;
};

const normalizeCreditSaleItems = (body, res) => {
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
      const rawQuantity = getRawQuantity(item);

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
  const rawQuantity = getRawQuantity(body);

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

const ensureDueDateIsValid = (sellingDate, dueDate, res) => {
  if (dueDate && dueDate < sellingDate) {
    res.status(400);
    throw new Error("تاريخ الاستحقاق يجب أن يكون في نفس تاريخ البيع أو بعده");
  }
};

const ensureCustomerExistsForCreditSale = async ({
  customerId,
  customerName,
  customerPhone,
  res,
  session,
}) => {
  if (customerId !== undefined && customerId !== null) {
    if (typeof customerId !== "string" || !customerId.trim()) {
      res.status(400);
      throw new Error("تنسيق معرّف العميل غير صالح");
    }

    const normalizedCustomerId = customerId.trim();

    if (!mongoose.Types.ObjectId.isValid(normalizedCustomerId)) {
      res.status(400);
      throw new Error("تنسيق معرّف العميل غير صالح");
    }

    const customer = await Customer.findById(normalizedCustomerId).session(session || null);
    if (!customer) {
      res.status(404);
      throw new Error("العميل غير موجود");
    }

    return customer;
  }

  const normalizedCustomerName = normalizeRequiredString(customerName, "اسم العميل", res);
  const normalizedCustomerPhone = normalizeRequiredString(customerPhone, "رقم هاتف العميل", res);
  const existingCustomer = await Customer.findOne({
    name: normalizedCustomerName,
    phone: normalizedCustomerPhone,
  }).session(session || null);

  if (existingCustomer) {
    return existingCustomer;
  }

  return Customer.findOneAndUpdate(
    { phone: normalizedCustomerPhone },
    {
      $set: { name: normalizedCustomerName },
      $setOnInsert: { phone: normalizedCustomerPhone },
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

const toCreditSaleItemInput = (item) => ({
  productId: getCreditSaleItemProductId(item)?.toString(),
  quantity: Number(item.quantity),
  unitPrice: Number(item.unitPrice),
  purchasePrice: Number(item.purchasePrice ?? 0),
});

const getCreditSaleItemInputs = (creditSale) =>
  Array.isArray(creditSale.items)
    ? creditSale.items.map(toCreditSaleItemInput).filter((item) => item.productId)
    : [];

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

// Stage 13: allowBelowCost is true on create/edit only with NOTA_AUTH=1 for a user with
// sales.priceBelowCost, and always on returns (they keep the original prices).
const applyInventoryForInvoiceChange = async ({ currentItems, nextItems, res, allowBelowCost = false, session }) => {
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

  for (const [productId, nextQuantity] of nextQuantityByProductId.entries()) {
    const product = productsById.get(productId);
    if (!product) {
      res.status(404);
      throw new Error("المنتج غير موجود");
    }

    const currentQuantity = Number(currentQuantityByProductId.get(productId) || 0);
    const availableQuantity = Number(product.inventoryCount || 0) + currentQuantity;
    if (availableQuantity < nextQuantity) {
      res.status(400);
      throw new Error(`المخزون غير كافٍ للمنتج ${product.name}`);
    }
  }

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

      const inventoryDelta = currentQuantity - nextQuantity;
      const soldDelta = nextQuantity - currentQuantity;
      const filter = { _id: product._id };
      if (inventoryDelta < 0) filter.inventoryCount = { $gte: -inventoryDelta };
      const result = await Product.updateOne(filter, { $inc: { inventoryCount: inventoryDelta, soldItemCount: soldDelta } }, { session });
      if (result.matchedCount === 0) {
        const stockError = new Error("المخزون غير كافٍ للمنتج");
        stockError.statusCode = 400;
        throw stockError;
      }
      product.inventoryCount = originalState.inventoryCount + inventoryDelta;
      product.soldItemCount = Math.max(0, originalState.soldItemCount + soldDelta);
  }

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

const buildRefundTotals = (items) => ({
  totalQuantity: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
  totalAmount: items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0),
});

const buildRefundHistoryTotals = (refunds = []) =>
  refunds.reduce(
    (totals, refund) => {
      totals.refundedQuantity += Number(refund.totalQuantity || 0);
      totals.refundedAmount += Number(refund.totalAmount || 0);
      return totals;
    },
    {
      refundedQuantity: 0,
      refundedAmount: 0,
    }
  );

const getRefundStatus = (refunds = [], originalTotalQuantity = 0) => {
  if (!Array.isArray(refunds) || refunds.length === 0) {
    return "none";
  }
  const refundedQuantity = refunds.reduce((sum, refund) => sum + Number(refund.totalQuantity || 0), 0);
  return refundedQuantity >= Number(originalTotalQuantity || 0) ? "full" : "partial";
};

const getTotalPaymentsAmount = (payments = []) =>
  roundMoney(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));

const getTotalReleasedPaidAmount = (returnedPaidAmount = 0, reallocatedPaidAmount = 0) =>
  roundMoney(Number(returnedPaidAmount || 0) + Number(reallocatedPaidAmount || 0));

const calculateCreditAmounts = (
  totalPrice,
  payments = [],
  returnedPaidAmount = 0,
  reallocatedPaidAmount = 0
) => {
  const normalizedTotalPrice = roundMoney(totalPrice);
  const grossPaidAmount = getTotalPaymentsAmount(payments);
  const normalizedReturnedPaidAmount = roundMoney(returnedPaidAmount);
  const normalizedReallocatedPaidAmount = roundMoney(reallocatedPaidAmount);
  const normalizedReleasedPaidAmount = getTotalReleasedPaidAmount(
    normalizedReturnedPaidAmount,
    normalizedReallocatedPaidAmount
  );

  if (normalizedReleasedPaidAmount - grossPaidAmount > MONEY_EPSILON) {
    return null;
  }

  const paidAmount = roundMoney(
    Math.max(0, grossPaidAmount - normalizedReleasedPaidAmount)
  );
  const remainingAmount = roundMoney(Math.max(0, normalizedTotalPrice - paidAmount));
  const refundDueAmount = roundMoney(Math.max(0, paidAmount - normalizedTotalPrice));
  const status =
    remainingAmount === 0 ? "paid" : paidAmount > 0 ? "partially_paid" : "pending";

  return {
    paidAmount,
    remainingAmount,
    refundDueAmount,
    status,
  };
};

const applyCreditAmountsToInvoice = (creditSale, creditAmounts, statusOverride) => {
  creditSale.paidAmount = creditAmounts.paidAmount;
  creditSale.remainingAmount = creditAmounts.remainingAmount;
  creditSale.refundDueAmount = creditAmounts.refundDueAmount;
  creditSale.status = statusOverride ?? creditAmounts.status;
};

const buildRefundReallocationPaymentNote = (sourceCreditSale, refundNote) => {
  const baseNote = `تسوية تلقائية من مرتجع الفاتورة ${sourceCreditSale._id}`;

  if (!refundNote) {
    return baseNote;
  }

  const normalizedRefundNote = refundNote.trim();
  if (!normalizedRefundNote) {
    return baseNote;
  }

  return `${baseNote} - ${normalizedRefundNote}`.slice(0, 500);
};

const reallocateRefundCreditToOtherInvoices = async ({
  sourceCreditSale,
  refundDate,
  refundNote,
  availableCredit,
  returnNumber,
  session,
}) => {
  const normalizedAvailableCredit = roundMoney(availableCredit);
  if (normalizedAvailableCredit <= MONEY_EPSILON) {
    return {
      reallocatedPaidAmount: 0,
      returnedPaidAmount: 0,
      updatedInvoices: [],
    };
  }

  const updatedInvoices = [];
  let remainingCredit = normalizedAvailableCredit;
  const paymentNote = buildRefundReallocationPaymentNote(sourceCreditSale, refundNote);

  const targetCreditSales = await CreditSale.find({
      customer: sourceCreditSale.customer,
      _id: { $ne: sourceCreditSale._id },
      remainingAmount: { $gt: 0 },
      status: { $in: OPEN_CREDIT_SALE_STATUSES },
    }).sort({ sellingDate: 1, createdAt: 1, _id: 1 }).session(session);

    for (const targetCreditSale of targetCreditSales) {
      if (remainingCredit <= MONEY_EPSILON) {
        break;
      }

      const payableAmount = roundMoney(
        Math.min(remainingCredit, Number(targetCreditSale.remainingAmount || 0))
      );
      if (payableAmount <= MONEY_EPSILON) {
        continue;
      }

      targetCreditSale.payments.push({
        amount: payableAmount,
        paymentDate: refundDate,
        note: paymentNote,
        number: returnNumber,
        source: "return_reallocation",
      });

      const creditAmounts = calculateCreditAmounts(
        roundMoney(Number(targetCreditSale.totalPrice || 0) - Number(targetCreditSale.refundedAmount || 0)),
        targetCreditSale.payments,
        targetCreditSale.returnedPaidAmount,
        targetCreditSale.reallocatedPaidAmount
      );

      if (!creditAmounts) {
        throw new Error("تعذر إعادة توزيع الرصيد على فاتورة لاحقة");
      }

      if (creditAmounts.refundDueAmount > MONEY_EPSILON) {
        throw new Error("قيمة إعادة التوزيع تجاوزت المبلغ المتبقي في إحدى الفواتير");
      }

      applyCreditAmountsToInvoice(targetCreditSale, creditAmounts);
      await targetCreditSale.save({ session });

      updatedInvoices.push(targetCreditSale);
      remainingCredit = roundMoney(remainingCredit - payableAmount);
  }

  return {
    reallocatedPaidAmount: roundMoney(normalizedAvailableCredit - remainingCredit),
    returnedPaidAmount: remainingCredit,
    updatedInvoices,
  };
};

const validateCreateOnlyFields = (body, res) => {
  if (
    body.payments !== undefined ||
    body.remainingAmount !== undefined ||
    body.status !== undefined ||
    body.refundDueAmount !== undefined ||
    body.refundStatus !== undefined ||
    body.refundedQuantity !== undefined ||
    body.refundedAmount !== undefined ||
    body.returnedPaidAmount !== undefined ||
    body.reallocatedPaidAmount !== undefined ||
    body.refunds !== undefined ||
    body.refundAll !== undefined ||
    body.returnAll !== undefined ||
    body.fullRefund !== undefined
  ) {
    res.status(400);
    throw new Error(
      "لا يمكن إرسال payments أو remainingAmount أو status أو حقول المرتجع مباشرة"
    );
  }
};

const validateUpdateRestrictedFields = (body, res) => {
  if (
    body.payments !== undefined ||
    body.paidAmount !== undefined ||
    body.remainingAmount !== undefined ||
    body.status !== undefined ||
    body.initialPaidAmount !== undefined ||
    body.downPayment !== undefined ||
    body.refundDueAmount !== undefined ||
    body.refundStatus !== undefined ||
    body.refundedQuantity !== undefined ||
    body.refundedAmount !== undefined ||
    body.returnedPaidAmount !== undefined ||
    body.reallocatedPaidAmount !== undefined ||
    body.refunds !== undefined ||
    body.refundAll !== undefined ||
    body.returnAll !== undefined ||
    body.fullRefund !== undefined
  ) {
    res.status(400);
    throw new Error(
      "لا يمكن تعديل الدفعات أو المرتجعات من خلال هذا المسار. استخدم مسار الدفعات أو المرتجعات"
    );
  }
};

const getRefundQuantityValue = (item) =>
  getFirstDefined(item.quantity, item.quentity, item.returnQuantity, item.refundQuantity);

const getCurrentCreditSaleDocumentItems = (creditSale) =>
  Array.isArray(creditSale.items) ? creditSale.items : [];

const findRefundableInvoiceItem = ({ creditSale, refundItem, itemNumber, res }) => {
  const currentItems = getCurrentCreditSaleDocumentItems(creditSale);
  const itemId =
    typeof refundItem.itemId === "string" && refundItem.itemId.trim()
      ? refundItem.itemId.trim()
      : "";
  const productId =
    typeof refundItem.productId === "string" && refundItem.productId.trim()
      ? refundItem.productId.trim()
      : "";

  if (!itemId && !productId) {
    res.status(400);
    throw new Error(`يجب إرسال itemId أو productId في عنصر المرتجع رقم ${itemNumber}`);
  }

  if (itemId) {
    if (!mongoose.Types.ObjectId.isValid(itemId)) {
      res.status(400);
      throw new Error(`تنسيق itemId غير صالح في عنصر المرتجع رقم ${itemNumber}`);
    }

    const matchedItem = currentItems.find((item) => item._id.toString() === itemId);
    if (!matchedItem) {
      res.status(404);
      throw new Error(`عنصر الفاتورة غير موجود في عنصر المرتجع رقم ${itemNumber}`);
    }

    return matchedItem;
  }

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    res.status(400);
    throw new Error(`تنسيق productId غير صالح في عنصر المرتجع رقم ${itemNumber}`);
  }

  const matchedItems = currentItems.filter(
    (item) => getCreditSaleItemProductId(item)?.toString() === productId
  );

  if (matchedItems.length === 0) {
    res.status(404);
    throw new Error(`المنتج غير موجود في الفاتورة لعنصر المرتجع رقم ${itemNumber}`);
  }

  if (matchedItems.length > 1) {
    res.status(400);
    throw new Error(`يجب استخدام itemId لعنصر المرتجع رقم ${itemNumber} لتجنب التكرار`);
  }

  return matchedItems[0];
};

const normalizeCreditSaleRefundItems = (creditSale, body, res) => {
  const currentItems = getCurrentCreditSaleDocumentItems(creditSale);

  if (currentItems.length === 0) {
    res.status(400);
    throw new Error("لا توجد عناصر قابلة للإرجاع في هذه الفاتورة");
  }

  const refundAll = parseBoolean(
    getFirstDefined(body.refundAll, body.returnAll, body.fullRefund)
  );

  if (refundAll === null) {
    res.status(400);
    throw new Error("تنسيق refundAll غير صالح");
  }

  if (refundAll === true) {
    return currentItems.map((item) => ({
      invoiceItem: item,
      quantity: Number(item.quantity) - Number(item.returnedQuantity || 0),
      returnReason: undefined,
    })).filter((item) => item.quantity > 0);
  }

  if (!Array.isArray(body.items)) {
    res.status(400);
    throw new Error("يجب إرسال items أو refundAll=true للمرتجع");
  }

  if (body.items.length === 0) {
    res.status(400);
    throw new Error("يجب أن تحتوي items على عنصر واحد على الأقل في المرتجع");
  }

  const refundSelectionsByItemId = new Map();

  for (const [index, refundItem] of body.items.entries()) {
    const itemNumber = index + 1;

    if (!refundItem || typeof refundItem !== "object" || Array.isArray(refundItem)) {
      res.status(400);
      throw new Error(`عنصر المرتجع رقم ${itemNumber} غير صالح`);
    }

    const invoiceItem = findRefundableInvoiceItem({
      creditSale,
      refundItem,
      itemNumber,
      res,
    });

    const rawQuantity = getRefundQuantityValue(refundItem);
    if (rawQuantity === undefined) {
      res.status(400);
      throw new Error(`كمية المرتجع مطلوبة في العنصر رقم ${itemNumber}`);
    }

    const quantity = parsePositiveInteger(rawQuantity);
    if (quantity === null) {
      res.status(400);
      throw new Error(`يجب أن تكون كمية المرتجع رقمًا صحيحًا موجبًا في العنصر رقم ${itemNumber}`);
    }

    const returnReason = getFirstDefined(refundItem.returnReason, refundItem.reason);
    if (returnReason !== undefined && (typeof returnReason !== "string" || returnReason.trim().length > 500)) {
      res.status(400);
      throw new Error(`سبب المرتجع غير صالح في العنصر رقم ${itemNumber}`);
    }

    const itemKey = invoiceItem._id.toString();
    const existingSelection = refundSelectionsByItemId.get(itemKey) || {
      invoiceItem,
      quantity: 0,
    };
    const nextQuantity = existingSelection.quantity + quantity;

    const availableQuantity = Number(invoiceItem.quantity || 0) - Number(invoiceItem.returnedQuantity || 0);
    if (nextQuantity > availableQuantity) {
      res.status(400);
      throw new Error(`كمية المرتجع تتجاوز الكمية المتاحة في العنصر رقم ${itemNumber}`);
    }

    refundSelectionsByItemId.set(itemKey, {
      invoiceItem,
      quantity: nextQuantity,
      returnReason: returnReason?.trim() || existingSelection.returnReason,
    });
  }

  return [...refundSelectionsByItemId.values()];
};

const buildPersistedRefundItems = (refundSelections) =>
  refundSelections.map(({ invoiceItem, quantity }) => {
    const unitPrice = Number(invoiceItem.unitPrice || 0);

    return {
      invoiceItemId: invoiceItem._id,
      product: getCreditSaleItemProductId(invoiceItem),
      productName: invoiceItem.productName,
      categoryName: invoiceItem.categoryName,
      quantity,
      unitPrice,
      totalPrice: roundMoney(unitPrice * quantity),
    };
  });

const buildNextCreditSaleItemsAfterRefund = (creditSale, refundSelections) => {
  const refundQuantityByItemId = new Map(
    refundSelections.map(({ invoiceItem, quantity }) => [invoiceItem._id.toString(), quantity])
  );

  return getCurrentCreditSaleDocumentItems(creditSale).flatMap((item) => {
    const currentQuantity = Number(item.quantity || 0);
    const refundedQuantity = Number(refundQuantityByItemId.get(item._id.toString()) || 0);
    const remainingQuantity = currentQuantity - refundedQuantity;

    if (remainingQuantity <= 0) {
      return [];
    }

    return [
      {
        productId: getCreditSaleItemProductId(item)?.toString(),
        quantity: remainingQuantity,
        unitPrice: Number(item.unitPrice),
      },
    ];
  });
};

const createCreditSaleInTransaction = async (req, res, session) => {
  validateCreateOnlyFields(req.body, res);

  const customer = await ensureCustomerExistsForCreditSale({
    customerId: req.body.customerId,
    customerName: req.body.customerName,
    customerPhone: req.body.customerPhone,
    res,
    session,
  });
  const normalizedSellingDate = normalizeRequiredDate(req.body.sellingDate, "تاريخ البيع", res);
  const normalizedDueDate = normalizeOptionalDate(req.body.dueDate, "تاريخ الاستحقاق", res);
  const normalizedNotes = normalizeOptionalString(req.body.notes, "ملاحظات البيع الآجل", res);
  const items = normalizeCreditSaleItems(req.body, res);
  const invoicePricing = resolveInvoicePricing(req.body, {}, res);

  ensureDueDateIsValid(normalizedSellingDate, normalizedDueDate, res);

  const rawInitialPaidAmount = getFirstDefined(
    req.body.initialPaidAmount,
    req.body.downPayment,
    req.body.paidAmount
  );
  const initialPaidAmount =
    rawInitialPaidAmount === undefined ? 0 : parseNonNegativeNumber(rawInitialPaidAmount);

  if (initialPaidAmount === null) {
    res.status(400);
    throw new Error("المبلغ المدفوع مبدئيًا يجب أن يكون رقمًا غير سالب");
  }

  const initialPaymentDate =
    initialPaidAmount > 0
      ? normalizeOptionalDate(
          getFirstDefined(req.body.initialPaymentDate, req.body.paymentDate),
          "تاريخ الدفعة الأولى",
          res
        ) || normalizedSellingDate
      : null;
  const initialPaymentNote = normalizeOptionalString(
    req.body.initialPaymentNote,
    "ملاحظة الدفعة الأولى",
    res
  );

  const productsById = await applyInventoryForInvoiceChange({
    currentItems: [],
    nextItems: items,
    res,
    allowBelowCost: canSellBelowCost(req),
    session,
  });
  const persistedItems = buildPersistedItems(items, productsById);
  const invoiceTotals = buildInvoiceTotals(persistedItems, invoicePricing);
  const invoiceId = new mongoose.Types.ObjectId();
  const invoiceNumber = await nextDocumentNumber(PREFIXES.CREDIT_INVOICE, session);
  const receiptNumber = initialPaidAmount > 0 ? await nextDocumentNumber(PREFIXES.RECEIPT, session) : null;
  const receiptId = initialPaidAmount > 0 ? new mongoose.Types.ObjectId() : null;
  const payments =
    initialPaidAmount > 0
      ? [
          {
            amount: initialPaidAmount,
            paymentDate: initialPaymentDate,
            note: initialPaymentNote,
            number: receiptNumber,
            receipt: receiptId,
            source: "down_payment",
          },
        ]
      : [];
  const creditAmounts = calculateCreditAmounts(invoiceTotals.totalPrice, payments, 0, 0);

  if (creditAmounts.refundDueAmount > MONEY_EPSILON) {
    res.status(400);
    throw new Error("المبلغ المدفوع مبدئيًا لا يمكن أن يتجاوز إجمالي الفاتورة");
  }

  const created = await CreditSale.create([{
      _id: invoiceId,
      number: invoiceNumber,
      customer: customer._id,
      customerName: customer.name,
      customerPhone: customer.phone,
      sellingDate: normalizedSellingDate,
      dueDate: normalizedDueDate ?? undefined,
      items: persistedItems,
      totalQuantity: invoiceTotals.totalQuantity,
      discountAmount: invoiceTotals.discountAmount,
      shippingFees: invoiceTotals.shippingFees,
      totalPrice: invoiceTotals.totalPrice,
      paidAmount: creditAmounts.paidAmount,
      remainingAmount: creditAmounts.remainingAmount,
      refundDueAmount: creditAmounts.refundDueAmount,
      returnedPaidAmount: 0,
      reallocatedPaidAmount: 0,
      status: creditAmounts.status,
      notes: normalizedNotes,
      payments,
  }], { session });
  const creditSale = created[0];
  if (initialPaidAmount > 0) {
    await Receipt.create([{
        _id: receiptId,
        number: receiptNumber,
        customer: customer._id,
        amount: roundMoney(initialPaidAmount),
        paymentDate: initialPaymentDate,
        note: initialPaymentNote,
        kind: "down_payment",
        allocations: [{ creditSale: invoiceId, amount: roundMoney(initialPaidAmount) }],
    }], { session });
  }

  await audit(req, { action: "credit.created", entity: "CreditSale", entityId: creditSale._id, session, strict: true });
  await postSale({ sale: creditSale, credit: true, customer, session });
  if (initialPaidAmount > 0) {
    const receipt = await Receipt.findById(receiptId).session(session).lean();
    await postReceipt({ receipt, customer, session });
  }
  return creditSale;
};

const createCreditSale = asyncHandler(async (req, res) => {
  const creditSale = await withTransaction((session) => createCreditSaleInTransaction(req, res, session));
  res.status(201).json(toCreditSaleInvoice(creditSale));
});

const getCreditSales = asyncHandler(async (req, res) => {
  const { customerId, customerName, customerPhone, status, sellingDate, dueDate, number } = req.query;
  const creditSaleQuery = {};
  const { page, limit, skip } = getPaginationParams(req.query);

  if (number !== undefined) creditSaleQuery.number = normalizeNumberSearch(number, PREFIXES.CREDIT_INVOICE);

  if (
    customerId !== undefined &&
    (typeof customerId !== "string" || !mongoose.Types.ObjectId.isValid(customerId))
  ) {
    res.status(400);
    throw new Error("تنسيق معرّف العميل غير صالح");
  }

  if (customerId !== undefined) {
    creditSaleQuery.customer = customerId;
  }

  if (customerName !== undefined) {
    if (typeof customerName !== "string") {
      res.status(400);
      throw new Error("تنسيق اسم العميل غير صالح");
    }

    const normalizedCustomerName = customerName.trim();
    if (normalizedCustomerName) {
      creditSaleQuery.customerName = new RegExp(escapeRegex(normalizedCustomerName), "i");
    }
  }

  if (customerPhone !== undefined) {
    if (typeof customerPhone !== "string") {
      res.status(400);
      throw new Error("تنسيق رقم هاتف العميل غير صالح");
    }

    const normalizedCustomerPhone = customerPhone.trim();
    if (normalizedCustomerPhone) {
      creditSaleQuery.customerPhone = new RegExp(escapeRegex(normalizedCustomerPhone), "i");
    }
  }

  if (status !== undefined) {
    if (typeof status !== "string" || !status.trim()) {
      res.status(400);
      throw new Error("تنسيق حالة البيع الآجل غير صالح");
    }

    const normalizedStatus = status.trim();
    if (!CREDIT_SALE_STATUSES.has(normalizedStatus)) {
      res.status(400);
      throw new Error("حالة البيع الآجل غير مدعومة");
    }

    creditSaleQuery.status = normalizedStatus;
  }

  if (sellingDate !== undefined) {
    if (typeof sellingDate !== "string" || !sellingDate.trim()) {
      res.status(400);
      throw new Error("تنسيق تاريخ البيع غير صالح");
    }

    const dateRange = getUtcDayRange(sellingDate.trim());
    if (!dateRange) {
      res.status(400);
      throw new Error("تنسيق تاريخ البيع غير صالح");
    }

    creditSaleQuery.sellingDate = {
      $gte: dateRange.startOfDayUtc,
      $lt: dateRange.endOfDayUtc,
    };
  }

  if (dueDate !== undefined) {
    if (typeof dueDate !== "string" || !dueDate.trim()) {
      res.status(400);
      throw new Error("تنسيق تاريخ الاستحقاق غير صالح");
    }

    const dateRange = getUtcDayRange(dueDate.trim());
    if (!dateRange) {
      res.status(400);
      throw new Error("تنسيق تاريخ الاستحقاق غير صالح");
    }

    creditSaleQuery.dueDate = {
      $gte: dateRange.startOfDayUtc,
      $lt: dateRange.endOfDayUtc,
    };
  }

  const [creditSales, totalItems] = await Promise.all([
    CreditSale.find(creditSaleQuery)
      .populate("items.product", "code")
      .populate("refunds.items.product", "code")
      .sort({ sellingDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    CreditSale.countDocuments(creditSaleQuery),
  ]);

  res.json(
    buildPaginatedResponse({
      data: creditSales.map((creditSale) =>
        toCreditSaleInvoice(creditSale, { includeProductCode: true })
      ),
      page,
      limit,
      totalItems,
    })
  );
});

const getCreditSaleById = asyncHandler(async (req, res) => {
  const creditSale = await CreditSale.findById(req.params.id)
    .populate("items.product", "code")
    .populate("refunds.items.product", "code");

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
  }
  res.json(toCreditSaleInvoice(creditSale, { includeProductCode: true }));
});

const updateCreditSaleInTransaction = async (req, res, session) => {
  validateUpdateRestrictedFields(req.body, res);

  const creditSale = await CreditSale.findById(req.params.id).session(session);

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
  }
  if (creditSale.status === "cancelled") {
    const error = new Error("لا يمكن تعديل فاتورة ملغية");
    error.statusCode = 409; error.responseData = { code: "CANCELLED" }; throw error;
  }
  if (creditSale.status === REACTIONARY_CREDIT_SALE_STATUS) {
    const error = new Error("لا يمكن تعديل فاتورة مرتجعة بالكامل");
    error.statusCode = 409; error.responseData = { code: "RETURNED" }; throw error;
  }
  const oldCreditSale = creditSale.toObject();

  const normalizedSellingDate =
    req.body.sellingDate !== undefined
      ? normalizeRequiredDate(req.body.sellingDate, "تاريخ البيع", res)
      : creditSale.sellingDate;
  const normalizedDueDate =
    req.body.dueDate !== undefined
      ? normalizeOptionalDate(req.body.dueDate, "تاريخ الاستحقاق", res)
      : creditSale.dueDate;
  const normalizedNotes =
    req.body.notes !== undefined
      ? normalizeOptionalString(req.body.notes, "ملاحظات البيع الآجل", res)
      : creditSale.notes;
  const invoicePricing = resolveInvoicePricing(req.body, creditSale, res);

  ensureDueDateIsValid(normalizedSellingDate, normalizedDueDate, res);

  let customer = null;
  let nextCustomerName = creditSale.customerName;
  let nextCustomerPhone = creditSale.customerPhone;

  if (req.body.customerId !== undefined) {
    customer = await ensureCustomerExistsForCreditSale({
      customerId: req.body.customerId,
      res,
      session,
    });
    nextCustomerName = customer.name;
    nextCustomerPhone = customer.phone;
  } else if (req.body.customerName !== undefined || req.body.customerPhone !== undefined) {
    nextCustomerName =
      req.body.customerName !== undefined
        ? normalizeRequiredString(req.body.customerName, "اسم العميل", res)
        : creditSale.customerName;
    nextCustomerPhone =
      req.body.customerPhone !== undefined
        ? normalizeRequiredString(req.body.customerPhone, "رقم هاتف العميل", res)
        : creditSale.customerPhone;

    customer = await ensureCustomerExistsForCreditSale({
      customerName: nextCustomerName,
      customerPhone: nextCustomerPhone,
      res,
      session,
    });
    nextCustomerName = customer.name;
    nextCustomerPhone = customer.phone;
  }

  const shouldUpdateItems =
    req.body.items !== undefined ||
    req.body.productId !== undefined ||
    req.body.price !== undefined ||
    getRawQuantity(req.body) !== undefined;
  const shouldUpdateInvoicePricing =
    shouldUpdateItems ||
    req.body.discountAmount !== undefined ||
    req.body.shippingFees !== undefined;

  if (
    shouldUpdateInvoicePricing &&
    Array.isArray(creditSale.refunds) &&
    creditSale.refunds.length > 0
  ) {
    res.status(400);
    throw new Error(
      "لا يمكن تعديل عناصر أو تسعير فاتورة تحتوي على مرتجعات. استخدم مسار المرتجع أو أنشئ فاتورة جديدة"
    );
  }

  const currentItems = getCreditSaleItemInputs(creditSale);
  let nextItems = currentItems;
  let productsById = new Map();
  let persistedItems = null;

  if (shouldUpdateItems) {
    if (req.body.items === undefined && currentItems.length !== 1) {
      res.status(400);
      throw new Error("يجب إرسال items لتعديل فاتورة بيع آجل تحتوي على أكثر من عنصر واحد");
    }

    if (req.body.items !== undefined) {
      nextItems = normalizeCreditSaleItems(req.body, res);
    } else {
      const currentItem = currentItems[0];
      if (!currentItem) {
        res.status(400);
        throw new Error("لا يمكن تعديل عناصر الفاتورة الحالية بهذا الطلب");
      }

      nextItems = normalizeCreditSaleItems(
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
      allowBelowCost: canSellBelowCost(req),
      session,
    });
  }

  if (shouldUpdateItems) {
      persistedItems = buildPersistedItems(nextItems, productsById);
      creditSale.items = persistedItems;
    }

    if (shouldUpdateInvoicePricing) {
      const pricingItems = shouldUpdateItems
        ? persistedItems
        : getCurrentCreditSaleDocumentItems(creditSale);
      const invoiceTotals = buildInvoiceTotals(pricingItems, invoicePricing);
      const creditAmounts = calculateCreditAmounts(
        invoiceTotals.totalPrice,
        creditSale.payments,
        creditSale.returnedPaidAmount,
        creditSale.reallocatedPaidAmount
      );

      if (!creditAmounts) {
        res.status(400);
        throw new Error("المبلغ المدفوع المُعاد أو المُعاد توزيعه غير صالح");
      }

      if (creditAmounts.refundDueAmount > MONEY_EPSILON) {
        res.status(400);
        throw new Error(
          "لا يمكن أن يكون إجمالي البيع الآجل أقل من المبلغ المدفوع بالفعل. استخدم مسار المرتجع"
        );
      }

      creditSale.totalQuantity = invoiceTotals.totalQuantity;
      creditSale.discountAmount = invoiceTotals.discountAmount;
      creditSale.discountPercentage = undefined;
      creditSale.shippingFees = invoiceTotals.shippingFees;
      creditSale.totalPrice = invoiceTotals.totalPrice;
      applyCreditAmountsToInvoice(creditSale, creditAmounts);
    }

    if (customer) {
      creditSale.customer = customer._id;
    }

    creditSale.customerName = nextCustomerName;
    creditSale.customerPhone = nextCustomerPhone;
    creditSale.sellingDate = normalizedSellingDate;
    creditSale.dueDate = normalizedDueDate ?? undefined;
    creditSale.notes = normalizedNotes;

  const updatedCreditSale = await creditSale.save({ session });

  await postInvoiceEdit({
    Model: CreditSale, oldSale: oldCreditSale, newSale: updatedCreditSale, credit: true,
    oldCustomer: { _id: oldCreditSale.customer, name: oldCreditSale.customerName },
    customer: customer || { _id: updatedCreditSale.customer, name: updatedCreditSale.customerName },
    date: new Date(), session,
  });
  await audit(req, { action: "credit.updated", entity: "CreditSale", entityId: creditSale._id, session, strict: true });
  return updatedCreditSale;
};

const updateCreditSale = asyncHandler(async (req, res) => {
  const updated = await withTransaction((session) => updateCreditSaleInTransaction(req, res, session));
  res.json(toCreditSaleInvoice(updated));
});

const addCreditSalePaymentInTransaction = async (req, res, session) => {
  const creditSale = await CreditSale.findById(req.params.id).session(session);

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
  }
  if (creditSale.status === "cancelled") {
    const error = new Error("لا يمكن تسجيل دفعة على فاتورة ملغية");
    error.statusCode = 409; error.responseData = { code: "CANCELLED" }; throw error;
  }
  if (creditSale.status === REACTIONARY_CREDIT_SALE_STATUS) {
    const error = new Error("لا يمكن تسجيل دفعة على فاتورة مرتجعة بالكامل");
    error.statusCode = 409; error.responseData = { code: "RETURNED" }; throw error;
  }

  const amount = parsePositiveNumber(req.body.amount);
  if (amount === null) {
    res.status(400);
    throw new Error("قيمة الدفعة يجب أن تكون رقمًا أكبر من صفر");
  }

  const paymentDate =
    req.body.paymentDate !== undefined
      ? normalizeRequiredDate(req.body.paymentDate, "تاريخ الدفعة", res)
      : new Date();
  const note = normalizeOptionalString(req.body.note, "ملاحظة الدفعة", res);

  const selectedRemainingAmount = roundMoney(Number(creditSale.remainingAmount || 0));
  const otherOpenCreditSales = await CreditSale.find({
    customer: creditSale.customer,
    _id: { $ne: creditSale._id },
    remainingAmount: { $gt: 0 },
    status: { $in: OPEN_CREDIT_SALE_STATUSES },
  }).sort({ sellingDate: -1, createdAt: -1, _id: -1 }).session(session);

  // Stage 18: the customer's opening balance is collected last here (it is the oldest debt).
  const openingDoc = await PartyOpening.findOne({ partyType: "customer", partyId: creditSale.customer }).session(session);
  const openingLeft = openingRemaining(openingDoc);
  const totalRemainingAmount = roundMoney(
    selectedRemainingAmount + openingLeft +
      otherOpenCreditSales.reduce(
        (sum, openInvoice) => sum + Number(openInvoice.remainingAmount || 0),
        0
      )
  );

  if (selectedRemainingAmount <= MONEY_EPSILON) {
    const error = new Error("لا يوجد مبلغ متبقٍ في هذه الفاتورة");
    error.statusCode = 400;
    error.responseData = {
      invoiceId: creditSale._id,
      remainingAmount: selectedRemainingAmount,
      totalRemainingAmount,
    };
    throw error;
  }

  if (amount - totalRemainingAmount > MONEY_EPSILON) {
    const error = new Error("قيمة الدفعة لا يمكن أن تتجاوز إجمالي المبلغ المتبقي على كل الفواتير المفتوحة");
    error.statusCode = 400;
    error.responseData = {
      invoiceId: creditSale._id,
      remainingAmount: selectedRemainingAmount,
      totalRemainingAmount,
    };
    throw error;
  }

  const targetCreditSales = [creditSale, ...otherOpenCreditSales];
  const pendingUpdates = [];
  const openingAllocations = [];
  const receiptNumber = await nextDocumentNumber(PREFIXES.RECEIPT, session);
  const receiptId = new mongoose.Types.ObjectId();
  let remainingPaymentAmount = roundMoney(amount);

  for (const targetCreditSale of targetCreditSales) {
    if (remainingPaymentAmount <= MONEY_EPSILON) {
      break;
    }

    const payableAmount = roundMoney(
      Math.min(remainingPaymentAmount, Number(targetCreditSale.remainingAmount || 0))
    );

    if (payableAmount <= MONEY_EPSILON) {
      continue;
    }

    targetCreditSale.payments.push({
      amount: payableAmount,
      paymentDate,
      note,
      number: receiptNumber,
      receipt: receiptId,
      source: "receipt",
    });

    const creditAmounts = calculateCreditAmounts(
      roundMoney(Number(targetCreditSale.totalPrice || 0) - Number(targetCreditSale.refundedAmount || 0)),
      targetCreditSale.payments,
      targetCreditSale.returnedPaidAmount,
      targetCreditSale.reallocatedPaidAmount
    );
    if (!creditAmounts) {
      res.status(400);
      throw new Error("المبلغ المدفوع المُعاد أو المُعاد توزيعه غير صالح");
    }

    if (creditAmounts.refundDueAmount > MONEY_EPSILON) {
      res.status(400);
      throw new Error("قيمة الدفعات تجاوزت إجمالي إحدى الفواتير أثناء التوزيع");
    }

    applyCreditAmountsToInvoice(targetCreditSale, creditAmounts);
    pendingUpdates.push(targetCreditSale);
    remainingPaymentAmount = roundMoney(remainingPaymentAmount - payableAmount);
  }

  if (remainingPaymentAmount > MONEY_EPSILON && openingLeft > 0) {
    const payableAmount = roundMoney(Math.min(remainingPaymentAmount, openingLeft));
    openingDoc.payments.push({ amount: payableAmount, paymentDate, note, number: receiptNumber, receipt: receiptId });
    await openingDoc.save({ session });
    openingAllocations.push({ opening: openingDoc._id, amount: payableAmount });
    remainingPaymentAmount = roundMoney(remainingPaymentAmount - payableAmount);
  }
  if (remainingPaymentAmount > MONEY_EPSILON) {
    res.status(400);
    throw new Error("تعذر توزيع الدفعة على الفواتير المفتوحة");
  }

  for (const targetCreditSale of pendingUpdates) await targetCreditSale.save({ session });

  const updatedInvoices = pendingUpdates.map((targetCreditSale) => toCreditSaleInvoice(targetCreditSale));
  const primaryInvoice =
    updatedInvoices.find((invoice) => invoice._id.toString() === creditSale._id.toString()) ??
    toCreditSaleInvoice(creditSale);

  await Receipt.create([{
    _id: receiptId,
    number: receiptNumber,
    customer: creditSale.customer,
    amount: roundMoney(amount),
    paymentDate,
    note,
    kind: "payment",
    allocations: [
      ...pendingUpdates.map((targetCreditSale) => ({ creditSale: targetCreditSale._id, amount: targetCreditSale.payments.at(-1).amount })),
      ...openingAllocations,
    ],
  }], { session });
  const receipt = await Receipt.findById(receiptId).session(session).lean();
  const receiptCustomer = await Customer.findById(creditSale.customer).session(session).lean();
  await postReceipt({ receipt, customer: receiptCustomer, session });
  await audit(req, { action: "credit.payment", entity: "CreditSale", entityId: creditSale._id, details: { amount, number: receiptNumber }, session, strict: true });
  return {
    ...primaryInvoice,
    allocatedInvoices: updatedInvoices,
    totalAppliedAmount: roundMoney(amount),
    receiptNumber,
  };
};

const addCreditSalePayment = asyncHandler(async (req, res) => {
  const result = await withTransaction((session) => addCreditSalePaymentInTransaction(req, res, session));
  if (result !== undefined) res.status(201).json(result);
});

const addCreditSaleRefund = asyncHandler(async (req, res) => {
  const updatedCreditSale = await withTransaction(async (session) => {
    const creditSale = await CreditSale.findById(req.params.id).session(session);
    if (!creditSale) { const error = new Error("سجل البيع الآجل غير موجود"); error.statusCode = 404; throw error; }
    if (creditSale.status === "cancelled") {
      const error = new Error("لا يمكن عمل مرتجع لفاتورة ملغية");
      error.statusCode = 409; error.responseData = { code: "CANCELLED" }; throw error;
    }
    if (creditSale.status === REACTIONARY_CREDIT_SALE_STATUS || creditSale.refundStatus === "full") {
      const error = new Error("تم إرجاع الفاتورة بالكامل بالفعل");
      error.statusCode = 409; error.responseData = { code: "FULLY_RETURNED" }; throw error;
    }

    const refundSelections = normalizeCreditSaleRefundItems(creditSale, req.body, res);
    const rawRefundDate = getFirstDefined(req.body.returnDate, req.body.refundDate);
    const refundDate = rawRefundDate !== undefined
      ? normalizeRequiredDate(rawRefundDate, "تاريخ المرتجع", res)
      : new Date();
    const refundNote = normalizeOptionalString(getFirstDefined(req.body.note, req.body.reason), "ملاحظة المرتجع", res);
    const productIds = [...new Set(refundSelections.map(({ invoiceItem }) => getCreditSaleItemProductId(invoiceItem).toString()))];
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) { res.status(404); throw new Error("تعذر العثور على أحد منتجات المرتجع"); }
    const productsById = new Map(products.map((product) => [product._id.toString(), product]));
    const refundItems = buildPersistedRefundItems(refundSelections);
    const refundTotals = buildRefundTotals(refundItems);
    const previousRefundedQuantity = Number(creditSale.refundedQuantity || 0);
    const previousRefundedAmount = roundMoney(creditSale.refundedAmount || 0);
    const nextRefundedQuantity = previousRefundedQuantity + refundTotals.totalQuantity;
    const isFullRefund = nextRefundedQuantity === Number(creditSale.totalQuantity || 0);

    const selectedByItem = new Map(refundSelections.map(({ invoiceItem, quantity }) => [invoiceItem._id.toString(), quantity]));
    const remainingItems = creditSale.items.flatMap((item) => {
      const returned = Number(item.returnedQuantity || 0) + Number(selectedByItem.get(item._id.toString()) || 0);
      const quantity = Number(item.quantity || 0) - returned;
      return quantity > 0 ? [{ quantity, totalPrice: roundMoney(Number(item.unitPrice || 0) * quantity) }] : [];
    });
    const remainingTotals = buildInvoiceTotals(remainingItems, {
      discountAmount: creditSale.discountAmount,
      discountPercentage: creditSale.discountPercentage,
      shippingFees: creditSale.shippingFees,
    });
    const currentNetTotal = roundMoney(Math.max(0, Number(creditSale.totalPrice || 0) - previousRefundedAmount));
    const nextNetTotal = isFullRefund ? 0 : remainingTotals.totalPrice;
    const finalReturnedAmount = roundMoney(currentNetTotal - nextNetTotal);
    if (finalReturnedAmount < 0) { res.status(400); throw new Error("قيمة المرتجع غير صالحة"); }

    for (const { invoiceItem, quantity } of refundSelections) {
      const productId = getCreditSaleItemProductId(invoiceItem);
      await Product.updateOne(
        { _id: productId },
        { $inc: { inventoryCount: quantity, soldItemCount: -quantity } },
        { session }
      );
      invoiceItem.returnedQuantity = Number(invoiceItem.returnedQuantity || 0) + quantity;
    }

    const number = await nextDocumentNumber(PREFIXES.RETURN, session);
    const provisionalCreditAmounts = calculateCreditAmounts(
      nextNetTotal,
      creditSale.payments,
      creditSale.returnedPaidAmount,
      creditSale.reallocatedPaidAmount
    );
    if (!provisionalCreditAmounts) { res.status(400); throw new Error("تعذر حساب رصيد المرتجع"); }
    const settlement = await reallocateRefundCreditToOtherInvoices({
      sourceCreditSale: creditSale,
      refundDate,
      refundNote,
      availableCredit: provisionalCreditAmounts.refundDueAmount,
      returnNumber: number,
      session,
    });
    creditSale.returnedPaidAmount = roundMoney(Number(creditSale.returnedPaidAmount || 0) + settlement.returnedPaidAmount);
    creditSale.reallocatedPaidAmount = roundMoney(Number(creditSale.reallocatedPaidAmount || 0) + settlement.reallocatedPaidAmount);
    const creditAmounts = calculateCreditAmounts(
      nextNetTotal,
      creditSale.payments,
      creditSale.returnedPaidAmount,
      creditSale.reallocatedPaidAmount
    );
    if (!creditAmounts) { res.status(400); throw new Error("تعذر حساب رصيد المرتجع"); }

    const subtotalReturnedAmount = roundMoney(refundTotals.totalAmount);
    const returnedShippingFees = isFullRefund ? roundMoney(creditSale.shippingFees || 0) : 0;
    const returnedDiscountAmount = roundMoney(Math.max(0, subtotalReturnedAmount + returnedShippingFees - finalReturnedAmount));
    const returnLog = await createReturnLog({
      number, returnType: "credit", invoiceId: creditSale._id, invoiceNumber: creditSale.number,
      customerName: creditSale.customerName, customerPhone: creditSale.customerPhone,
      returnDate: refundDate, note: refundNote,
      items: refundSelections.map(({ invoiceItem, quantity, returnReason }) => {
        const productId = getCreditSaleItemProductId(invoiceItem);
        const price = roundMoney(invoiceItem.unitPrice || 0);
        return { invoiceItemId: invoiceItem._id, productId, productName: invoiceItem.productName, productCode: productsById.get(productId.toString())?.code, purchasePrice: roundMoney(invoiceItem.purchasePrice || 0), quantity, price, total: roundMoney(price * quantity), returnReason };
      }),
      subtotalReturnedAmount, discountAmount: returnedDiscountAmount,
      shippingFees: returnedShippingFees, finalReturnedAmount,
      createdBy: req.user?._id ?? req.user?.id,
    }, session);

    creditSale.refunds.push({
      refundDate, note: refundNote, items: refundItems,
      totalQuantity: refundTotals.totalQuantity, totalAmount: finalReturnedAmount,
      returnedPaidAmount: settlement.returnedPaidAmount,
      reallocatedPaidAmount: settlement.reallocatedPaidAmount,
      returnLog: returnLog._id,
    });
    creditSale.refundedQuantity = nextRefundedQuantity;
    creditSale.refundedAmount = roundMoney(previousRefundedAmount + finalReturnedAmount);
    creditSale.refundStatus = getRefundStatus(creditSale.refunds, creditSale.totalQuantity);
    applyCreditAmountsToInvoice(creditSale, creditAmounts, isFullRefund ? REACTIONARY_CREDIT_SALE_STATUS : undefined);
    await creditSale.save({ session });
    await postReturn({ returnLog, sale: creditSale, customer: await Customer.findById(creditSale.customer).session(session).lean(), session });
    await audit(req, { action: "credit.returned", entity: "CreditSale", entityId: creditSale._id, details: { number, amount: finalReturnedAmount }, session, strict: true });
    return creditSale;
  });

  res.status(201).json(toCreditSaleInvoice(updatedCreditSale));
});

const cancelCreditSale = asyncHandler(async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) {
    res.status(400); throw new Error("سبب الإلغاء مطلوب ويجب أن يكون بين 3 و500 حرف");
  }
  const updated = await withTransaction(async (session) => {
    const invoice = await CreditSale.findById(req.params.id).session(session);
    if (!invoice) { const error = new Error("سجل البيع الآجل غير موجود"); error.statusCode = 404; throw error; }
    const conflict = (code, message) => { const error = new Error(message); error.statusCode = 409; error.responseData = { code }; return error; };
    if (invoice.status === "cancelled") throw conflict("ALREADY_CANCELLED", "الفاتورة ملغية بالفعل");
    if ((invoice.refunds || []).length) throw conflict("HAS_RETURNS", "اعمل مرتجع بدل الإلغاء");
    const payments = invoice.payments || [];
    if (payments.some((payment) => payment.source !== "down_payment")) throw conflict("HAS_PAYMENTS", "اعمل مرتجع بدل الإلغاء");
    for (const item of invoice.items || []) {
      const quantity = Number(item.quantity || 0);
      await Product.updateOne({ _id: getCreditSaleItemProductId(item) }, { $inc: { inventoryCount: quantity, soldItemCount: -quantity } }, { session });
    }
    invoice.status = "cancelled";
    invoice.cancelledAt = new Date();
    invoice.cancelledBy = req.user?._id ?? req.user?.id;
    invoice.cancelledByName = req.user?.name;
    invoice.cancellationReason = reason;
    invoice.cancelRefundAmount = roundMoney(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    invoice.remainingAmount = 0;
    await invoice.save({ session });
    const party = { _id: invoice.customer, name: invoice.customerName };
    await postInvoiceCancel({ Model: CreditSale, sale: invoice, credit: true, customer: party, session });
    const downPayment = payments.find((payment) => payment.source === "down_payment");
    if (invoice.cancelRefundAmount > 0 && downPayment) {
      const accounts = await accountMap(["CUSTOMERS", "CASH_MAIN"], session);
      await postEntry({ date: invoice.cancelledAt, source: { type: "refund", id: invoice._id, number: downPayment.number }, session, lines: [
        line(accounts.get("CUSTOMERS"), invoice.cancelRefundAmount, "debit", { partyType: "customer", partyId: invoice.customer, partyName: invoice.customerName }),
        line(accounts.get("CASH_MAIN"), invoice.cancelRefundAmount, "credit"),
      ] });
    }
    await audit(req, { action: "credit.cancelled", entity: "CreditSale", entityId: invoice._id, details: { reason }, session, strict: true });
    return invoice;
  });
  res.json(toCreditSaleInvoice(updated));
});

module.exports = {
  createCreditSale,
  getCreditSales,
  getCreditSaleById,
  updateCreditSale,
  addCreditSalePayment,
  addCreditSaleRefund,
  cancelCreditSale,
};
