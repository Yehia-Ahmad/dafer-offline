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

const REACTIONARY_CREDIT_SALE_STATUS = "Reactionary";
const CREDIT_SALE_STATUSES = new Set([
  "pending",
  "partially_paid",
  "paid",
  REACTIONARY_CREDIT_SALE_STATUS,
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

    const customer = await Customer.findById(normalizedCustomerId);
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
  });

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

const applyInventoryForInvoiceChange = async ({ currentItems, nextItems, res }) => {
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

      product.inventoryCount = originalState.inventoryCount + currentQuantity - nextQuantity;
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

const getRefundStatus = (refunds = [], totalQuantity = 0) => {
  if (!Array.isArray(refunds) || refunds.length === 0) {
    return "none";
  }

  return Number(totalQuantity || 0) === 0 ? "full" : "partial";
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

const createCreditSaleFinancialSnapshot = (creditSale) => ({
  payments: Array.isArray(creditSale.payments)
    ? creditSale.payments.map((payment) => ({
        _id: payment._id,
        amount: Number(payment.amount || 0),
        paymentDate: payment.paymentDate,
        note: payment.note,
      }))
    : [],
  paidAmount: Number(creditSale.paidAmount || 0),
  remainingAmount: Number(creditSale.remainingAmount || 0),
  refundDueAmount: Number(creditSale.refundDueAmount || 0),
  status: creditSale.status,
});

const restoreCreditSaleFinancialSnapshot = (creditSale, snapshot) => {
  creditSale.payments = snapshot.payments.map((payment) => ({ ...payment }));
  creditSale.paidAmount = snapshot.paidAmount;
  creditSale.remainingAmount = snapshot.remainingAmount;
  creditSale.refundDueAmount = snapshot.refundDueAmount;
  creditSale.status = snapshot.status;
};

const rollbackCreditSaleFinancialUpdates = async (updates = []) => {
  for (const update of [...updates].reverse()) {
    restoreCreditSaleFinancialSnapshot(update.creditSale, update.snapshot);

    try {
      await update.creditSale.save();
    } catch (_rollbackError) {
      // Best-effort rollback only; surface the original failure.
    }
  }
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

  try {
    const targetCreditSales = await CreditSale.find({
      customer: sourceCreditSale.customer,
      _id: { $ne: sourceCreditSale._id },
      remainingAmount: { $gt: 0 },
      status: { $in: OPEN_CREDIT_SALE_STATUSES },
    }).sort({ sellingDate: 1, createdAt: 1, _id: 1 });

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

      const snapshot = createCreditSaleFinancialSnapshot(targetCreditSale);

      targetCreditSale.payments.push({
        amount: payableAmount,
        paymentDate: refundDate,
        note: paymentNote,
      });

      const creditAmounts = calculateCreditAmounts(
        targetCreditSale.totalPrice,
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
      await targetCreditSale.save();

      updatedInvoices.push({
        creditSale: targetCreditSale,
        snapshot,
      });
      remainingCredit = roundMoney(remainingCredit - payableAmount);
    }
  } catch (error) {
    await rollbackCreditSaleFinancialUpdates(updatedInvoices);
    throw error;
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
      quantity: Number(item.quantity),
      returnReason: undefined,
    }));
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

    if (nextQuantity > Number(invoiceItem.quantity || 0)) {
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

const createCreditSale = asyncHandler(async (req, res) => {
  validateCreateOnlyFields(req.body, res);

  const customer = await ensureCustomerExistsForCreditSale({
    customerId: req.body.customerId,
    customerName: req.body.customerName,
    customerPhone: req.body.customerPhone,
    res,
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
  });
  const persistedItems = buildPersistedItems(items, productsById);
  const invoiceTotals = buildInvoiceTotals(persistedItems, invoicePricing);
  const payments =
    initialPaidAmount > 0
      ? [
          {
            amount: initialPaidAmount,
            paymentDate: initialPaymentDate,
            note: initialPaymentNote,
          },
        ]
      : [];
  const creditAmounts = calculateCreditAmounts(invoiceTotals.totalPrice, payments, 0, 0);

  if (creditAmounts.refundDueAmount > MONEY_EPSILON) {
    await applyInventoryForInvoiceChange({
      currentItems: items,
      nextItems: [],
      res,
    });

    res.status(400);
    throw new Error("المبلغ المدفوع مبدئيًا لا يمكن أن يتجاوز إجمالي الفاتورة");
  }

  let creditSale;

  try {
    creditSale = await CreditSale.create({
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
    });
  } catch (error) {
    try {
      await applyInventoryForInvoiceChange({
        currentItems: items,
        nextItems: [],
        res,
      });
    } catch (_rollbackError) {
      // Best-effort rollback only; surface the create failure.
    }

    throw error;
  }

  res.status(201).json(toCreditSaleInvoice(creditSale));
});

const getCreditSales = asyncHandler(async (req, res) => {
  const { customerId, customerName, customerPhone, status, sellingDate, dueDate } = req.query;
  const creditSaleQuery = {};
  const { page, limit, skip } = getPaginationParams(req.query);

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

const updateCreditSale = asyncHandler(async (req, res) => {
  validateUpdateRestrictedFields(req.body, res);

  const creditSale = await CreditSale.findById(req.params.id);

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
  }

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
    });
  }

  let updatedCreditSale;

  try {
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

    updatedCreditSale = await creditSale.save();
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

  res.json(toCreditSaleInvoice(updatedCreditSale));
});

const addCreditSalePayment = asyncHandler(async (req, res) => {
  const creditSale = await CreditSale.findById(req.params.id);

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
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
  }).sort({ sellingDate: -1, createdAt: -1, _id: -1 });

  const totalRemainingAmount = roundMoney(
    selectedRemainingAmount +
      otherOpenCreditSales.reduce(
        (sum, openInvoice) => sum + Number(openInvoice.remainingAmount || 0),
        0
      )
  );

  if (selectedRemainingAmount <= MONEY_EPSILON) {
    return res.status(400).json({
      message: "لا يوجد مبلغ متبقٍ في هذه الفاتورة",
      invoiceId: creditSale._id,
      remainingAmount: selectedRemainingAmount,
      totalRemainingAmount,
    });
  }

  if (amount - totalRemainingAmount > MONEY_EPSILON) {
    return res.status(400).json({
      message: "قيمة الدفعة لا يمكن أن تتجاوز إجمالي المبلغ المتبقي على كل الفواتير المفتوحة",
      invoiceId: creditSale._id,
      remainingAmount: selectedRemainingAmount,
      totalRemainingAmount,
    });
  }

  const targetCreditSales = [creditSale, ...otherOpenCreditSales];
  const pendingUpdates = [];
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

    const snapshot = createCreditSaleFinancialSnapshot(targetCreditSale);

    targetCreditSale.payments.push({
      amount: payableAmount,
      paymentDate,
      note,
    });

    const creditAmounts = calculateCreditAmounts(
      targetCreditSale.totalPrice,
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
    pendingUpdates.push({
      creditSale: targetCreditSale,
      snapshot,
    });
    remainingPaymentAmount = roundMoney(remainingPaymentAmount - payableAmount);
  }

  if (remainingPaymentAmount > MONEY_EPSILON) {
    res.status(400);
    throw new Error("تعذر توزيع الدفعة على الفواتير المفتوحة");
  }

  const savedUpdates = [];

  try {
    for (const update of pendingUpdates) {
      await update.creditSale.save();
      savedUpdates.push(update);
    }
  } catch (error) {
    await rollbackCreditSaleFinancialUpdates(savedUpdates);
    throw error;
  }

  const updatedInvoices = pendingUpdates.map((update) => toCreditSaleInvoice(update.creditSale));
  const primaryInvoice =
    updatedInvoices.find((invoice) => invoice._id.toString() === creditSale._id.toString()) ??
    toCreditSaleInvoice(creditSale);

  res.status(201).json({
    ...primaryInvoice,
    allocatedInvoices: updatedInvoices,
    totalAppliedAmount: roundMoney(amount),
  });
});

const addCreditSaleRefund = asyncHandler(async (req, res) => {
  const creditSale = await CreditSale.findById(req.params.id);

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
  }

  const refundSelections = normalizeCreditSaleRefundItems(creditSale, req.body, res);
  const rawRefundDate = getFirstDefined(req.body.returnDate, req.body.refundDate);
  const refundDate =
    rawRefundDate !== undefined
      ? normalizeRequiredDate(rawRefundDate, "تاريخ المرتجع", res)
      : new Date();
  const refundNote = normalizeOptionalString(
    getFirstDefined(req.body.note, req.body.reason),
    "ملاحظة المرتجع",
    res
  );

  const currentItems = getCreditSaleItemInputs(creditSale);
  const originalTotalPrice = Number(creditSale.totalPrice || 0);
  const originalShippingFees = Number(creditSale.shippingFees || 0);
  const nextItems = buildNextCreditSaleItemsAfterRefund(creditSale, refundSelections);
  const productsById = await applyInventoryForInvoiceChange({
    currentItems,
    nextItems,
    res,
  });

  let updatedCreditSale;
  let reallocatedUpdates = [];
  let returnLog;

  try {
    const persistedItems = buildPersistedItems(nextItems, productsById);
    const refundItems = buildPersistedRefundItems(refundSelections);
    const invoiceTotals = buildInvoiceTotals(persistedItems, {
      discountAmount: creditSale.discountAmount,
      discountPercentage: creditSale.discountPercentage,
      shippingFees: creditSale.shippingFees ?? 0,
    });
    const refundTotals = buildRefundTotals(refundItems);
    const isFullRefund = invoiceTotals.totalQuantity === 0;
    const currentReturnedPaidAmount = roundMoney(creditSale.returnedPaidAmount || 0);
    const currentReallocatedPaidAmount = roundMoney(creditSale.reallocatedPaidAmount || 0);
    let returnedPaidAmountForThisRefund = 0;
    let reallocatedPaidAmountForThisRefund = 0;
    let nextReturnedPaidAmount = currentReturnedPaidAmount;
    let nextReallocatedPaidAmount = currentReallocatedPaidAmount;

    if (isFullRefund) {
      returnedPaidAmountForThisRefund = roundMoney(creditSale.paidAmount || 0);
      nextReturnedPaidAmount = roundMoney(
        currentReturnedPaidAmount + returnedPaidAmountForThisRefund
      );
    } else {
      const provisionalCreditAmounts = calculateCreditAmounts(
        invoiceTotals.totalPrice,
        creditSale.payments,
        currentReturnedPaidAmount,
        currentReallocatedPaidAmount
      );

      if (!provisionalCreditAmounts) {
        res.status(400);
        throw new Error("المبلغ المدفوع المُعاد أو المُعاد توزيعه لا يمكن أن يتجاوز إجمالي الدفعات");
      }

      const refundSettlement = await reallocateRefundCreditToOtherInvoices({
        sourceCreditSale: creditSale,
        refundDate,
        refundNote,
        availableCredit: provisionalCreditAmounts.refundDueAmount,
      });

      reallocatedUpdates = refundSettlement.updatedInvoices;
      returnedPaidAmountForThisRefund = refundSettlement.returnedPaidAmount;
      reallocatedPaidAmountForThisRefund = refundSettlement.reallocatedPaidAmount;
      nextReturnedPaidAmount = roundMoney(
        currentReturnedPaidAmount + returnedPaidAmountForThisRefund
      );
      nextReallocatedPaidAmount = roundMoney(
        currentReallocatedPaidAmount + reallocatedPaidAmountForThisRefund
      );
    }

    const creditAmounts = calculateCreditAmounts(
      invoiceTotals.totalPrice,
      creditSale.payments,
      nextReturnedPaidAmount,
      nextReallocatedPaidAmount
    );

    if (!creditAmounts) {
      res.status(400);
      throw new Error("المبلغ المدفوع المُعاد أو المُعاد توزيعه لا يمكن أن يتجاوز إجمالي الدفعات");
    }

    if (creditAmounts.refundDueAmount > MONEY_EPSILON) {
      res.status(400);
      throw new Error("تعذر تسوية الرصيد الناتج عن المرتجع بالكامل");
    }

    creditSale.items = persistedItems;
    creditSale.totalQuantity = invoiceTotals.totalQuantity;
    creditSale.discountAmount = invoiceTotals.discountAmount;
    creditSale.discountPercentage = undefined;
    creditSale.shippingFees = invoiceTotals.shippingFees;
    creditSale.totalPrice = invoiceTotals.totalPrice;
    creditSale.returnedPaidAmount = nextReturnedPaidAmount;
    creditSale.reallocatedPaidAmount = nextReallocatedPaidAmount;
    applyCreditAmountsToInvoice(
      creditSale,
      creditAmounts,
      isFullRefund ? REACTIONARY_CREDIT_SALE_STATUS : undefined
    );
    creditSale.refunds.push({
      refundDate,
      note: refundNote,
      items: refundItems,
      totalQuantity: refundTotals.totalQuantity,
      totalAmount: refundTotals.totalAmount,
      returnedPaidAmount: returnedPaidAmountForThisRefund,
      reallocatedPaidAmount: reallocatedPaidAmountForThisRefund,
    });

    const subtotalReturnedAmount = roundMoney(refundTotals.totalAmount);
    const finalReturnedAmount = roundMoney(Math.max(0, originalTotalPrice - Number(invoiceTotals.totalPrice || 0)));
    const returnedShippingFees = isFullRefund ? roundMoney(originalShippingFees) : 0;
    const returnedDiscountAmount = roundMoney(Math.max(0, subtotalReturnedAmount + returnedShippingFees - finalReturnedAmount));
    returnLog = await createReturnLog({
      returnType: "credit", invoiceId: creditSale._id,
      customerName: creditSale.customerName, customerPhone: creditSale.customerPhone,
      returnDate: refundDate, note: refundNote,
      items: refundSelections.map(({ invoiceItem, quantity, returnReason }) => {
        const productId = getCreditSaleItemProductId(invoiceItem);
        const price = roundMoney(invoiceItem.unitPrice || 0);
        return { productId, productName: invoiceItem.productName, productCode: productsById.get(productId.toString())?.code, quantity, price, total: roundMoney(price * quantity), returnReason };
      }),
      subtotalReturnedAmount, discountAmount: returnedDiscountAmount,
      shippingFees: returnedShippingFees, finalReturnedAmount,
      createdBy: req.user?._id ?? req.user?.id,
    });
    creditSale.refunds[creditSale.refunds.length - 1].returnLog = returnLog._id;

    const refundHistoryTotals = buildRefundHistoryTotals(creditSale.refunds);
    creditSale.refundedQuantity = refundHistoryTotals.refundedQuantity;
    creditSale.refundedAmount = refundHistoryTotals.refundedAmount;
    creditSale.refundStatus = getRefundStatus(creditSale.refunds, invoiceTotals.totalQuantity);

    updatedCreditSale = await creditSale.save();
  } catch (error) {
    if (returnLog) { try { await ReturnLog.deleteOne({ _id: returnLog._id }); } catch (_rollbackError) {} }
    if (reallocatedUpdates.length > 0) {
      await rollbackCreditSaleFinancialUpdates(reallocatedUpdates);
    }

    try {
      await applyInventoryForInvoiceChange({
        currentItems: nextItems,
        nextItems: currentItems,
        res,
      });
    } catch (_rollbackError) {
      // Best-effort rollback only; surface the refund failure.
    }

    throw error;
  }

  res.status(201).json(toCreditSaleInvoice(updatedCreditSale));
});

const deleteCreditSale = asyncHandler(async (req, res) => {
  const creditSale = await CreditSale.findById(req.params.id);

  if (!creditSale) {
    res.status(404);
    throw new Error("سجل البيع الآجل غير موجود");
  }

  await creditSale.deleteOne();
  res.json({ message: "Credit sale invoice deleted successfully" });
});

module.exports = {
  createCreditSale,
  getCreditSales,
  getCreditSaleById,
  updateCreditSale,
  addCreditSalePayment,
  addCreditSaleRefund,
  deleteCreditSale,
};
