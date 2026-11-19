const Customer = require("../models/customer.model");
const CreditSale = require("../models/creditSale.model");
const CustomerPayout = require("../models/customerPayout.model");
const PartyOpening = require("../models/partyOpening.model");
const Receipt = require("../models/receipt.model");
const CashBox = require("../models/cashBox.model");
const WebOrder = require("../models/webOrder.model");
const { postEntry, line, accountMap, boxAccount } = require("../accounting/posting");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { assertOpenDate } = require("../accounting/period");
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
    await assertOpenDate(date, { session }); // Stage 22: the period lock, before anything else is checked
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
    await boxes.lockAndTouch([payout.boxId], session);
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

// GET /api/customers/:id/receipts (customers.view or credit.collect): the customer's payments, newest first, cancelled ones included.
const listReceipts = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const customer = await loadCustomer(req.params.id);
  const receipts = await Receipt.find({ customer: customer._id }).sort({ paymentDate: -1, createdAt: -1 }).lean();
  const boxIds = [...new Set(receipts.map((row) => String(row.boxId || "")).filter(Boolean))];
  const sales = await CreditSale.find({ _id: { $in: receipts.flatMap((row) => row.allocations.map((a) => a.creditSale).filter(Boolean)) } }).select("number").lean();
  const names = new Map((await CashBox.find({ _id: { $in: boxIds } }).select("name").lean()).map((box) => [String(box._id), box.name]));
  const numbers = new Map(sales.map((sale) => [String(sale._id), sale.number]));
  res.json({ data: receipts.map((row) => ({
    _id: row._id, number: row.number, kind: row.kind, amount: row.amount, paymentDate: row.paymentDate, note: row.note || "",
    status: row.status || "posted", cancelReason: row.cancelReason || null, cancelledAt: row.cancelledAt || null,
    boxId: row.boxId || null, boxName: row.boxId ? names.get(String(row.boxId)) || null : null,
    allocations: row.allocations.map((a) => ({ amount: a.amount, invoiceNumber: a.creditSale ? numbers.get(String(a.creditSale)) || null : null, opening: Boolean(a.opening) })),
  })) });
};

// POST /api/customers/:id/receipts/:receiptId/cancel { reason } (credit.payment.cancel: owner and manager)
// Cancel a collected payment. Dated now (the old statement lines and closed periods never change); one transaction:
//   1. first write = a conditional flip of the receipt to "cancelled", so two parallel cancels cancel it once;
//   2. refusals (nothing is undone if one fires: the transaction rolls back the flip);
//   3. the receipt's payment rows on invoices and on the opening are FLAGGED cancelledAt (never deleted) and each invoice is recomputed
//      with the existing calculateCreditAmounts / applyCreditAmountsToInvoice;
//   4. the reversal of the receipt's journal entry through the existing reverseSourceEntries: Dr CUSTOMERS (party) / Cr the box.
const cancelReceipt = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  const result = await withTransaction(async (session) => {
    const customer = await loadCustomer(req.params.id, session);
    if (!isId(req.params.receiptId)) throw httpError(404, "RECEIPT_NOT_FOUND", "الإيصال غير موجود");
    const now = new Date();
    await assertOpenDate(now, { session });
    await touchCustomer(customer, session);
    const found = await Receipt.findOne({ _id: req.params.receiptId, customer: customer._id }).session(session);
    if (!found) throw httpError(404, "RECEIPT_NOT_FOUND", "الإيصال غير موجود");
    if (found.kind !== "payment") throw httpError(409, "USE_INVOICE_CANCEL", "ده مقدم فاتورة. لو عايز ترجّعه الغي الفاتورة (رد المقدم)");
    const receipt = await Receipt.findOneAndUpdate(
      { _id: found._id, status: { $ne: "cancelled" } },
      { $set: { status: "cancelled", cancelReason: reason, cancelledAt: now, cancelledBy: req.user?._id, cancelledByName: req.user?.name } },
      { new: true, session }
    );
    if (!receipt) throw httpError(409, "ALREADY_CANCELLED", "الإيصال ده اتلغى قبل كده");

    if (await WebOrder.exists({ paymentIds: receipt._id }).session(session)) {
      throw httpError(409, "RECEIPT_OF_WEB_ORDER", "ده تحصيل طلب موقع على المندوب. مينفعش يتلغى من هنا؛ حسابه مربوط بالطلب");
    }

    // The box: still active, still holding the money, and (a drawer) a shift open to count the cash that leaves it.
    const box = receipt.boxId ? await CashBox.findById(receipt.boxId).session(session) : await boxes.ensureMainBox(session);
    if (!box) throw httpError(409, "BOX_INACTIVE", "الخزنة دي مقفولة");
    await boxes.assertBoxActive(box._id, session);
    await boxes.lockAndTouch([box._id], session);
    if (box.shiftsEnabled && !(await boxes.openShiftOf(box._id, session))) {
      throw httpError(409, "NO_OPEN_SHIFT", "مفيش وردية مفتوحة على الخزنة دي. افتح وردية الأول عشان الفلوس هتخرج من الدرج", { boxId: box._id, boxName: box.name });
    }
    const balance = await boxes.boxBalance(box, session);
    if (roundMoney(balance - receipt.amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية لإلغاء التحصيل", { boxId: box._id, balance, required: receipt.amount });

    const invoices = await CreditSale.find({ "payments.receipt": receipt._id }).session(session);
    const openings = await PartyOpening.find({ "payments.receipt": receipt._id }).session(session);
    if (!invoices.length && !openings.length) throw httpError(409, "NOTHING_TO_UNDO", "الدفعة دي مش مسجلة على أي فاتورة، مينفعش تتلغى");
    for (const invoice of invoices) {
      if (invoice.status === "cancelled" || invoice.status === "returned") throw httpError(409, "INVOICE_CLOSED", "الفاتورة " + (invoice.number || "") + " اتلغت أو اترجعت بالكامل");
      if ((invoice.payments || []).some((payment) => payment.source === "manual_entry")) throw httpError(409, "WRITTEN_OFF", "الفاتورة " + (invoice.number || "") + " اتعدمت ديونها بقيد يدوي. اعكس القيد الأول");
      if (roundMoney(Number(invoice.returnedPaidAmount || 0) + Number(invoice.reallocatedPaidAmount || 0)) > EPSILON) {
        throw httpError(409, "PAYMENT_USED_BY_RETURN", "مرتجع الفاتورة " + (invoice.number || "") + " رجّع جزء من المبلغ المدفوع (للعميل كرصيد دائن أو على فواتير تانية)، فمينفعش نلغي الدفعة دلوقتي. لو الدفعة غلط: اصرف الرصيد الدائن للعميل من كارته، أو اخصمه من فواتيره، بدل إلغاء الدفعة", { invoice: invoice.number || null });
      }
    }

    const restored = [];
    for (const invoice of invoices) {
      let released = 0;
      for (const payment of invoice.payments) {
        if (String(payment.receipt) === String(receipt._id) && !payment.cancelledAt) { payment.cancelledAt = now; released = roundMoney(released + payment.amount); }
      }
      const amounts = calculateCreditAmounts(roundMoney(Number(invoice.totalPrice || 0) - Number(invoice.refundedAmount || 0)), invoice.payments, invoice.returnedPaidAmount, invoice.reallocatedPaidAmount);
      if (!amounts) throw httpError(409, "INVALID_INVOICE_AMOUNTS", "تعذر حساب مبالغ الفاتورة " + (invoice.number || ""));
      applyCreditAmountsToInvoice(invoice, amounts);
      await invoice.save({ session });
      restored.push({ kind: "invoice", number: invoice.number || null, amount: released });
    }
    for (const opening of openings) {
      let released = 0;
      for (const payment of opening.payments) {
        if (String(payment.receipt) === String(receipt._id) && !payment.cancelledAt) { payment.cancelledAt = now; released = roundMoney(released + payment.amount); }
      }
      await opening.save({ session });
      restored.push({ kind: "opening", number: opening.number || null, amount: released });
    }

    const reversals = await boxes.reverseSourceEntries("receipt", receipt._id, { date: now, memo: "Customer payment cancelled: " + reason, session });
    if (!reversals.length) throw httpError(409, "PRE_LEDGER_RECEIPT", "الدفعة دي من قبل بداية الدفاتر ومالهاش قيد يتعكس");
    await audit(req, { action: "credit.payment.cancelled", entity: "Customer", entityId: customer._id, details: { number: receipt.number, amount: receipt.amount, reason, box: box.name }, session, strict: true });
    return { receipt, restored, customer, boxName: box.name };
  });
  res.json({ receipt: { _id: result.receipt._id, number: result.receipt.number, amount: result.receipt.amount, status: result.receipt.status, cancelReason: result.receipt.cancelReason, cancelledAt: result.receipt.cancelledAt }, restored: result.restored });
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

module.exports = { getCredit, createPayout, cancelPayout, applyCredit, listReceipts, cancelReceipt };
