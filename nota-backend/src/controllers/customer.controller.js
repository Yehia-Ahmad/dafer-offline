const CreditSale = require("../models/creditSale.model");
const Customer = require("../models/customer.model");
const Selling = require("../models/selling.model");
const Receipt = require("../models/receipt.model");
const ReturnLog = require("../models/returnLog.model");
const mongoose = require("mongoose");
const {
  buildCreditSaleSummary,
  toCreditSaleInvoice,
} = require("../utils/creditSaleFormatter");
const asyncHandler = require("../utils/asyncHandler");
const { withTransaction } = require("../utils/transaction");
const { PREFIXES, nextDocumentNumber } = require("../utils/documentNumber");
const { postReceipt } = require("../accounting/posting");
const { resolveBox } = require("../cashbox/boxes");
const { loadCustomerStatement, customerStatementBalances } = require("../services/customerStatement.service");
const { customerCreditOf } = require("../services/customerCredit.service");
const PartyOpening = require("../models/partyOpening.model");
const { loadCustomerOpenItems, openingRemaining, sortForCollection } = require("../services/customerOpenItems.service");
const { audit } = require("../auth/audit");

const OPEN_CREDIT_SALE_STATUSES = ["pending", "partially_paid"];
const MONEY_EPSILON = 1e-9;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const getFirstDefined = (...values) => values.find((value) => value !== undefined);

const normalizeRequiredString = (value, fieldLabel, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} مطلوب`);
  }

  return value.trim();
};

const normalizeOptionalString = (value, fieldLabel, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} غير صالح`);
  }

  return value.trim();
};

const normalizeOptionalPaymentNote = (value, fieldLabel, res) => {
  if (value === undefined || value === null || value === "") {
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

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

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

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

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

const applyCreditAmountsToInvoice = (creditSale, creditAmounts) => {
  creditSale.paidAmount = creditAmounts.paidAmount;
  creditSale.remainingAmount = creditAmounts.remainingAmount;
  creditSale.refundDueAmount = creditAmounts.refundDueAmount;
  creditSale.status = creditAmounts.status;
};

const parseInvoiceSelectionFlag = (value, fieldLabel, res) => {
  const parsedValue = parseBoolean(value);
  if (parsedValue === null) {
    res.status(400);
    throw new Error(`قيمة ${fieldLabel} غير صالحة`);
  }

  return parsedValue ?? false;
};

const getCustomerPaymentSelection = (body, res) => {
  const firstInvoice = parseInvoiceSelectionFlag(
    getFirstDefined(body.firstInvoice, body.isFirstInvoice),
    "firstInvoice",
    res
  );
  const lastInvoice = parseInvoiceSelectionFlag(
    getFirstDefined(body.lastInvoice, body.isLastInvoice),
    "lastInvoice",
    res
  );

  if (firstInvoice && lastInvoice) {
    res.status(400);
    throw new Error("لا يمكن اختيار firstInvoice و lastInvoice معًا");
  }

  if (!firstInvoice && !lastInvoice) {
    res.status(400);
    throw new Error("يجب اختيار firstInvoice أو lastInvoice");
  }

  return firstInvoice ? "firstInvoice" : "lastInvoice";
};

const getLatestDate = (dates) => {
  let latestDate = null;

  for (const dateValue of dates) {
    if (!dateValue) continue;

    const parsedDate = new Date(dateValue);
    if (Number.isNaN(parsedDate.getTime())) continue;

    if (!latestDate || parsedDate > latestDate) {
      latestDate = parsedDate;
    }
  }

  return latestDate;
};

const getCustomers = asyncHandler(async (req, res) => {
  const rawSearch = getFirstDefined(req.query.search, req.query.q);
  const rawName = getFirstDefined(req.query.name, req.query.customerName);
  const rawPhone = getFirstDefined(req.query.phone, req.query.customerPhone);
  const search = typeof rawSearch === "string" ? rawSearch.trim() : "";
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const phone = typeof rawPhone === "string" ? rawPhone.trim() : "";
  const filters = [];

  if (rawSearch !== undefined && typeof rawSearch !== "string") {
    res.status(400);
    throw new Error("تنسيق search غير صالح");
  }

  if (rawName !== undefined && typeof rawName !== "string") {
    res.status(400);
    throw new Error("تنسيق اسم العميل غير صالح");
  }

  if (rawPhone !== undefined && typeof rawPhone !== "string") {
    res.status(400);
    throw new Error("تنسيق رقم هاتف العميل غير صالح");
  }

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    filters.push({
      $or: [{ name: searchRegex }, { phone: searchRegex }],
    });
  }

  if (name) {
    filters.push({ name: new RegExp(escapeRegex(name), "i") });
  }

  if (phone) {
    filters.push({ phone: new RegExp(escapeRegex(phone), "i") });
  }

  const query = filters.length > 0 ? { $and: filters } : {};
  const customers = await Customer.find(query).sort({ createdAt: -1 }).lean();

  if (customers.length === 0) {
    return res.json([]);
  }

  // Stage 18: the same open items the statement, aging and dashboard read, so the opening balance counts everywhere.
  const openItems = await loadCustomerOpenItems(customers.map((customer) => customer._id));
  // The balance (and so the credit) is the statement's, the same figure the ledger holds: payouts and credit returns count.
  const { balances: statementBalances } = await customerStatementBalances(customers);

  res.json(
    customers.map((customer) => {
      const open = openItems.get(String(customer._id));
      const outstanding = roundMoney((open?.items || []).reduce((sum, item) => sum + item.remaining, 0));
      return {
        ...customer,
        isIndebted: outstanding > 0,
        outstanding,
        // Positive = the customer owes us, negative = we owe the customer (credit: an opening, a payout, a credit return).
        balance: roundMoney(statementBalances.get(String(customer._id)) || 0),
        credit: roundMoney(Math.max(0, -(statementBalances.get(String(customer._id)) || 0))),
      };
    })
  );
});

const getCustomerById = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);

  if (!customer) {
    res.status(404);
    throw new Error("العميل غير موجود");
  }

  const creditHistory = await CreditSale.find({ customer: customer._id })
    .populate("items.product", "code")
    .populate("refunds.items.product", "code")
    .sort({ sellingDate: -1, createdAt: -1 });
  const lastCashSale = await Selling.findOne({ customerPhone: customer.phone })
    .sort({ sellingDate: -1, createdAt: -1 })
    .select("sellingDate")
    .lean();
  const lastCreditSalePaymentDate = getLatestDate(
    creditHistory.flatMap((creditSale) =>
      Array.isArray(creditSale.payments)
        ? creditSale.payments.map((payment) => payment.paymentDate)
        : []
    )
  );

  const openingDoc = await PartyOpening.findOne({ partyType: "customer", partyId: customer._id }).lean();
  const openItems = (await loadCustomerOpenItems([customer._id])).get(String(customer._id)) || { items: [], credit: 0 };

  res.json({
    ...customer.toObject(),
    opening: openingDoc ? {
      amount: openingDoc.amount, date: openingDoc.date, number: openingDoc.number || null,
      collected: roundMoney((openingDoc.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)),
      remaining: openingRemaining(openingDoc),
    } : null,
    outstanding: roundMoney(openItems.items.reduce((sum, item) => sum + item.remaining, 0)),
    credit: roundMoney(Math.max(0, -(await customerStatementBalances([customer])).balances.get(String(customer._id)))),
    lastCreditSaleDate: creditHistory[0]?.sellingDate ?? null,
    lastCashSaleDate: lastCashSale?.sellingDate ?? null,
    lastCreditSalePaymentDate,
    // The header balance is what the customer still owes: open invoices plus the opening balance still to collect.
    creditSummary: (() => {
      const summary = buildCreditSaleSummary(creditHistory);
      return { ...summary, remainingAmount: roundMoney(Number(summary.remainingAmount || 0) + (openingDoc ? openingRemaining(openingDoc) : 0)) };
    })(),
    creditHistory: creditHistory.map((creditSale) =>
      toCreditSaleInvoice(creditSale, { includeProductCode: true })
    ),
  });
});

// Stage 21: optional tax number (B2B). Blank/null clears it.
const readTaxNumber = (value, res) => {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (text.length > 50) {
    res.status(400);
    throw new Error("يجب ألا يزيد الرقم الضريبي عن 50 حرف");
  }
  return text;
};

const createCustomer = asyncHandler(async (req, res) => {
  const name = normalizeRequiredString(
    getFirstDefined(req.body.name, req.body.customerName),
    "اسم العميل",
    res
  );
  const phone = normalizeRequiredString(
    getFirstDefined(req.body.phone, req.body.customerPhone),
    "رقم هاتف العميل",
    res
  );

  const taxNumber = readTaxNumber(req.body.taxNumber, res);
  const customer = await Customer.create({ name, phone, ...(taxNumber ? { taxNumber } : {}) });
  res.status(201).json(customer);
});

const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);

  if (!customer) {
    res.status(404);
    throw new Error("العميل غير موجود");
  }

  const nextName = getFirstDefined(req.body.name, req.body.customerName);
  const nextPhone = getFirstDefined(req.body.phone, req.body.customerPhone);

  if (nextName !== undefined) {
    customer.name = normalizeOptionalString(nextName, "اسم العميل", res);
  }

  if (nextPhone !== undefined) {
    customer.phone = normalizeOptionalString(nextPhone, "رقم هاتف العميل", res);
  }

  if (req.body.taxNumber !== undefined) {
    customer.taxNumber = readTaxNumber(req.body.taxNumber, res) || undefined;
  }

  const updatedCustomer = await customer.save();
  res.json(updatedCustomer);
});

const addCustomerCreditSalePaymentInTransaction = async (req, res, session) => {
  const customer = await Customer.findById(req.params.id).session(session);

  if (!customer) {
    res.status(404);
    throw new Error("العميل غير موجود");
  }

  const amount = parsePositiveNumber(req.body.amount);
  if (amount === null) {
    res.status(400);
    throw new Error("قيمة الدفعة يجب أن تكون رقمًا أكبر من صفر");
  }

  const paymentSelection = getCustomerPaymentSelection(req.body, res);
  const paymentDate =
    req.body.paymentDate !== undefined
      ? normalizeRequiredDate(req.body.paymentDate, "تاريخ الدفعة", res)
      : new Date();
  const note = normalizeOptionalPaymentNote(req.body.note, "ملاحظة الدفعة", res);

  const invoiceDocs = await CreditSale.find({
    customer: customer._id,
    remainingAmount: { $gt: 0 },
    status: { $in: OPEN_CREDIT_SALE_STATUSES },
  }).sort({ sellingDate: 1, createdAt: 1, _id: 1 }).session(session);
  // Stage 18: the customer's opening balance is one more open item, the oldest.
  const openingDoc = await PartyOpening.findOne({ partyType: "customer", partyId: customer._id }).session(session);
  const openingLeft = openingRemaining(openingDoc);
  const queue = sortForCollection([
    ...(openingLeft > 0 ? [{ kind: "opening", doc: openingDoc, remaining: openingLeft }] : []),
    ...invoiceDocs.map((doc) => ({ kind: "invoice", doc, remaining: roundMoney(Number(doc.remainingAmount || 0)) })),
  ], paymentSelection);

  if (queue.length === 0) {
    res.status(404);
    throw new Error("لا توجد فواتير آجلة مفتوحة لهذا العميل");
  }

  const selectedItem = queue[0];
  const selectedCreditSale = selectedItem.doc;
  const selectedInvoiceRemainingAmount = selectedItem.remaining;
  const totalRemainingAmount = roundMoney(queue.reduce((sum, item) => sum + item.remaining, 0));

  if (
    paymentSelection === "firstInvoice" &&
    amount - selectedInvoiceRemainingAmount > MONEY_EPSILON
  ) {
    const error = new Error("قيمة الدفعة لا يمكن أن تتجاوز المبلغ المتبقي في الفاتورة المحددة");
    error.statusCode = 400;
    error.responseData = {
      invoiceId: selectedCreditSale._id,
      remainingAmount: selectedInvoiceRemainingAmount,
      totalRemainingAmount,
      paymentSelection,
    };
    throw error;
  }

  if (
    paymentSelection === "lastInvoice" &&
    amount - totalRemainingAmount > MONEY_EPSILON
  ) {
    const error = new Error("قيمة الدفعة لا يمكن أن تتجاوز إجمالي المبلغ المتبقي على كل الفواتير المفتوحة");
    error.statusCode = 400;
    error.responseData = {
      invoiceId: selectedCreditSale._id,
      remainingAmount: selectedInvoiceRemainingAmount,
      totalRemainingAmount,
      paymentSelection,
    };
    throw error;
  }

  const targetItems = paymentSelection === "lastInvoice" ? queue : [selectedItem];
  const pendingUpdates = [];
  const openingAllocations = [];
  const receiptNumber = await nextDocumentNumber(PREFIXES.RECEIPT, session);
  const receiptId = new mongoose.Types.ObjectId();
  let remainingPaymentAmount = roundMoney(amount);

  for (const targetItem of targetItems) {
    if (remainingPaymentAmount <= MONEY_EPSILON) {
      break;
    }
    const creditSale = targetItem.doc;

    const payableAmount = roundMoney(
      Math.min(remainingPaymentAmount, targetItem.remaining)
    );

    if (payableAmount <= MONEY_EPSILON) {
      continue;
    }

    if (targetItem.kind === "opening") {
      creditSale.payments.push({ amount: payableAmount, paymentDate, note, number: receiptNumber, receipt: receiptId });
      openingAllocations.push({ opening: creditSale._id, amount: payableAmount });
      remainingPaymentAmount = roundMoney(remainingPaymentAmount - payableAmount);
      continue;
    }

    creditSale.payments.push({
      amount: payableAmount,
      paymentDate,
      note,
      number: receiptNumber,
      receipt: receiptId,
      source: "receipt",
    });

    const creditAmounts = calculateCreditAmounts(
      roundMoney(Number(creditSale.totalPrice || 0) - Number(creditSale.refundedAmount || 0)),
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
      throw new Error("قيمة الدفعة تجاوزت إجمالي إحدى الفواتير أثناء التوزيع");
    }

    applyCreditAmountsToInvoice(creditSale, creditAmounts);
    pendingUpdates.push(creditSale);
    remainingPaymentAmount = roundMoney(remainingPaymentAmount - payableAmount);
  }

  if (remainingPaymentAmount > MONEY_EPSILON) {
    res.status(400);
    throw new Error("تعذر توزيع الدفعة على الفواتير المفتوحة");
  }

  for (const creditSale of pendingUpdates) await creditSale.save({ session });
  if (openingAllocations.length) await openingDoc.save({ session });

  const updatedInvoices = pendingUpdates.map((sale) => toCreditSaleInvoice(sale));

  const paymentBox = await resolveBox({ req, boxId: req.body.boxId, session });
  await Receipt.create([{
    _id: receiptId,
    number: receiptNumber,
    customer: customer._id,
    amount: roundMoney(amount),
    paymentDate,
    note,
    kind: "payment",
    boxId: paymentBox._id,
    allocations: [
      ...pendingUpdates.map((creditSale) => ({ creditSale: creditSale._id, amount: creditSale.payments.at(-1).amount })),
      ...openingAllocations,
    ],
  }], { session });
  const receipt = await Receipt.findById(receiptId).session(session).lean();
  await postReceipt({ receipt, customer: customer.toObject ? customer.toObject() : customer, session });
  await audit(req, { action: "credit.payment", entity: "Customer", entityId: customer._id, details: { amount, number: receiptNumber }, session, strict: true });
  return {
    message: "تم تسجيل الدفعة بنجاح",
    paymentSelection,
    invoice: updatedInvoices[0],
    invoices: updatedInvoices,
    openingCollected: openingAllocations.reduce((sum, row) => roundMoney(sum + row.amount), 0),
    receiptNumber,
  };
};

const addCustomerCreditSalePayment = asyncHandler(async (req, res) => {
  const result = await withTransaction((session) => addCustomerCreditSalePaymentInTransaction(req, res, session));
  if (result !== undefined) res.status(201).json(result);
});

const deleteCustomer = asyncHandler(async (req, res) => {
  await withTransaction(async (session) => {
    const customer = await Customer.findById(req.params.id).session(session);
    if (!customer) { const error = new Error("العميل غير موجود"); error.statusCode = 404; throw error; }
    if (await CreditSale.exists({ customer: customer._id }).session(session)) {
      const error = new Error("لا يمكن حذف العميل لوجود فواتير مرتبطة به");
      error.statusCode = 409;
      error.responseData = { code: "CUSTOMER_HAS_INVOICES" };
      throw error;
    }
    if (await PartyOpening.exists({ partyType: "customer", partyId: customer._id }).session(session)) {
      const error = new Error("لا يمكن حذف العميل لوجود رصيد أول المدة مسجل له");
      error.statusCode = 409;
      error.responseData = { code: "CUSTOMER_HAS_OPENING" };
      throw error;
    }
    await customer.deleteOne({ session });
    await audit(req, { action: "customer.deleted", entity: "Customer", entityId: customer._id, session, strict: true });
  });
  res.json({ message: "Customer deleted successfully" });
});

const getCustomerStatement = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id).lean();
  if (!customer) { res.status(404); throw new Error("العميل غير موجود"); }
  const parseBoundary = (value, endOfDay) => {
    if (value === undefined) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) { res.status(400); throw new Error("تنسيق التاريخ غير صالح"); }
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) date.setUTCHours(23, 59, 59, 999);
    return date;
  };
  const from = parseBoundary(req.query.from, false);
  const to = parseBoundary(req.query.to, true);
  if (from && to && from > to) { res.status(400); throw new Error("from يجب أن يكون قبل to"); }

  const statement = await loadCustomerStatement(customer._id, { from, to });
  res.json({
    customer: { _id: customer._id, name: customer.name, phone: customer.phone },
    lines: statement.lines,
    totals: statement.totals,
    aging: statement.aging,
    outstanding: statement.outstanding,
    // Stage 19: the credit we owe the customer (what can be paid out / set against open invoices).
    credit: await customerCreditOf(customer._id),
  });
});

module.exports = {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  addCustomerCreditSalePayment,
  getCustomerStatement,
  deleteCustomer,
};
