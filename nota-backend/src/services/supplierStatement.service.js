const PartyOpening = require("../models/partyOpening.model");
const Purchase = require("../models/purchase.model");
const SupplierPayment = require("../models/supplierPayment.model");
const PurchaseReturn = require("../models/purchaseReturn.model");
const SupplierRefund = require("../models/supplierRefund.model");
const Meta = require("../models/meta.model");
const clock = require("../utils/clock");
const { roundMoney } = require("../utils/invoicePricing");

// Stage 20: the supplier statement, computed from DOCUMENTS only (never from the ledger). The HTTP handler and the
// accounting health check both call it, so the statement and the health "suppliers" check cannot drift apart.
//
// Lines, oldest first. Credit = we owe more, debit = we owe less. Running balance: positive = we owe the supplier.
//   opening (PartyOpening)      credit when positive, debit when negative (an advance)
//   purchase                    credit; a cancelled purchase adds a debit reversal at cancelledAt
//   payment (PV)                debit;  a cancelled PV adds a credit at cancelledAt
//   purchase return             debit
//   supplier refund (SR)        credit

const DAY_MS = 24 * 60 * 60 * 1000;
const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90plus"];

const bucketOf = (daysOverdue) => {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90plus";
};

/**
 * @param {object} args
 * @param {object} args.supplier the supplier (paymentTermsDays)
 * @param {object|null} args.opening the supplier's PartyOpening
 * @param {Date|null} args.ledgerStartAt the opening's due date
 * @param {Array} args.purchases @param {Array} args.payments @param {Array} args.returns @param {Array} args.refunds
 * @param {Date|null} [args.from] @param {Date|null} [args.to] period of the lines (the balance and the aging are always today's)
 * @param {Date} [args.now]
 */
function computeSupplierStatement({ supplier = {}, opening = null, ledgerStartAt = null, purchases = [], payments = [], returns = [], refunds = [], from = null, to = null, now = clock.now() }) {
  const terms = Number(supplier.paymentTermsDays || 0);
  const events = [];
  let sequence = 0;
  // Every event is dated by its LOCAL business day (an instant becomes its local day); lines of one day sort by creation time.
  const add = (event) => events.push({ ...event, date: clock.businessDay(event.date), debit: roundMoney(event.debit || 0), credit: roundMoney(event.credit || 0), _sequence: sequence++ });

  if (opening && Number(opening.amount) !== 0) {
    add({
      date: opening.date, type: "opening_balance", number: opening.number || null, description: "رصيد أول المدة",
      debit: opening.amount < 0 ? -opening.amount : 0, credit: opening.amount > 0 ? opening.amount : 0,
      due: ledgerStartAt || opening.date, _pinned: true,
    });
  }
  for (const purchase of purchases) {
    add({
      date: purchase.date, createdAt: purchase.createdAt, type: "purchase", number: purchase.number, supplierInvoiceNo: purchase.supplierInvoiceNo || null,
      description: "فاتورة شراء", docId: purchase._id, debit: 0, credit: purchase.total, due: new Date(clock.businessDay(purchase.date).getTime() + terms * DAY_MS),
      noAging: purchase.status === "cancelled",
    });
    if (purchase.status === "cancelled" && purchase.cancelledAt) {
      add({ date: clock.businessDay(purchase.cancelledAt), createdAt: purchase.cancelledAt, noAging: true, type: "purchase_cancel", number: purchase.number, supplierInvoiceNo: purchase.supplierInvoiceNo || null, description: "إلغاء فاتورة شراء", docId: purchase._id, debit: purchase.total, credit: 0 });
    }
  }
  for (const payment of payments) {
    add({ date: payment.date, createdAt: payment.createdAt, type: "payment", number: payment.number, reference: payment.reference || null, description: payment.purchaseId ? "دفعة مع الفاتورة" : "سداد", docId: payment._id, debit: payment.amount, credit: 0, noAging: payment.status === "cancelled" });
    if (payment.status === "cancelled" && payment.cancelledAt) {
      add({ date: clock.businessDay(payment.cancelledAt), createdAt: payment.cancelledAt, noAging: true, type: "payment_cancel", number: payment.number, description: "إلغاء سند صرف", docId: payment._id, debit: 0, credit: payment.amount, due: payment.cancelledAt });
    }
  }
  for (const row of returns) add({ date: row.date, createdAt: row.createdAt, type: "purchase_return", number: row.number, description: "مرتجع مشتريات", docId: row._id, debit: row.total, credit: 0 });
  for (const row of refunds) add({ date: row.date, createdAt: row.createdAt, type: "supplier_refund", number: row.number, description: "استرداد من مورد", docId: row._id, debit: 0, credit: row.amount, due: row.date });

  events.sort((left, right) => (right._pinned ? 1 : 0) - (left._pinned ? 1 : 0)
    || new Date(left.date) - new Date(right.date)
    || new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
    || left._sequence - right._sequence);

  let balance = 0;
  const all = events.map((event) => {
    balance = roundMoney(balance + event.credit - event.debit);
    return { ...event, balance };
  });
  const closing = balance;

  const inPeriod = all.filter((row) => (!from || new Date(row.date) >= from) && (!to || new Date(row.date) <= to));
  const lines = inPeriod.map(({ _sequence, _pinned, due, ...row }) => row);
  const firstIndex = inPeriod.length ? all.indexOf(inPeriod[0]) : all.length;
  const openingBalance = firstIndex > 0 ? all[firstIndex - 1].balance : 0;
  const totals = {
    debit: roundMoney(lines.reduce((sum, row) => sum + row.debit, 0)),
    credit: roundMoney(lines.reduce((sum, row) => sum + row.credit, 0)),
    balance: lines.length ? lines[lines.length - 1].balance : openingBalance,
  };

  // Aging: debits settle the oldest credits first (by due date); what is left is what we owe, by days overdue.
  // A cancelled purchase or payment leaves the aging together with its cancel line (they net to zero).
  const agingRows = all.filter((row) => !row.noAging);
  const credits = agingRows.filter((row) => row.credit > 0).map((row) => ({ amount: row.credit, due: clock.businessDay(row.due || row.date) }))
    .sort((left, right) => left.due - right.due);
  let settle = roundMoney(agingRows.reduce((sum, row) => sum + row.debit, 0));
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0, advance: 0 };
  for (const credit of credits) {
    const used = Math.min(settle, credit.amount);
    settle = roundMoney(settle - used);
    const remaining = roundMoney(credit.amount - used);
    if (remaining <= 0) continue;
    // Days overdue count local calendar days (today's local date as a UTC midnight), never the current instant.
    const overdue = Math.round((clock.localDayAsUtc(now).getTime() - credit.due.getTime()) / DAY_MS);
    aging[bucketOf(overdue)] = roundMoney(aging[bucketOf(overdue)] + remaining);
    aging.total = roundMoney(aging.total + remaining);
  }
  aging.advance = roundMoney(Math.max(0, -closing));

  return { lines, openingBalance, totals, balance: closing, aging };
}

/**
 * Loads every supplier document once. `supplierIds` null = all suppliers. Returns the data grouped per supplier id.
 */
async function loadSupplierDocuments(supplierIds = null, { session = null } = {}) {
  const filter = supplierIds ? { $in: supplierIds } : { $exists: true };
  const [purchases, payments, returns, refunds, openings, meta] = await Promise.all([
    Purchase.find({ supplierId: filter }).session(session).lean(),
    SupplierPayment.find({ supplierId: filter }).session(session).lean(),
    PurchaseReturn.find({ supplierId: filter }).session(session).lean(),
    SupplierRefund.find({ supplierId: filter, status: "posted" }).session(session).lean(),
    PartyOpening.find({ partyType: "supplier", ...(supplierIds ? { partyId: { $in: supplierIds } } : {}) }).session(session).lean(),
    Meta.findById("schema").select("ledgerStartAt").session(session).lean(),
  ]);
  const group = (rows, key) => { const map = new Map(); for (const row of rows) { const id = String(row[key]); if (!map.has(id)) map.set(id, []); map.get(id).push(row); } return map; };
  return {
    purchases: group(purchases, "supplierId"), payments: group(payments, "supplierId"), returns: group(returns, "supplierId"), refunds: group(refunds, "supplierId"),
    openings: new Map(openings.map((row) => [String(row.partyId), row])), ledgerStartAt: meta?.ledgerStartAt ? new Date(meta.ledgerStartAt) : null,
  };
}

const statementFor = (supplier, docs, options = {}) => computeSupplierStatement({
  supplier, opening: docs.openings.get(String(supplier._id)) || null, ledgerStartAt: docs.ledgerStartAt,
  purchases: docs.purchases.get(String(supplier._id)) || [], payments: docs.payments.get(String(supplier._id)) || [],
  returns: docs.returns.get(String(supplier._id)) || [], refunds: docs.refunds.get(String(supplier._id)) || [], ...options,
});

/** Closing statement balance (positive = we owe) per supplier id, from documents. Used by the health check. */
async function supplierStatementBalances(suppliers, { session = null } = {}) {
  const docs = await loadSupplierDocuments(null, { session });
  return new Map(suppliers.map((supplier) => [String(supplier._id), statementFor(supplier, docs).balance]));
}

module.exports = { AGING_BUCKETS, computeSupplierStatement, loadSupplierDocuments, statementFor, supplierStatementBalances };
