const CreditSale = require("../models/creditSale.model");
const PartyOpening = require("../models/partyOpening.model");
const { roundMoney } = require("../utils/invoicePricing");

// Stage 18: the single source of "what does each customer still owe". The
// statement aging, both payment routes, the customer list, the dashboard
// outstanding and the health check all read open items from here, so a
// customer opening balance (PartyOpening) can never be counted in one place and
// missed in another. An opening is never a sale: it only ever appears here.

const OPEN_CREDIT_SALE_STATUSES = ["pending", "partially_paid"];
const DAY_MS = 24 * 60 * 60 * 1000;

const collectedOf = (opening) => roundMoney((opening.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
/** What is still collectable on a customer opening (a negative opening is a credit, nothing to collect). */
const openingRemaining = (opening) => (opening && opening.amount > 0 ? roundMoney(Math.max(0, opening.amount - collectedOf(opening))) : 0);

/**
 * Open items for the given customers (all customers when `customerIds` is null),
 * as Map(customerId -> { items, credit }). `items` are oldest first with the
 * opening pinned first (it is the oldest debt by definition). `credit` is the
 * customer's negative opening (we owe them), shown as credit, never as debt.
 */
async function loadCustomerOpenItems(customerIds = null, { session = null } = {}) {
  const customerFilter = customerIds ? { customer: { $in: customerIds } } : {};
  const [invoices, openings] = await Promise.all([
    CreditSale.find({ ...customerFilter, remainingAmount: { $gt: 0 }, status: { $in: OPEN_CREDIT_SALE_STATUSES } })
      .select("customer number sellingDate dueDate remainingAmount createdAt").sort({ sellingDate: 1, createdAt: 1, _id: 1 }).session(session).lean(),
    PartyOpening.find({ partyType: "customer", ...(customerIds ? { partyId: { $in: customerIds } } : {}) }).session(session).lean(),
  ]);
  const result = new Map();
  const entry = (id) => {
    const key = String(id);
    if (!result.has(key)) result.set(key, { items: [], credit: 0 });
    return result.get(key);
  };
  for (const opening of openings) {
    if (opening.amount < 0) { entry(opening.partyId).credit = roundMoney(-opening.amount); continue; }
    const remaining = openingRemaining(opening);
    if (remaining > 0) entry(opening.partyId).items.push({ kind: "opening", id: opening._id, number: opening.number || null, date: opening.date, dueDate: null, remaining });
  }
  for (const invoice of invoices) {
    entry(invoice.customer).items.push({ kind: "invoice", id: invoice._id, number: invoice.number || null, date: invoice.sellingDate, dueDate: invoice.dueDate || null, remaining: roundMoney(invoice.remainingAmount) });
  }
  return result;
}

/** Overdue days of an item at `now`: the opening ages from its date, an invoice from dueDate (else sellingDate). */
const overdueDays = (item, now) => {
  const clock = require("../utils/clock");
  const due = clock.businessDay(item.kind === "invoice" ? (item.dueDate || item.date) : item.date);
  // local calendar days: today's local date as a UTC midnight, not the current instant
  return Math.round((clock.localDayAsUtc(now).getTime() - due.getTime()) / DAY_MS);
};

/** Buckets: current (not overdue), 1-30, 31-60 and more than 60 days overdue. */
function ageOpenItems(items, now = require("../utils/clock").now()) {
  const aging = { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 };
  for (const item of items) {
    const days = overdueDays(item, now);
    const key = days <= 0 ? "current" : days <= 30 ? "days1to30" : days <= 60 ? "days31to60" : "over60";
    aging[key] = roundMoney(aging[key] + item.remaining);
    aging.total = roundMoney(aging.total + item.remaining);
  }
  return aging;
}

/** Collection order. firstInvoice: oldest first (opening first). lastInvoice: newest first (opening last). */
const sortForCollection = (items, selection) => {
  const invoices = items.filter((item) => item.kind === "invoice");
  const openings = items.filter((item) => item.kind === "opening");
  return selection === "lastInvoice" ? [...[...invoices].reverse(), ...openings] : [...openings, ...invoices];
};

module.exports = { OPEN_CREDIT_SALE_STATUSES, collectedOf, openingRemaining, loadCustomerOpenItems, ageOpenItems, overdueDays, sortForCollection };
