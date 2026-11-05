const mongoose = require("mongoose");
const AuditLog = require("../models/auditLog.model");
const Counter = require("../models/counter.model");
const CreditSale = require("../models/creditSale.model");
const Meta = require("../models/meta.model");
const Product = require("../models/product.model");
const Receipt = require("../models/receipt.model");
const ReturnLog = require("../models/returnLog.model");
const Selling = require("../models/selling.model");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { PREFIXES, nextDocumentNumber } = require("../utils/documentNumber");
const { withTransaction } = require("../utils/transaction");

const failInvoice = (invoice, message) => {
  const error = new Error(`تعذر تحديث الفاتورة ${invoice.number || invoice._id}: ${message}`);
  error.code = "MIGRATION_ORIGINAL_TOTAL_FAILED";
  throw error;
};

async function backfillModelNumbers(Model, prefix, dateField, session) {
  const documents = await Model.find({ $or: [{ number: { $exists: false } }, { number: null }, { number: "" }] })
    .sort({ [dateField]: 1, createdAt: 1, _id: 1 }).session(session);
  for (const document of documents) {
    document.number = await nextDocumentNumber(prefix, session);
    await document.save({ session, validateBeforeSave: false });
  }
}

async function numbersMigration(session) {
  await backfillModelNumbers(Selling, PREFIXES.CASH_INVOICE, "sellingDate", session);
  await backfillModelNumbers(CreditSale, PREFIXES.CREDIT_INVOICE, "sellingDate", session);
  await backfillModelNumbers(ReturnLog, PREFIXES.RETURN, "returnDate", session);

  const invoices = await CreditSale.find({ "payments.0": { $exists: true } }).sort({ sellingDate: 1, createdAt: 1, _id: 1 }).session(session);
  for (const invoice of invoices) {
    let changed = false;
    for (const payment of invoice.payments) {
      if (payment.number) continue;
      const number = await nextDocumentNumber(PREFIXES.RECEIPT, session);
      const [receipt] = await Receipt.create([{
        number,
        customer: invoice.customer,
        amount: roundMoney(payment.amount),
        paymentDate: payment.paymentDate,
        note: payment.note,
        kind: "payment",
        allocations: [{ creditSale: invoice._id, amount: roundMoney(payment.amount) }],
      }], { session });
      payment.number = number;
      payment.receipt = receipt._id;
      payment.source = "receipt";
      changed = true;
    }
    if (changed) await invoice.save({ session, validateBeforeSave: false });
  }
}

const productIdOf = (item) => String(item.product?._id || item.product || item.productId || "");

const historicalUnitCost = (item, unitPrice) => {
  if (item?.purchasePrice !== undefined && Number.isFinite(Number(item.purchasePrice))) {
    return roundMoney(Number(item.purchasePrice));
  }
  if (item?.profitAmount !== undefined && Number.isFinite(Number(item.profitAmount)) && Number(item.quantity) > 0) {
    return roundMoney(unitPrice - (Number(item.profitAmount) / Number(item.quantity)));
  }
  return null;
};

async function restoreCreditInvoice(invoice, session, estimatedInvoices) {
  const logs = await ReturnLog.find({ invoiceId: invoice._id, returnType: "credit" }).sort({ returnDate: 1, createdAt: 1 }).session(session);
  if (!logs.length) failInvoice(invoice, "سجل المرتجع غير موجود");
  if (logs.length !== (invoice.refunds || []).length) failInvoice(invoice, "عدد سجلات المرتجع لا يطابق الفاتورة");
  if ((invoice.refunds || []).some((refund) => !refund.returnLog)) failInvoice(invoice, "أحد المرتجعات غير مرتبط بسجل مرتجع");

  const netRefund = roundMoney(logs.reduce((sum, log) => sum + Number(log.finalReturnedAmount || 0), 0));
  const expectedOriginal = roundMoney(Number(invoice.totalPrice || 0) + netRefund);
  const currentById = new Map((invoice.items || []).map((item) => [String(item._id), item]));
  const returnedById = new Map();

  for (const refund of invoice.refunds || []) {
    for (const item of refund.items || []) {
      if (!item.invoiceItemId || !Number.isFinite(Number(item.quantity)) || item.unitPrice === undefined) {
        failInvoice(invoice, "بيانات كمية أو سعر عنصر مرتجع ناقصة");
      }
      const key = String(item.invoiceItemId);
      const entry = returnedById.get(key) || { quantity: 0, samples: [] };
      entry.quantity += Number(item.quantity);
      entry.samples.push(item);
      returnedById.set(key, entry);
    }
  }

  const restored = [];
  const handled = new Set();
  for (const item of invoice.items || []) {
    const key = String(item._id);
    const returned = returnedById.get(key)?.quantity || 0;
    const quantity = Number(item.quantity) + returned;
    if (!Number.isFinite(quantity) || quantity <= 0 || item.unitPrice === undefined) failInvoice(invoice, "بيانات عنصر الفاتورة ناقصة");
    const purchasePrice = roundMoney(item.purchasePrice || 0);
    restored.push({
      _id: item._id,
      product: item.product,
      productName: item.productName,
      productCode: item.productCode,
      categoryName: item.categoryName,
      quantity,
      returnedQuantity: returned,
      unitPrice: roundMoney(item.unitPrice),
      totalPrice: roundMoney(Number(item.unitPrice) * quantity),
      purchasePrice,
      profitAmount: roundMoney((Number(item.unitPrice) - purchasePrice) * quantity),
      costEstimated: Boolean(item.costEstimated),
    });
    handled.add(key);
  }

  for (const [key, entry] of returnedById.entries()) {
    if (handled.has(key)) continue;
    const samples = entry.samples;
    const productIds = new Set(samples.map(productIdOf));
    const prices = new Set(samples.map((item) => Number(item.unitPrice)));
    if (productIds.size !== 1 || prices.size !== 1 || ![...prices].every(Number.isFinite)) failInvoice(invoice, "تعذر تحديد عنصر مرتجع محذوف بشكل قاطع");
    const sample = samples[0];
    const productId = [...productIds][0];
    if (!productId || !sample.productName || entry.quantity <= 0) failInvoice(invoice, "بيانات عنصر مرتجع محذوف ناقصة");
    const unitPrice = roundMoney(sample.unitPrice);
    const logItems = logs.flatMap((log) => log.items || []).filter((item) => productIdOf(item) === productId);
    const costCandidates = [...samples, ...logItems]
      .map((item) => historicalUnitCost(item, unitPrice))
      .filter((cost) => cost !== null);
    if (new Set(costCandidates).size > 1) failInvoice(invoice, "تكلفة عنصر مرتجع محذوف غير محددة بشكل قاطع");
    let purchasePrice = costCandidates[0];
    let costEstimated = false;
    if (purchasePrice === undefined) {
      const product = mongoose.Types.ObjectId.isValid(productId) ? await Product.findById(productId).session(session) : null;
      purchasePrice = roundMoney(product?.purchasePrice ?? 0);
      costEstimated = true;
    }
    const logItem = logItems[0];
    restored.push({
      _id: sample.invoiceItemId,
      product: sample.product,
      productName: sample.productName,
      productCode: logItem?.productCode,
      categoryName: sample.categoryName,
      quantity: entry.quantity,
      returnedQuantity: entry.quantity,
      unitPrice,
      totalPrice: roundMoney(unitPrice * entry.quantity),
      purchasePrice,
      profitAmount: roundMoney((unitPrice - purchasePrice) * entry.quantity),
      costEstimated,
    });
    if (costEstimated) {
      invoice.migrationNotes = [...(invoice.migrationNotes || []), `cost estimated for ${sample.productName}`];
      estimatedInvoices.add(String(invoice._id));
    }
  }

  const originalShipping = roundMoney(Number(invoice.shippingFees || 0) + logs.reduce((sum, log) => sum + Number(log.shippingFees || 0), 0));
  const totals = buildInvoiceTotals(restored, {
    discountAmount: invoice.discountAmount,
    discountPercentage: invoice.discountPercentage,
    shippingFees: originalShipping,
  });
  if (roundMoney(totals.totalPrice) !== expectedOriginal) {
    failInvoice(invoice, `الإجمالي ${totals.totalPrice} لا يساوي ${expectedOriginal}`);
  }
  invoice.items = restored;
  invoice.totalQuantity = totals.totalQuantity;
  invoice.shippingFees = totals.shippingFees;
  invoice.totalPrice = totals.totalPrice;
  invoice.refundedAmount = netRefund;
  invoice.remainingAmount = roundMoney(Math.max(0, totals.totalPrice - Number(invoice.paidAmount || 0) - netRefund));
  invoice.refundDueAmount = roundMoney(Math.max(0, Number(invoice.paidAmount || 0) + netRefund - totals.totalPrice));
  if (invoice.refundStatus === "full" || invoice.status === "Reactionary") invoice.status = "returned";
  else invoice.status = invoice.remainingAmount === 0 ? "paid" : Number(invoice.paidAmount || 0) > 0 ? "partially_paid" : "pending";
  await invoice.save({ session });
}

async function originalTotalsMigration(session) {
  const estimatedInvoices = new Set();
  const cash = await Selling.find({ "refunds.0": { $exists: true } }).session(session);
  for (const invoice of cash) {
    const logs = await ReturnLog.find({ invoiceId: invoice._id, returnType: "cash" }).session(session);
    if (logs.length !== invoice.refunds.length) failInvoice(invoice, "سجل مرتجع كاش مفقود");
    invoice.refundedAmount = roundMoney(logs.reduce((sum, log) => sum + Number(log.finalReturnedAmount || 0), 0));
    await invoice.save({ session });
  }
  const credit = await CreditSale.find({ "refunds.0": { $exists: true } }).session(session);
  for (const invoice of credit) await restoreCreditInvoice(invoice, session, estimatedInvoices);
  await CreditSale.updateMany({ status: "Reactionary" }, { $set: { status: "returned" } }, { session, runValidators: false });
  return { estimatedCostInvoices: [...estimatedInvoices] };
}

async function removeLeftoversMigration(session) {
  await Selling.updateMany({}, { $unset: { shippingLocation: "", government: "" } }, { session });
}

async function indexesMigration() {
  await Promise.all([Selling.init(), CreditSale.init(), ReturnLog.init(), Receipt.init(), Product.init(), Counter.init()]);
}

const migrations = [
  { version: 1, name: "document numbers and receipts", run: numbersMigration },
  { version: 2, name: "original invoice totals and returned status", run: originalTotalsMigration },
  { version: 3, name: "remove selling leftovers", run: removeLeftoversMigration },
  { version: 4, name: "stage 16 indexes", outsideTransaction: true, run: indexesMigration },
];

async function recordMigration(migration, details, session) {
  await AuditLog.create([{
    at: new Date(), action: "system.migration", entity: "Meta", entityId: "schema",
    details: { version: migration.version, name: migration.name, ...details },
  }], { session });
  await Meta.updateOne({ _id: "schema" }, { $set: { version: migration.version } }, { upsert: true, session });
}

async function runMigrations() {
  const schema = await Meta.findById("schema").lean();
  let version = Number(schema?.version || 0);
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    if (migration.outsideTransaction) {
      await migration.run();
      await withTransaction((session) => recordMigration(migration, {}, session));
    } else {
      await withTransaction(async (session) => {
        const details = await migration.run(session) || {};
        await recordMigration(migration, details, session);
      });
    }
    version = migration.version;
  }
  return version;
}

module.exports = { migrations, runMigrations };
