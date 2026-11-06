const Customer = require("../models/customer.model");
const CreditSale = require("../models/creditSale.model");
const CustomerPayout = require("../models/customerPayout.model");
const PartyOpening = require("../models/partyOpening.model");
const { postEntry, line, accountMap, boxAccount } = require("../accounting/posting");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { loadCustomerOpenItems, sortForCollection } = require("../services/customerOpenItems.service");
const { customerCreditOf } = require("../services/customerCredit.service");
const { calculateCreditAmounts, applyCreditAmountsToInvoice } = require("./creditSale.controller");
const { positiveAmount, optionalDate, optionalText, requiredReason } = require("../cashbox/validate");

const { httpError, isId } = boxes;

// Stage 19: a customer whose statement balance is a credit (we owe them).
//   POST /customers/:id/payouts       pay it out of a box: Dr CUSTOMERS (party) / Cr box. Shows on the statement as a debit line.
//   POST /customers/:id/apply-credit  set it against open items, oldest first. Posts no entry (same party); the statement shows
//                                     nothing new, the open items and the aging change.

const EPSILON = 0.005;

const loadCustomer = async (id, session) => {
  if (!isId(id)) throw httpError(404, "CUSTOMER_NOT_FOUND", "العميل غير موجود");
  const customer = await Customer.findById(id).session(session || null);
  if (!customer) throw httpError(404, "CUSTOMER_NOT_FOUND", "العميل غير موجود");
  return customer;
};

// Two concurrent credit operations on one customer conflict here, so the second re-reads the credit.
const touchCustomer = (customer, session) => Customer.collection.updateOne({ _id: customer._id }, { $currentDate: { updatedAt: true } }, { session });

const payoutView = (payout, boxName) => ({ ...(payout.toObject ? payout.toObject() : payout), boxName: boxName || null });

// GET /api/customers/:id/credit (customers.view)
const getCredit = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const customer = await loadCustomer(req.params.id);
  const [credit, payouts] = await Promise.all([customerCreditOf(customer._id), CustomerPayout.find({ customer: customer._id }).sort({ date: -1, createdAt: -1 }).lean()]);
  res.json({ ...credit, payouts });
};

// POST /api/customers/:id/payouts { boxId?, amount, note?, date? } (credit.collect)
const createPayout = async (req, res) => {
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const note = optionalText(body.note, 500);
  const date = optionalDate(body.date);
  const result = await withTransaction(async (session) => {
    const customer = await loadCustomer(req.params.id, session);
    await touchCustomer(customer, session);
    const { credit } = await customerCreditOf(customer._id, { session });
    if (roundMoney(amount - credit) > EPSILON) throw httpError(409, "EXCEEDS_CREDIT", "المبلغ أكبر من رصيد العميل الدائن", { credit, requested: amount });
    const box = await boxes.resolveBox({ req, boxId: body.boxId, session, direction: "out" });
    await boxes.lockBoxes([box._id], session);
    const balance = await boxes.boxBalance(box, session);
    if (roundMoney(balance - amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية", { boxId: box._id, balance, required: amount });
    const accounts = await accountMap(["CUSTOMERS"], session);
    const number = await nextDocumentNumber(PREFIXES.CUSTOMER_PAYOUT, session);
    const [payout] = await CustomerPayout.create([{ number, customer: customer._id, boxId: box._id, amount, date, note }], { session });
    await postEntry({ date, source: { type: "customer_payout", id: payout._id, number }, memo: note || "Customer credit payout", session, lines: [
      line(accounts.get("CUSTOMERS"), amount, "debit", { partyType: "customer", partyId: customer._id, partyName: customer.name }),
      line(await boxAccount(box._id, session), amount, "credit"),
    ] });
    await audit(req, { action: "credit.payout", entity: "Customer", entityId: customer._id, details: { number, amount, box: box.name }, session, strict: true });
    return { payout, box, customer };
  });
  res.status(201).json({ payout: payoutView(result.payout, result.box.name), credit: await customerCreditOf(result.customer._id) });
};

// POST /api/customers/:id/payouts/:payoutId/cancel { reason } (credit.collect)
const cancelPayout = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  const result = await withTransaction(async (session) => {
    const customer = await loadCustomer(req.params.id, session);
    if (!isId(req.params.payoutId)) throw httpError(404, "PAYOUT_NOT_FOUND", "الصرف غير موجود");
    const payout = await CustomerPayout.findOne({ _id: req.params.payoutId, customer: customer._id }).session(session);
    if (!payout) throw httpError(404, "PAYOUT_NOT_FOUND", "الصرف غير موجود");
    if (payout.status === "cancelled") throw httpError(409, "ALREADY_CANCELLED", "الصرف ملغي بالفعل");
    await boxes.assertBoxActive(payout.boxId, session);
    await touchCustomer(customer, session);
    const now = new Date();
    payout.status = "cancelled"; payout.cancelReason = reason; payout.cancelledAt = now;
    payout.cancelledBy = req.user?._id; payout.cancelledByName = req.user?.name;
    await payout.save({ session });
    await boxes.reverseSourceEntries("customer_payout", payout._id, { date: now, memo: `Customer payout cancelled: ${reason}`, session });
    await audit(req, { action: "credit.payout.cancelled", entity: "Customer", entityId: customer._id, details: { number: payout.number, reason }, session, strict: true });
    return { payout, customer };
  });
  res.json({ payout: payoutView(result.payout), credit: await customerCreditOf(result.customer._id) });
};

// POST /api/customers/:id/apply-credit { amount } (credit.collect)
const applyCredit = async (req, res) => {
  const amount = positiveAmount(req.body && req.body.amount);
  const result = await withTransaction(async (session) => {
    const customer = await loadCustomer(req.params.id, session);
    await touchCustomer(customer, session);
    const credit = await customerCreditOf(customer._id, { session });
    if (roundMoney(amount - credit.applicable) > EPSILON) throw httpError(409, "EXCEEDS_CREDIT", "المبلغ أكبر من الرصيد الدائن المتاح للخصم", { applicable: credit.applicable, requested: amount });
    const items = sortForCollection((await loadCustomerOpenItems([customer._id], { session })).get(String(customer._id))?.items || [], "firstInvoice");
    const now = new Date();
    const allocations = [];
    let left = amount;
    for (const item of items) {
      if (left <= 0) break;
      const portion = roundMoney(Math.min(left, item.remaining));
      if (portion <= 0) continue;
      if (item.kind === "opening") {
        const opening = await PartyOpening.findById(item.id).session(session);
        opening.payments.push({ amount: portion, paymentDate: now, note: "خصم من الرصيد الدائن", source: "credit_application" });
        await opening.save({ session });
      } else {
        const invoice = await CreditSale.findById(item.id).session(session);
        invoice.payments.push({ amount: portion, paymentDate: now, note: "خصم من الرصيد الدائن", source: "credit_application" });
        const amounts = calculateCreditAmounts(roundMoney(Number(invoice.totalPrice || 0) - Number(invoice.refundedAmount || 0)), invoice.payments, invoice.returnedPaidAmount, invoice.reallocatedPaidAmount);
        if (!amounts) throw httpError(409, "INVALID_INVOICE_AMOUNTS", "تعذر حساب مبالغ الفاتورة");
        applyCreditAmountsToInvoice(invoice, amounts);
        await invoice.save({ session });
      }
      allocations.push({ kind: item.kind, id: item.id, number: item.number, amount: portion });
      left = roundMoney(left - portion);
    }
    if (left > EPSILON) throw httpError(409, "EXCEEDS_CREDIT", "مفيش فواتير مفتوحة تكفي المبلغ", { applicable: roundMoney(amount - left), requested: amount });
    await audit(req, { action: "credit.applied", entity: "Customer", entityId: customer._id, details: { amount, items: allocations.length }, session, strict: true });
    return { customer, allocations };
  });
  res.json({ applied: amount, allocations: result.allocations, credit: await customerCreditOf(result.customer._id) });
};

module.exports = { getCredit, createPayout, cancelPayout, applyCredit };
