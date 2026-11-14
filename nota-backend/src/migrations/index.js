const mongoose = require("mongoose");
const AuditLog = require("../models/auditLog.model");
const Counter = require("../models/counter.model");
const CreditSale = require("../models/creditSale.model");
const Meta = require("../models/meta.model");
const Product = require("../models/product.model");
const Receipt = require("../models/receipt.model");
const ReturnLog = require("../models/returnLog.model");
const Selling = require("../models/selling.model");
const Customer = require("../models/customer.model");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const { seedAccounts, postEntry, accountMap } = require("../accounting/posting");
const { hasLedgerActivity, postStockAdjustment, isSetupMode } = require("../accounting/opening");
const { customerStatementBalances } = require("../services/customerStatement.service");
const { buildInvoiceTotals, roundMoney } = require("../utils/invoicePricing");
const { PREFIXES, formatDocumentNumber, nextDocumentNumber } = require("../utils/documentNumber");
const { withTransaction } = require("../utils/transaction");
const { isLanMode } = require("../middlewares/lanSecret.middleware");
const CashBox = require("../models/cashBox.model");
const PrintReservation = require("../models/printReservation.model");
const { syncAccountBoxes } = require("../cashbox/boxes");

const BATCH_SIZE = 500;
const ORIGINAL_TOTALS_MIGRATION = 2;
const REALLOCATION_NOTE_PREFIX = "تسوية تلقائية من مرتجع الفاتورة";

const failInvoice = (invoice, message) => {
  const error = new Error(`تعذر تحديث الفاتورة ${invoice.number || invoice._id}: ${message}`);
  error.code = "MIGRATION_ORIGINAL_TOTAL_FAILED";
  throw error;
};

const chunks = (items, size = BATCH_SIZE) => {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

async function reserveNumbers(prefix, count, session) {
  if (!count) return [];
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: count } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  const first = counter.seq - count + 1;
  return Array.from({ length: count }, (_, index) => formatDocumentNumber(prefix, first + index));
}

async function bulkWriteInChunks(Model, operations, session) {
  for (const batch of chunks(operations)) {
    await Model.bulkWrite(batch, { ordered: true, session });
  }
}

async function backfillModelNumbers(Model, prefix, dateField, session) {
  const documents = await Model.find({ $or: [{ number: { $exists: false } }, { number: null }, { number: "" }] })
    .sort({ [dateField]: 1, createdAt: 1, _id: 1 }).select("_id").lean().session(session);
  const numbers = await reserveNumbers(prefix, documents.length, session);
  await bulkWriteInChunks(Model, documents.map((document, index) => ({
    updateOne: { filter: { _id: document._id }, update: { $set: { number: numbers[index] } } },
  })), session);
}

const sameInstantWithin = (left, right, milliseconds) => {
  const leftTime = left ? new Date(left).getTime() : NaN;
  const rightTime = right ? new Date(right).getTime() : NaN;
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= milliseconds;
};

const objectIdTime = (value) => {
  try { return value ? new mongoose.Types.ObjectId(value).getTimestamp() : null; } catch (_error) { return null; }
};

const isOldDownPayment = (invoice, payment, index) => index === 0
  && sameInstantWithin(payment.paymentDate, invoice.sellingDate, 1000)
  && sameInstantWithin(objectIdTime(payment._id), invoice.createdAt || objectIdTime(invoice._id), 5000);

const reallocationSourceId = (payment) => {
  const note = typeof payment.note === "string" ? payment.note : "";
  if (!note.startsWith(REALLOCATION_NOTE_PREFIX)) return null;
  return note.slice(REALLOCATION_NOTE_PREFIX.length).match(/[a-f\d]{24}/i)?.[0] || null;
};

async function numbersMigration(session) {
  await backfillModelNumbers(Selling, PREFIXES.CASH_INVOICE, "sellingDate", session);
  await backfillModelNumbers(CreditSale, PREFIXES.CREDIT_INVOICE, "sellingDate", session);
  await backfillModelNumbers(ReturnLog, PREFIXES.RETURN, "returnDate", session);

  const invoices = await CreditSale.collection.find(
    { "payments.0": { $exists: true } },
    { session }
  ).sort({ sellingDate: 1, createdAt: 1, _id: 1 }).toArray();
  const reallocationSources = await CreditSale.find({ reallocatedPaidAmount: { $gt: 0 } })
    .select("_id").lean().session(session);
  const confirmedReallocationSources = new Set(reallocationSources.map((invoice) => String(invoice._id)));
  const numberedPayments = [];
  for (const invoice of invoices) {
    for (const [index, payment] of (invoice.payments || []).entries()) {
      const sourceId = reallocationSourceId(payment);
      if (sourceId && confirmedReallocationSources.has(sourceId)) {
        payment.source = "return_reallocation";
        delete payment.receipt;
        delete payment.number;
        continue;
      }
      if (!payment.number) numberedPayments.push({ invoice, payment, index });
    }
  }
  const receiptNumbers = await reserveNumbers(PREFIXES.RECEIPT, numberedPayments.length, session);
  const receiptDocuments = [];
  numberedPayments.forEach(({ invoice, payment, index }, paymentIndex) => {
    const number = receiptNumbers[paymentIndex];
    const receiptId = new mongoose.Types.ObjectId();
    const downPayment = isOldDownPayment(invoice, payment, index);
    payment.number = number;
    payment.receipt = receiptId;
    payment.source = downPayment ? "down_payment" : "receipt";
    receiptDocuments.push({
      _id: receiptId,
      number,
      customer: invoice.customer,
      amount: roundMoney(payment.amount),
      paymentDate: payment.paymentDate,
      note: payment.note,
      kind: downPayment ? "down_payment" : "payment",
      allocations: [{ creditSale: invoice._id, amount: roundMoney(payment.amount) }],
    });
  });
  for (const batch of chunks(receiptDocuments)) await Receipt.insertMany(batch, { ordered: true, session });
  await bulkWriteInChunks(CreditSale, invoices.map((invoice) => ({
    updateOne: { filter: { _id: invoice._id }, update: { $set: { payments: invoice.payments } } },
  })), session);
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
  if (invoice.stage16OriginalTotalsRestored) return null;
  const logs = await ReturnLog.find({ invoiceId: invoice._id, returnType: "credit" }).sort({ returnDate: 1, createdAt: 1 }).session(session);
  if (!logs.length) failInvoice(invoice, "سجل المرتجع غير موجود");
  if (logs.length !== (invoice.refunds || []).length) failInvoice(invoice, "عدد سجلات المرتجع لا يطابق الفاتورة");
  if ((invoice.refunds || []).some((refund) => !refund.returnLog)) failInvoice(invoice, "أحد المرتجعات غير مرتبط بسجل مرتجع");

  const logsById = new Map(logs.map((log) => [String(log._id), log]));
  for (const refund of invoice.refunds || []) {
    const log = logsById.get(String(refund.returnLog));
    if (!log) failInvoice(invoice, "أحد المرتجعات غير مرتبط بسجل المرتجع الصحيح");
    refund.totalAmount = roundMoney(log.finalReturnedAmount);
  }

  const netRefund = roundMoney(logs.reduce((sum, log) => sum + Number(log.finalReturnedAmount || 0), 0));
  const expectedOriginal = roundMoney(Number(invoice.totalPrice || 0) + netRefund);
  const currentById = new Map((invoice.items || []).map((item) => [String(item._id), item]));
  const returnedById = new Map();
  const mergedKeys = new Set();

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

  // Old partial returns replaced the invoice item subdocuments, giving the remaining line a new
  // _id. Merge an unmatched returned line into exactly one same-product/same-price current line.
  for (const [key, entry] of [...returnedById.entries()]) {
    if (currentById.has(key)) continue;
    const productIds = new Set(entry.samples.map(productIdOf));
    const prices = new Set(entry.samples.map((item) => roundMoney(item.unitPrice)));
    if (productIds.size !== 1 || prices.size !== 1) continue;
    const productId = [...productIds][0];
    const unitPrice = [...prices][0];
    const matches = (invoice.items || []).filter((item) =>
      productIdOf(item) === productId && roundMoney(item.unitPrice) === unitPrice
    );
    if (matches.length !== 1) continue;
    const matchedKey = String(matches[0]._id);
    mergedKeys.add(matchedKey);
    const existing = returnedById.get(matchedKey);
    if (existing) {
      existing.quantity += entry.quantity;
      existing.samples.push(...entry.samples);
    } else {
      returnedById.set(matchedKey, entry);
    }
    returnedById.delete(key);
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
      costEstimated: Boolean(item.costEstimated) || mergedKeys.has(key),
    });
    if (mergedKeys.has(key)) {
      invoice.migrationNotes = [...(invoice.migrationNotes || []), `returned entry merged into line; cost estimated for ${item.productName}`];
      estimatedInvoices.add(String(invoice._id));
    }
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
    const costSources = [...samples, ...logItems];
    const hasExplicitHistoricalCost = costSources.some((item) =>
      item?.purchasePrice !== undefined && Number.isFinite(Number(item.purchasePrice))
    );
    const costCandidates = costSources
      .map((item) => historicalUnitCost(item, unitPrice))
      .filter((cost) => cost !== null);
    if (new Set(costCandidates).size > 1) failInvoice(invoice, "تكلفة عنصر مرتجع محذوف غير محددة بشكل قاطع");
    let purchasePrice = costCandidates[0];
    // Old return code recalculated profit using the product's then-current cost. A cost inferred
    // only from that profit is useful, but it is not a trustworthy sale-time historical cost.
    let costEstimated = purchasePrice !== undefined && !hasExplicitHistoricalCost;
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
  invoice.stage16OriginalTotalsRestored = true;
  if (invoice.refundStatus === "full" || invoice.status === "Reactionary") invoice.status = "returned";
  else invoice.status = invoice.remainingAmount === 0 ? "paid" : Number(invoice.paidAmount || 0) > 0 ? "partially_paid" : "pending";
  await invoice.validate();
  return {
    updateOne: {
      filter: { _id: invoice._id, stage16OriginalTotalsRestored: { $ne: true } },
      update: { $set: {
        items: invoice.items,
        refunds: invoice.refunds,
        totalQuantity: invoice.totalQuantity,
        shippingFees: invoice.shippingFees,
        totalPrice: invoice.totalPrice,
        refundedAmount: invoice.refundedAmount,
        remainingAmount: invoice.remainingAmount,
        refundDueAmount: invoice.refundDueAmount,
        stage16OriginalTotalsRestored: true,
        status: invoice.status,
        migrationNotes: invoice.migrationNotes || [],
      } },
    },
  };
}

const progressFilter = (lastId) => lastId ? { _id: { $gt: new mongoose.Types.ObjectId(lastId) } } : {};

const legacyCashLine = async (invoice, session) => {
  const quantity = Number(invoice.quantity);
  const unitPrice = Number(invoice.unitPrice ?? invoice.productPricePerEach);
  if (!invoice.product || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice)) {
    failInvoice(invoice, "بيانات الفاتورة الكاش القديمة ناقصة");
  }
  const hasPurchasePrice = invoice.purchasePrice !== undefined && Number.isFinite(Number(invoice.purchasePrice));
  let purchasePrice = hasPurchasePrice ? roundMoney(invoice.purchasePrice) : 0;
  if (!hasPurchasePrice) {
    // No stored cost: estimate from the product's current cost (0 only if the product is gone).
    const product = mongoose.Types.ObjectId.isValid(String(invoice.product))
      ? await Product.findById(invoice.product).session(session)
      : null;
    purchasePrice = roundMoney(product?.purchasePrice ?? 0);
  }
  return {
    _id: invoice._id,
    product: invoice.product,
    productName: invoice.productName,
    productCode: invoice.productCode,
    categoryName: invoice.categoryName,
    quantity,
    returnedQuantity: 0,
    unitPrice: roundMoney(unitPrice),
    totalPrice: roundMoney(quantity * unitPrice),
    purchasePrice,
    profitAmount: roundMoney((unitPrice - purchasePrice) * quantity),
    costEstimated: !hasPurchasePrice,
  };
};

async function restoreCashInvoice(invoice, session) {
  const legacySingleLine = !Array.isArray(invoice.items) || invoice.items.length === 0;
  const items = legacySingleLine ? [await legacyCashLine(invoice, session)] : invoice.items.map((item) => ({ ...item }));
  const logs = await ReturnLog.find({ invoiceId: invoice._id, returnType: "cash" }).lean().session(session);
  if (logs.length !== (invoice.refunds || []).length) failInvoice(invoice, "سجل مرتجع كاش مفقود");
  const returnedByItemId = new Map();
  for (const refund of invoice.refunds || []) {
    for (const item of refund.items || []) {
      let matched = item.invoiceItemId
        ? items.find((line) => String(line._id) === String(item.invoiceItemId))
        : null;
      if (!matched) {
        const matches = items.filter((line) =>
          productIdOf(line) === productIdOf(item) && roundMoney(line.unitPrice) === roundMoney(item.unitPrice)
        );
        if (matches.length === 1) matched = matches[0];
      }
      if (!matched) failInvoice(invoice, "تعذر مطابقة عنصر مرتجع كاش بسطر الفاتورة");
      const matchedKey = String(matched._id);
      returnedByItemId.set(matchedKey, Number(returnedByItemId.get(matchedKey) || 0) + Number(item.quantity || 0));
    }
  }
  for (const item of items) item.returnedQuantity = Number(returnedByItemId.get(String(item._id)) || 0);
  return {
    updateOne: {
      filter: { _id: invoice._id, stage16OriginalTotalsRestored: { $ne: true } },
      update: {
        $set: {
          items,
          refundedAmount: roundMoney(logs.reduce((sum, log) => sum + Number(log.finalReturnedAmount || 0), 0)),
          stage16OriginalTotalsRestored: true,
        },
        ...(legacySingleLine ? { $unset: {
          product: "", productName: "", productCode: "", categoryName: "", quantity: "",
          unitPrice: "", productPricePerEach: "", purchasePrice: "", profitAmount: "",
        } } : {}),
      },
    },
  };
}

async function originalTotalsMigrationChunk(session, progress = {}) {
  const phase = progress.phase || "cash";
  const estimatedInvoices = new Set(progress.estimatedCostInvoices || []);

  if (phase === "cash") {
    const cash = await Selling.collection.find({
      "refunds.0": { $exists: true },
      stage16OriginalTotalsRestored: { $ne: true },
      ...progressFilter(progress.lastId),
    }, { session }).sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
    const operations = [];
    for (const invoice of cash) operations.push(await restoreCashInvoice(invoice, session));
    if (operations.length) await Selling.collection.bulkWrite(operations, { ordered: true, session });
    return {
      done: false,
      progress: cash.length === BATCH_SIZE
        ? { migration: ORIGINAL_TOTALS_MIGRATION, phase, lastId: cash.at(-1)._id, estimatedCostInvoices: [...estimatedInvoices] }
        : { migration: ORIGINAL_TOTALS_MIGRATION, phase: "credit", lastId: null, estimatedCostInvoices: [...estimatedInvoices] },
    };
  }

  if (phase === "credit") {
    const credit = await CreditSale.find({
      "refunds.0": { $exists: true },
      stage16OriginalTotalsRestored: { $ne: true },
      ...progressFilter(progress.lastId),
    }).sort({ _id: 1 }).limit(BATCH_SIZE).session(session);
    const operations = [];
    for (const invoice of credit) {
      const operation = await restoreCreditInvoice(invoice, session, estimatedInvoices);
      if (operation) operations.push(operation);
    }
    if (operations.length) await CreditSale.bulkWrite(operations, { ordered: true, session });
    return {
      done: false,
      progress: credit.length === BATCH_SIZE
        ? { migration: ORIGINAL_TOTALS_MIGRATION, phase, lastId: credit.at(-1)._id, estimatedCostInvoices: [...estimatedInvoices] }
        : { migration: ORIGINAL_TOTALS_MIGRATION, phase: "status", lastId: null, estimatedCostInvoices: [...estimatedInvoices] },
    };
  }

  const reactionary = await CreditSale.find({
    status: "Reactionary",
    ...progressFilter(progress.lastId),
  }).sort({ _id: 1 }).limit(BATCH_SIZE).select("_id").lean().session(session);
  if (reactionary.length) {
    await CreditSale.bulkWrite(reactionary.map((invoice) => ({
      updateOne: { filter: { _id: invoice._id, status: "Reactionary" }, update: { $set: { status: "returned" } } },
    })), { ordered: true, session });
  }
  return reactionary.length === BATCH_SIZE
    ? { done: false, progress: { migration: ORIGINAL_TOTALS_MIGRATION, phase: "status", lastId: reactionary.at(-1)._id, estimatedCostInvoices: [...estimatedInvoices] } }
    : { done: true, details: { estimatedCostInvoices: [...estimatedInvoices] } };
}

async function removeLeftoversMigration(session) {
  await Selling.collection.updateMany({}, { $unset: { shippingLocation: "", government: "" } }, { session });
}

async function indexesMigration() {
  const models = Object.values(mongoose.models);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await Promise.all(models.map((model) => model.createIndexes()));
      return;
    } catch (error) {
      const interrupted = error?.code === 11601 || /operation was interrupted/i.test(error?.message || "");
      if (!interrupted || attempt === 2) throw error;
    }
  }
}

async function ledgerStartMigration(session) {
  await seedAccounts(session);
  const existingStart = await Meta.findOne({ _id: "schema", ledgerStartAt: { $exists: true } }).session(session).lean();
  if (existingStart?.ledgerStartAt) return {};
  const products = await Product.find({}).select("inventoryCount purchasePrice").lean().session(session);
  const customers = await Customer.find({}).select("name").lean().session(session);
  // Customer balances come from the Stage 16 statement function itself.
  const { balances: statementBalances, orphanInvoices } = await customerStatementBalances(customers, { session });
  if (orphanInvoices.length) {
    const shown = orphanInvoices.slice(0, 20).map((invoice) => `${invoice.number || invoice._id} (customer ${invoice.customer})`).join(", ");
    const more = orphanInvoices.length > 20 ? ` and ${orphanInvoices.length - 20} more` : "";
    throw new Error(`Ledger opening balance: credit sale(s) reference a customer that no longer exists: ${shown}${more}`);
  }
  const accounts = await accountMap(["INVENTORY", "CUSTOMERS", "CAPITAL"], session);
  const lines = [];
  const inventoryValue = roundMoney(products.reduce((sum, product) => sum + Number(product.inventoryCount || 0) * Number(product.purchasePrice || 0), 0));
  if (inventoryValue > 0) lines.push({ accountId: accounts.get("INVENTORY")._id, accountCode: accounts.get("INVENTORY").code, accountName: accounts.get("INVENTORY").nameEn, debit: inventoryValue, credit: 0 });
  for (const customer of customers) {
    const rounded = roundMoney(statementBalances.get(String(customer._id)) || 0);
    if (rounded === 0) continue;
    lines.push({ accountId: accounts.get("CUSTOMERS")._id, accountCode: accounts.get("CUSTOMERS").code, accountName: accounts.get("CUSTOMERS").nameEn, debit: rounded > 0 ? rounded : 0, credit: rounded < 0 ? -rounded : 0, partyType: "customer", partyId: customer._id, partyName: customer.name });
  }
  const debits = roundMoney(lines.reduce((sum, row) => sum + Number(row.debit || 0), 0));
  const credits = roundMoney(lines.reduce((sum, row) => sum + Number(row.credit || 0), 0));
  const capital = roundMoney(debits - credits);
  if (capital !== 0) lines.push({ accountId: accounts.get("CAPITAL")._id, accountCode: accounts.get("CAPITAL").code, accountName: accounts.get("CAPITAL").nameEn, debit: capital < 0 ? -capital : 0, credit: capital > 0 ? capital : 0 });
  const now = new Date();
  if (lines.length >= 2) {
    const openingId = new mongoose.Types.ObjectId();
    const openingNumber = await nextDocumentNumber(PREFIXES.OPENING_BALANCE, session);
    await postEntry({ date: now, type: "opening", number: openingNumber, source: { type: "opening", id: openingId, number: openingNumber }, lines, memo: "Ledger opening balance", session });
  }
  await Meta.updateOne({ _id: "schema" }, { $set: { ledgerStartAt: now } }, { session, upsert: true });
  return { ledgerStartAt: now, openingCapital: capital };
}

// Stage 18 review fixes: bank/wallet leaf accounts become 5-digit children of 112 (11201, 11202, …)
// so they can never collide with 113; and installs that already have post-ledger documents get
// meta.opening.setupEndedAt, because setup mode now ends with a write instead of a collection scan.
async function stage18FixesMigration(session) {
  const parent = await Account.findOne({ code: "112" }).session(session).lean();
  const renamed = [];
  if (parent) {
    const children = await Account.find({ parentId: parent._id }).session(session).lean();
    for (const child of children) {
      if (!/^112[0-9]$/.test(child.code)) continue;
      const code = `112${String(Number(child.code.slice(3))).padStart(2, "0")}`;
      await Account.collection.updateOne({ _id: child._id }, { $set: { code } }, { session });
      await JournalEntry.collection.updateMany({ "lines.accountId": child._id }, { $set: { "lines.$[row].accountCode": code } }, { arrayFilters: [{ "row.accountId": child._id }], session });
      renamed.push(`${child.code}->${code}`);
    }
  }
  const meta = await Meta.findOne({ _id: "schema" }).session(session).lean();
  let setupEnded = false;
  if (meta?.ledgerStartAt && !meta.opening?.setupEndedAt && meta.opening?.status !== "finalized" && await hasLedgerActivity(new Date(meta.ledgerStartAt), session)) {
    await Meta.updateOne({ _id: "schema" }, { $set: { "opening.setupEndedAt": new Date() } }, { session });
    setupEnded = true;
  }
  return { renamed, setupEnded };
}

// Stage 19: the main box (account 1111, "الخزنة الرئيسية"), a box for every 112xx bank/wallet leaf (same name and
// kind), and the main box on every existing money document. Journal lines stay as they are: the accounts did not change.
async function stage19BoxesMigration(session) {
  await seedAccounts(session);
  const created = await syncAccountBoxes(session);
  const main = await CashBox.findOne({ isMain: true }).session(session).lean();
  const unset = { boxId: { $exists: false } };
  const results = {};
  results.sellings = (await Selling.collection.updateMany(unset, { $set: { boxId: main._id } }, { session })).modifiedCount;
  results.receipts = (await Receipt.collection.updateMany(unset, { $set: { boxId: main._id } }, { session })).modifiedCount;
  results.cashReturns = (await ReturnLog.collection.updateMany({ returnType: "cash", ...unset }, { $set: { boxId: main._id } }, { session })).modifiedCount;
  results.cancelRefunds = (await CreditSale.collection.updateMany({ status: "cancelled", cancelRefundAmount: { $gt: 0 }, cancelRefundBoxId: { $exists: false } }, { $set: { cancelRefundBoxId: main._id } }, { session })).modifiedCount;
  return { boxesCreated: created, ...results };
}

// Stage 19 review: custom expense categories created as 526-529 become 5-digit children of 520 (52001, ...), so they can
// never run into 530 (CASH_OVER_SHORT) and above. System categories 521-525 keep their codes. Journal lines follow.
async function stage19CategoryCodesMigration(session) {
  const parent = await Account.findOne({ code: "520" }).session(session).lean();
  if (!parent) return {};
  const children = await Account.find({ parentId: parent._id }).sort({ code: 1 }).session(session).lean();
  let next = children.reduce((top, child) => (Number(child.code) >= 52000 ? Math.max(top, Number(child.code)) : top), 52000);
  const renamed = [];
  for (const child of children) {
    if (child.isSystem || !/^52[6-9]$/.test(child.code)) continue;
    next += 1;
    const code = String(next);
    await Account.collection.updateOne({ _id: child._id }, { $set: { code } }, { session });
    await JournalEntry.collection.updateMany({ "lines.accountId": child._id }, { $set: { "lines.$[row].accountCode": code } }, { arrayFilters: [{ "row.accountId": child._id }], session });
    renamed.push(`${child.code}->${code}`);
  }
  return { renamed };
}

// Stage 21: account 115 "ضريبة مدخلات قابلة للخصم" (VAT_INPUT, asset, debit normal) under 11. VAT_PAYABLE (22) already exists.
async function stage21VatInputAccountMigration(session) {
  await seedAccounts(session);
  // seedAccounts never overwrites an existing account, so a chart that already has its own account 115 would silently keep it
  // and every VAT posting would later fail. Stop here with a clear message instead; the shop must renumber that account first.
  const account = await Account.findOne({ code: "115" }).session(session).lean();
  if (!account || account.systemKey !== "VAT_INPUT") {
    throw new Error(`Stage 21 migration stopped: account code 115 already exists in the chart of accounts as "${account ? (account.nameAr || account.nameEn || account._id) : "missing"}" and is not the VAT input account (VAT_INPUT). Rename or renumber that account, then start the app again.`);
  }
  return { vatInputAccount: account.code };
}

// Stage 21 review: unit prices have at most 2 decimals now, so a product that still carries a 3-decimal price (an older build allowed
// it) could no longer be sold. Round every product's retail, wholesale and purchase price to 2 decimals. A changed purchase price
// on a product with stock is a cost revaluation: it goes through the same cost_revaluation path as editing the cost (INVENTORY
// against INVENTORY_ADJUSTMENT, or CAPITAL in setup mode) inside this transaction, so INVENTORY = Σ stock × purchasePrice stays exact
// (the rounding is carried from product to product, so the posted total equals the exact change to the piaster). Idempotent: once
// rounded nothing is left to change.
async function stage21ProductPricesMigration(session) {
  const fields = ["retailPrice", "wholesalePrice", "purchasePrice"];
  const products = await Product.collection.find({}, { session, projection: { code: 1, inventoryCount: 1, retailPrice: 1, wholesalePrice: 1, purchasePrice: 1 } }).toArray();
  const setup = await isSetupMode(session);
  let changed = 0; let revalued = 0; let exact = 0; let posted = 0;
  for (const product of products) {
    const $set = {};
    for (const field of fields) {
      const value = product[field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const rounded = roundMoney(value);
      if (rounded !== value) $set[field] = rounded;
    }
    if (!Object.keys($set).length) continue;
    await Product.collection.updateOne({ _id: product._id }, { $set }, { session });
    changed += 1;
    const stock = Number(product.inventoryCount || 0);
    if ($set.purchasePrice !== undefined && stock > 0) {
      exact += stock * ($set.purchasePrice - product.purchasePrice);
      const amount = roundMoney(roundMoney(exact) - posted);
      if (amount !== 0) {
        await postStockAdjustment({ date: new Date(), source: { type: "cost_revaluation", id: product._id, number: product.code }, amount: Math.abs(amount), increase: amount > 0, session, setup });
        posted = roundMoney(posted + amount);
        revalued += 1;
      }
    }
  }
  return { productsChanged: changed, revalued, revaluationTotal: posted };
}

// Stage 23 review: an earlier build created a NON-unique index key_1_copyNo_1 on printreservations. The unique partial index that
// replaces it is named print_reservation_live_unique (same key, different options), so the old one must go first or the
// index build at startup fails with an options conflict. Index changes cannot run inside a transaction. Safe to run twice:
// a missing index or a missing collection is ignored, and only a NON-unique index of that name is dropped.
async function stage23PrintReservationIndexMigration() {
  const collection = PrintReservation.collection;
  let indexes = [];
  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (error.codeName === "NamespaceNotFound" || error.code === 26 || /ns not found|ns does not exist/i.test(error.message)) return { dropped: false };
    throw error;
  }
  const old = indexes.find((index) => index.name === "key_1_copyNo_1"); // whatever its options: unique or not, partial or not
  if (!old) return { dropped: false };
  try {
    await collection.dropIndex("key_1_copyNo_1");
  } catch (error) {
    if (error.codeName === "IndexNotFound" || error.codeName === "NamespaceNotFound" || error.code === 27 || error.code === 26 || /index not found|ns not found/i.test(error.message)) return { dropped: false };
    throw error;
  }
  return { dropped: true };
}

const migrations = [
  { version: 1, name: "document numbers and receipts", run: numbersMigration },
  { version: 2, name: "original invoice totals and returned status", chunked: true, runChunk: originalTotalsMigrationChunk },
  { version: 3, name: "remove selling leftovers", run: removeLeftoversMigration },
  { version: 4, name: "stage 16 indexes", outsideTransaction: true, run: indexesMigration },
  { version: 5, name: "stage 17 chart of accounts and ledger start", run: ledgerStartMigration },
  { version: 6, name: "stage 18 review fixes: bank codes and setup end marker", run: stage18FixesMigration },
  { version: 7, name: "stage 19 cash boxes: main box, bank/wallet boxes, boxId on money documents", run: stage19BoxesMigration },
  { version: 8, name: "stage 19 review: custom expense categories get 5-digit codes under 520", run: stage19CategoryCodesMigration },
  { version: 9, name: "stage 21 VAT: input VAT account 115", run: stage21VatInputAccountMigration },
  { version: 10, name: "stage 21 review: product prices rounded to 2 decimals (cost revaluation posted)", run: stage21ProductPricesMigration },
  { version: 11, name: "stage 23 review: drop the old non-unique printreservations index key_1_copyNo_1", outsideTransaction: true, run: stage23PrintReservationIndexMigration },
];

async function recordMigration(migration, details, session) {
  await AuditLog.create([{
    at: new Date(), action: "system.migration", entity: "Meta", entityId: "schema",
    details: { version: migration.version, name: migration.name, ...details },
  }], { session });
  await Meta.updateOne(
    { _id: "schema" },
    { $set: { version: migration.version }, $unset: { migrationProgress: "" } },
    { upsert: true, session }
  );
}

const isDesktopMongo = (env = process.env) => {
  if (!isLanMode(env) || !env.MONGO_URI) return false;
  try {
    const host = new URL(env.MONGO_URI).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch (_error) {
    return false;
  }
};

async function killDesktopSessions(env = process.env) {
  if (!isDesktopMongo(env)) return false;
  try {
    await mongoose.connection.db.admin().command({ killAllSessions: [] });
    return true;
  } catch (error) {
    console.warn(`MongoDB killAllSessions skipped: ${error.message}`);
    return false;
  }
}

async function runChunkedMigration(migration, afterChunk) {
  for (;;) {
    const schema = await Meta.findById("schema").lean();
    const saved = schema?.migrationProgress?.migration === migration.version
      ? schema.migrationProgress
      : { migration: migration.version };
    const result = await withTransaction(async (session) => {
      const chunk = await migration.runChunk(session, saved);
      if (chunk.done) {
        await recordMigration(migration, chunk.details || {}, session);
      } else {
        await Meta.updateOne(
          { _id: "schema" },
          { $set: { migrationProgress: chunk.progress } },
          { upsert: true, session }
        );
      }
      return chunk;
    });
    if (afterChunk) await afterChunk({ migration, result });
    if (result.done) return;
  }
}

async function runMigrations({ afterChunk } = {}) {
  const schema = await Meta.findById("schema").lean();
  let version = Number(schema?.version || 0);
  const pending = migrations.filter((migration) => migration.version > version);
  if (!pending.length) return version;
  await killDesktopSessions();

  for (const migration of pending) {
    if (migration.chunked) {
      await runChunkedMigration(migration, afterChunk);
    } else if (migration.outsideTransaction) {
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

module.exports = { migrations, runMigrations, isDesktopMongo, killDesktopSessions };
