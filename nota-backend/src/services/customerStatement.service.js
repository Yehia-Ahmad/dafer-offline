const CreditSale = require("../models/creditSale.model");
const ReturnLog = require("../models/returnLog.model");
const PartyOpening = require("../models/partyOpening.model");
const CustomerPayout = require("../models/customerPayout.model");
const { loadCustomerOpenItems, ageOpenItems } = require("./customerOpenItems.service");
const { roundMoney } = require("../utils/invoicePricing");
const { businessDay } = require("../utils/clock");
const { loadManualPartyLines } = require("./manualLines.service");

// Stage 16 customer statement. The HTTP handler, the ledger opening entry
// (Stage 17 migration) and the accounting health check all call this one
// function so the three can never drift apart.

const SKIPPED_PAYMENT_SOURCES = new Set(["return_reallocation", "credit_application", "manual_entry"]);

/**
 * Statement for one customer from already-loaded documents.
 * @param {object} args
 * @param {Array} args.invoices the customer's credit invoices (lean)
 * @param {Map<string, object>} args.returnById credit return logs by id
 * @param {Array} [args.payouts] Stage 19: the customer's credit payouts (a debit line each, and a credit line when cancelled)
 * @param {object|null} [args.opening] the customer's PartyOpening (Stage 18), shown first as the opening line
 * @param {Array} [args.manualLines] Stage 22: the customer's lines of posted manual entries (a credit: a bad debt write-off), see manualLines.service
 * @param {Date|null} [args.from]
 * @param {Date|null} [args.to]
 */
function computeCustomerStatement({ invoices, returnById, opening = null, payouts = [], manualLines = [], from = null, to = null }) {
  const ordered = [...invoices].sort((left, right) =>
    new Date(left.sellingDate) - new Date(right.sellingDate) ||
    new Date(left.createdAt || 0) - new Date(right.createdAt || 0) ||
    String(left._id).localeCompare(String(right._id)));
  const lines = [];
  let sequence = 0;
  // Every line is dated by its LOCAL business day (a date-only value stays as it is, an instant such as a payout or a cancel at 00:30
  // becomes its local day), so lines of one day keep the order they were added in.
  const add = (line) => lines.push({ ...line, date: businessDay(line.date), debit: roundMoney(line.debit), credit: roundMoney(line.credit), _sequence: sequence++ });

  // The opening balance is pinned first whatever date older invoices carry; its date is the ledger start.
  if (opening && Number(opening.amount) !== 0) {
    add({
      date: opening.date, type: "opening_balance", number: opening.number || null, description: "رصيد أول المدة",
      debit: opening.amount > 0 ? opening.amount : 0, credit: opening.amount < 0 ? -opening.amount : 0, _pinned: true,
    });
    for (const payment of opening.payments || []) {
      if (SKIPPED_PAYMENT_SOURCES.has(payment.source)) continue;
      add({ date: payment.paymentDate, type: "payment", number: payment.number, description: "دفعة عميل", debit: 0, credit: payment.amount });
    }
  }

  for (const invoice of ordered) {
    add({
      date: invoice.sellingDate, type: "invoice", number: invoice.number,
      description: `فاتورة آجل ${invoice.number || ""}`.trim(), debit: invoice.totalPrice, credit: 0,
    });
    for (const payment of invoice.payments || []) {
      // return_reallocation, credit_application and manual_entry only move credit between items: the statement shows nothing new
      // (a manual entry shows once, as its own "قيد يدوي" line).
      if (SKIPPED_PAYMENT_SOURCES.has(payment.source)) continue;
      add({
        date: payment.paymentDate, type: "payment", number: payment.number,
        description: payment.source === "down_payment" ? "دفعة مقدمة" : "دفعة عميل",
        debit: 0, credit: payment.amount,
      });
    }
    for (const refund of invoice.refunds || []) {
      const returnLog = refund.returnLog ? returnById.get(refund.returnLog.toString()) : null;
      add({
        date: refund.refundDate, type: "return",
        number: returnLog?.number ?? null,
        description: "مرتجع فاتورة آجل", debit: 0,
        credit: returnLog ? returnLog.finalReturnedAmount : refund.totalAmount,
      });
    }
    if (invoice.status === "cancelled") {
      add({
        date: businessDay(invoice.cancelledAt || invoice.updatedAt), type: "cancel", number: invoice.number,
        description: "إلغاء فاتورة آجل", debit: 0, credit: invoice.totalPrice,
      });
      const downPayment = (invoice.payments || []).find((payment) => payment.source === "down_payment");
      if (Number(invoice.cancelRefundAmount || 0) > 0) {
        add({
          date: businessDay(invoice.cancelledAt || invoice.updatedAt), type: "cancel", number: downPayment?.number || null,
          description: "رد المقدم", debit: invoice.cancelRefundAmount, credit: 0,
        });
      }
    }
  }

  // Stage 19: paying a credit balance out is a debit line; cancelling the payout is a credit line.
  for (const payout of payouts) {
    add({ date: payout.date, type: "payout", number: payout.number, description: "صرف رصيد دائن", debit: payout.amount, credit: 0 });
    if (payout.status === "cancelled") {
      add({ date: businessDay(payout.cancelledAt || payout.updatedAt), type: "payout_cancel", number: payout.number, description: "إلغاء صرف رصيد دائن", debit: 0, credit: payout.amount });
    }
  }

  // Stage 22: posted manual entries. One line when posted; a reversed one adds the mirror line at the reversal date.
  for (const manual of manualLines) {
    add({ date: manual.date, type: "manual", number: manual.number, description: `قيد يدوي ${manual.number || ""}`.trim(), memo: manual.memo || undefined, debit: manual.debit, credit: manual.credit });
  }
  for (const manual of manualLines.filter((entry) => entry.reversal)) {
    add({ date: manual.reversal.date, type: "manual_reversal", number: manual.reversal.number || manual.number, description: `عكس قيد يدوي ${manual.number || ""}`.trim(), memo: manual.reversal.reason || undefined, debit: manual.credit, credit: manual.debit });
  }

  lines.sort((left, right) => (right._pinned ? 1 : 0) - (left._pinned ? 1 : 0)
    || new Date(left.date) - new Date(right.date) || left._sequence - right._sequence);
  const openingBalance = roundMoney(lines.filter((line) => from && new Date(line.date) < from)
    .reduce((balance, line) => balance + line.debit - line.credit, 0));
  const visible = lines.filter((line) => (!from || new Date(line.date) >= from) && (!to || new Date(line.date) <= to));
  let balance = openingBalance;
  const responseLines = [];
  if (from) {
    responseLines.push({ date: from, type: "opening", number: null, description: "رصيد افتتاحي", debit: 0, credit: 0, balance });
  }
  for (const line of visible) {
    balance = roundMoney(balance + line.debit - line.credit);
    const { _sequence, _pinned, ...publicLine } = line;
    responseLines.push({ ...publicLine, balance });
  }
  const totalDebit = roundMoney(visible.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(visible.reduce((sum, line) => sum + line.credit, 0));
  return { lines: responseLines, totals: { openingBalance, debit: totalDebit, credit: totalCredit, balance } };
}

/** Loads one customer's invoices and credit returns, then computes the statement. */
async function loadCustomerStatement(customerId, { from = null, to = null, session = null } = {}) {
  const invoices = await CreditSale.find({ customer: customerId }).sort({ sellingDate: 1, createdAt: 1, _id: 1 }).session(session).lean();
  const returns = await ReturnLog.find({ returnType: "credit", invoiceId: { $in: invoices.map((invoice) => invoice._id) } }).session(session).lean();
  const opening = await PartyOpening.findOne({ partyType: "customer", partyId: customerId }).session(session).lean();
  const payouts = await CustomerPayout.find({ customer: customerId }).sort({ date: 1, createdAt: 1 }).session(session).lean();
  const manualLines = (await loadManualPartyLines("customer", [customerId], { session })).get(String(customerId)) || [];
  const statement = computeCustomerStatement({ invoices, returnById: new Map(returns.map((entry) => [entry._id.toString(), entry])), opening, payouts, manualLines, from, to });
  // Outstanding and aging always describe the open items today, whatever period the statement shows.
  const open = (await loadCustomerOpenItems([customerId], { session })).get(String(customerId)) || { items: [], credit: 0 };
  const aging = ageOpenItems(open.items);
  // The credit is the customer's whole statement balance when it is negative, whatever period the lines above show.
  const fullBalance = from || to
    ? computeCustomerStatement({ invoices, returnById: new Map(returns.map((entry) => [entry._id.toString(), entry])), opening, payouts, manualLines }).totals.balance
    : statement.totals.balance;
  return { ...statement, aging: { ...aging, credit: roundMoney(Math.max(0, -fullBalance)) }, outstanding: aging.total };
}

/**
 * Closing statement balance for every customer in `customers`, from one load of
 * all credit invoices and credit returns. Used by the ledger opening entry and
 * the accounting health check.
 */
async function customerStatementBalances(customers, { session = null } = {}) {
  const [invoices, returns, openings, allPayouts, manualByCustomer] = await Promise.all([
    CreditSale.find({}).session(session).lean(),
    ReturnLog.find({ returnType: "credit" }).session(session).lean(),
    PartyOpening.find({ partyType: "customer" }).session(session).lean(),
    CustomerPayout.find({}).session(session).lean(),
    loadManualPartyLines("customer", null, { session }),
  ]);
  const payoutsByCustomer = new Map();
  for (const payout of allPayouts) {
    const key = String(payout.customer);
    if (!payoutsByCustomer.has(key)) payoutsByCustomer.set(key, []);
    payoutsByCustomer.get(key).push(payout);
  }
  const openingByCustomer = new Map(openings.map((row) => [String(row.partyId), row]));
  const returnById = new Map(returns.map((entry) => [entry._id.toString(), entry]));
  const byCustomer = new Map();
  for (const invoice of invoices) {
    const key = String(invoice.customer);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(invoice);
  }
  const known = new Set(customers.map((customer) => String(customer._id)));
  const orphanInvoices = invoices.filter((invoice) => !known.has(String(invoice.customer)));
  const balances = new Map();
  for (const customer of customers) {
    const statement = computeCustomerStatement({ invoices: byCustomer.get(String(customer._id)) || [], returnById, opening: openingByCustomer.get(String(customer._id)) || null, payouts: payoutsByCustomer.get(String(customer._id)) || [], manualLines: manualByCustomer.get(String(customer._id)) || [] });
    balances.set(String(customer._id), statement.totals.balance);
  }
  return { balances, orphanInvoices };
}

module.exports = { computeCustomerStatement, loadCustomerStatement, customerStatementBalances };
