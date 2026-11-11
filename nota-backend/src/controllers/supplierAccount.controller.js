const mongoose = require("mongoose");
const Supplier = require("../models/supplier.model");
const SupplierPayment = require("../models/supplierPayment.model");
const SupplierRefund = require("../models/supplierRefund.model");
const Purchase = require("../models/purchase.model");
const CashBox = require("../models/cashBox.model");
const { postEntry, line, boxAccount, accountMap } = require("../accounting/posting");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { assertOpenDate } = require("../accounting/period");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { positiveAmount, optionalDate, optionalText, requiredReason } = require("../cashbox/validate");
const { supplierBalances } = require("./supplier.controller");
const { loadSupplierDocuments, statementFor } = require("../services/supplierStatement.service");

const { httpError, isId } = boxes;

// Stage 20: supplier payments (PV), supplier refunds (SR) and the supplier statement.
// The supplier balance (positive = we owe the supplier, "علينا"; negative = an advance, "لينا") has ONE source:
// supplierBalances() in supplier.controller.js (the ledger party balance of account 21). The statement is computed from
// documents, and the health "suppliers" check proves the two agree.

const partyOf = (supplier) => ({ partyType: "supplier", partyId: supplier._id, partyName: supplier.name });

// Paying or refunding a DEACTIVATED supplier stays allowed: we may still owe them (or they us). Only purchases refuse an
// inactive supplier (SUPPLIER_INACTIVE, purchase.controller.js).
const loadSupplier = async (id, session) => {
  if (!isId(id)) throw httpError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
  const supplier = await Supplier.findById(id).session(session || null);
  if (!supplier) throw httpError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
  return supplier;
};

/**
 * Writes the supplier document (updatedAt) so two transactions that read its balance and then post against it conflict on it:
 * one retries and its advance / refund check sees the other's posting. Call it before reading the balance.
 */
const touchSupplier = (supplierId, session) => Supplier.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(supplierId)) }, { $currentDate: { updatedAt: true } }, { session });

/** The balance of one supplier inside a transaction (positive = we owe). */
const balanceOf = async (supplierId, session) => (await supplierBalances([supplierId], session)).balances.get(String(supplierId)) || 0;

/**
 * Posts one payment voucher: Dr SUPPLIERS (party) / Cr box. Same box rules as an expense (direction "out", the
 * one-box rule, an open shift, INSUFFICIENT_BALANCE). Used by the standalone payment and by a purchase paid with cash.
 */
const postSupplierPayment = async ({ req, session, supplier, amount, boxId, date, reference, note, purchase = null, id = undefined }) => {
  const box = await boxes.resolveBox({ req, boxId, session, direction: "out" });
  await boxes.lockBoxes([box._id], session);
  const balance = await boxes.boxBalance(box, session);
  if (roundMoney(balance - amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية", { boxId: box._id, balance, required: amount });
  const number = await nextDocumentNumber(PREFIXES.PAYMENT_VOUCHER, session);
  const [payment] = await SupplierPayment.create([{ ...(id ? { _id: id } : {}), number, supplierId: supplier._id, date, amount, boxId: box._id, reference, note, purchaseId: purchase ? purchase._id : undefined }], { session });
  const accounts = await accountMap(["SUPPLIERS"], session);
  await postEntry({ date, source: { type: "supplier_payment", id: payment._id, number }, memo: note || `Payment to ${supplier.name}`, session, lines: [
    line(accounts.get("SUPPLIERS"), amount, "debit", partyOf(supplier)), line(await boxAccount(box._id, session), amount, "credit"),
  ] });
  return { payment, box };
};

/** Posts one supplier refund: Dr box / Cr SUPPLIERS (party). Direction "in". */
const postSupplierRefund = async ({ req, session, supplier, amount, boxId, date, note, purchaseReturnId }) => {
  const box = await boxes.resolveBox({ req, boxId, session, direction: "in" });
  await boxes.lockBoxes([box._id], session);
  const number = await nextDocumentNumber(PREFIXES.SUPPLIER_REFUND, session);
  const [refund] = await SupplierRefund.create([{ number, supplierId: supplier._id, amount, boxId: box._id, date, note, purchaseReturnId }], { session });
  const accounts = await accountMap(["SUPPLIERS"], session);
  await postEntry({ date, source: { type: "supplier_refund", id: refund._id, number }, memo: note || `Refund from ${supplier.name}`, session, lines: [
    line(await boxAccount(box._id, session), amount, "debit"), line(accounts.get("SUPPLIERS"), amount, "credit", partyOf(supplier)),
  ] });
  return { refund, box };
};

/** A refund can only bring back what the supplier owes us (a debit balance). */
const assertRefundCovered = async (supplier, amount, session) => {
  const owedToUs = Math.max(0, -(await balanceOf(supplier._id, session)));
  if (roundMoney(amount - owedToUs) > 0) throw httpError(409, "REFUND_EXCEEDS_DUE", "المبلغ أكبر من اللي المورد مدينلنا بيه", { due: owedToUs, amount });
};

const paymentView = (payment, boxNames) => ({ ...payment, boxName: boxNames?.get(String(payment.boxId)) || null });
const boxNameMap = async () => new Map((await CashBox.find({}).select("name").lean()).map((box) => [String(box._id), box.name]));

// POST /api/suppliers/:id/payments { amount, boxId?, date?, reference?, note?, confirmAdvance? } (suppliers.pay)
const createPayment = async (req, res) => {
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const date = optionalDate(body.date);
  const reference = optionalText(body.reference, 100, "المرجع");
  const note = optionalText(body.note, 500);
  const payment = await withTransaction(async (session) => {
    await assertOpenDate(date, { session }); // Stage 22: the period lock, before anything else is checked
    const supplier = await loadSupplier(req.params.id, session);
    await touchSupplier(supplier._id, session);
    const balance = await balanceOf(supplier._id, session);
    // More than what we owe (or anything when we owe nothing) is an advance: the supplier balance turns into "لينا".
    if (roundMoney(amount - Math.max(0, balance)) > 0 && body.confirmAdvance !== true) {
      throw httpError(409, "ADVANCE_NOT_CONFIRMED", "المبلغ أكبر من اللي علينا للمورد. هيتحول لدفعة مقدمة", { balance, amount, advance: roundMoney(amount - Math.max(0, balance)) });
    }
    const { payment: created, box } = await postSupplierPayment({ req, session, supplier, amount, boxId: body.boxId, date, reference, note });
    await audit(req, { action: "supplier.payment.created", entity: "SupplierPayment", entityId: created._id, details: { number: created.number, amount, supplier: supplier.name, box: box.name }, session, strict: true });
    return created;
  });
  res.status(201).json({ ...payment.toObject(), balanceAfter: await balanceOf(payment.supplierId) });
};

// GET /api/suppliers/:id/payments
const getPayments = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isId(req.params.id)) throw httpError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
  const [rows, names] = await Promise.all([SupplierPayment.find({ supplierId: req.params.id }).sort({ date: -1, createdAt: -1 }).lean(), boxNameMap()]);
  res.json({ data: rows.map((row) => paymentView(row, names)) });
};

// POST /api/supplier-payments/:id/cancel { reason } (suppliers.pay): a reversal; the money goes back into its box, which must still be active.
const cancelPayment = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  if (!isId(req.params.id)) throw httpError(404, "PAYMENT_NOT_FOUND", "سند الصرف غير موجود");
  const cancelled = await withTransaction(async (session) => {
    const payment = await SupplierPayment.findById(req.params.id).session(session);
    if (!payment) throw httpError(404, "PAYMENT_NOT_FOUND", "سند الصرف غير موجود");
    if (payment.status === "cancelled") throw httpError(409, "ALREADY_CANCELLED", "سند الصرف ملغي بالفعل");
    await boxes.assertBoxActive(payment.boxId, session);
    await boxes.lockAndTouch([payment.boxId], session);
    const now = new Date();
    payment.status = "cancelled"; payment.cancelReason = reason; payment.cancelledAt = now; payment.cancelledBy = req.user?._id; payment.cancelledByName = req.user?.name;
    await payment.save({ session });
    await boxes.reverseSourceEntries("supplier_payment", payment._id, { date: now, memo: `Supplier payment cancelled: ${reason}`, session });
    await audit(req, { action: "supplier.payment.cancelled", entity: "SupplierPayment", entityId: payment._id, details: { number: payment.number, reason }, session, strict: true });
    return payment;
  });
  res.json(cancelled);
};

// POST /api/suppliers/:id/refunds { amount, boxId?, date?, note? } (suppliers.pay)
const createRefund = async (req, res) => {
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const date = optionalDate(body.date);
  const note = optionalText(body.note, 500);
  const refund = await withTransaction(async (session) => {
    await assertOpenDate(date, { session }); // Stage 22: the period lock, before anything else is checked
    const supplier = await loadSupplier(req.params.id, session);
    await touchSupplier(supplier._id, session);
    await assertRefundCovered(supplier, amount, session);
    const { refund: created, box } = await postSupplierRefund({ req, session, supplier, amount, boxId: body.boxId, date, note });
    await audit(req, { action: "supplier.refund.created", entity: "SupplierRefund", entityId: created._id, details: { number: created.number, amount, supplier: supplier.name, box: box.name }, session, strict: true });
    return created;
  });
  res.status(201).json(refund);
};

// GET /api/suppliers/:id/refunds
const getRefunds = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isId(req.params.id)) throw httpError(404, "SUPPLIER_NOT_FOUND", "المورد غير موجود");
  res.json({ data: await SupplierRefund.find({ supplierId: req.params.id }).sort({ date: -1, createdAt: -1 }).lean() });
};

// GET /api/suppliers/:id/statement?from&to (suppliers.view)
const getStatement = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const supplier = await loadSupplier(req.params.id, null);
  const range = (value, label) => {
    if (value === undefined || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw httpError(400, "INVALID_DATE", `${label} غير صالح`);
    return date;
  };
  const from = range(req.query.from, "تاريخ البداية");
  const to = range(req.query.to, "تاريخ النهاية");
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) to.setUTCHours(23, 59, 59, 999);
  const docs = await loadSupplierDocuments([supplier._id]);
  const statement = statementFor(supplier.toObject(), docs, { from, to });
  const { balances } = await supplierBalances([supplier._id]);
  res.json({ supplier: { _id: supplier._id, name: supplier.name, paymentTermsDays: supplier.paymentTermsDays ?? null }, ...statement, ledgerBalance: balances.get(String(supplier._id)) || 0 });
};

module.exports = { touchSupplier, postSupplierPayment, postSupplierRefund, assertRefundCovered, balanceOf, createPayment, getPayments, cancelPayment, createRefund, getRefunds, getStatement };
