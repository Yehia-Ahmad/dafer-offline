const Selling = require("../models/selling.model");
const CreditSale = require("../models/creditSale.model");
const Receipt = require("../models/receipt.model");
const ReturnLog = require("../models/returnLog.model");
const Transfer = require("../models/transfer.model");
const Expense = require("../models/expense.model");
const OwnerDrawing = require("../models/ownerDrawing.model");
const CustomerPayout = require("../models/customerPayout.model");
const Shift = require("../models/shift.model");
const { roundMoney } = require("../utils/invoicePricing");

// Stage 19: everything that moved money in or out of one box, read ONLY from operational documents
// (never from the ledger). The shift's expected cash and the health "boxes" check both use it, so
// they can only disagree with the ledger when the ledger is wrong.
//
// Each event: { kind, delta, at, ref } where delta is the effect on the box balance.
//   kinds that add:       sales, receipts, transfersIn
//   kinds that subtract:  refunds (returns, cancels, "رد المقدم"), expenses, transfersOut, payouts, drawings
//   shiftDiff: the over/short posted when a shift closed (signed).
// A cancelled expense/transfer/drawing/payout is its original event plus a reversing event at cancelledAt.

const ADDING_KINDS = ["sales", "receipts", "transfersIn"];
const SUBTRACTING_KINDS = ["refunds", "expenses", "transfersOut", "payouts", "drawings"];
const KINDS = [...ADDING_KINDS, ...SUBTRACTING_KINDS];

const within = (date, from, to) => Boolean(date) && (!from || new Date(date) >= from) && (!to || new Date(date) <= to);

/**
 * @param {object} box the CashBox
 * @param {object} options
 * @param {Date|null} options.from events at or after this time (null: all)
 * @param {Date|null} options.to events at or before this time (null: all)
 * @param {Date|null|undefined} options.ledgerStartAt undefined: ignore the ledger start (shift report);
 *   a Date or null (health): only documents the ledger covers count, like the posting rule.
 */
async function boxEvents(box, { from = null, to = null, ledgerStartAt, session = null } = {}) {
  const id = box._id;
  const events = [];
  const checkLedger = ledgerStartAt !== undefined;
  const inLedger = (doc) => !checkLedger || !ledgerStartAt || Boolean(doc.createdAt && new Date(doc.createdAt) >= ledgerStartAt);
  const cancelledInLedger = (doc) => !checkLedger || !ledgerStartAt || Boolean(doc.cancelledAt && new Date(doc.cancelledAt) >= ledgerStartAt);
  const push = (kind, delta, at, ref) => { if (delta && within(at, from, to)) events.push({ kind, delta: roundMoney(delta), at: new Date(at), ref }); };
  // An old document without a box belongs to the main box.
  const own = (field = "boxId") => (box.isMain ? { $or: [{ [field]: id }, { [field]: { $exists: false } }, { [field]: null }] } : { [field]: id });

  const [sales, returns, credits, receipts, transfers, expenses, drawings, payouts, shifts] = await Promise.all([
    Selling.find({ $or: [...(box.isMain ? [{ boxId: id }, { boxId: { $exists: false } }, { boxId: null }] : [{ boxId: id }]), { cancelRefundBoxId: id }] }).select("+ledgerTrace").session(session).lean(),
    ReturnLog.find({ returnType: "cash", ...own() }).session(session).lean(),
    CreditSale.find({ status: "cancelled", cancelRefundAmount: { $gt: 0 }, ...own("cancelRefundBoxId") }).session(session).lean(),
    Receipt.find(own()).session(session).lean(),
    Transfer.find({ $or: [{ toBoxId: id }, { fromBoxId: id }] }).session(session).lean(),
    Expense.find({ boxId: id }).session(session).lean(),
    OwnerDrawing.find({ boxId: id }).session(session).lean(),
    CustomerPayout.find({ boxId: id }).session(session).lean(),
    Shift.find({ boxId: id }).session(session).lean(),
  ]);

  const sid = String(id);
  const here = (value, fallbackHere) => (value ? String(value) === sid : fallbackHere);
  for (const sale of sales) {
    // An old sale without a box belongs to the main box. A cancel refund belongs to its own box (old data: the sale's box).
    const saleHere = here(sale.boxId, box.isMain);
    const moves = sale.boxMoves || [];
    if (saleHere) {
      // The sale at its original total (the stored total is after every edit), then each edit's change at its own time.
      const original = roundMoney(Number(sale.totalPrice || 0) - moves.reduce((sum, move) => sum + Number(move.delta || 0), 0));
      if (inLedger(sale)) push("sales", original, sale.createdAt, sale._id);
    }
    for (const move of moves) if (here(move.boxId, saleHere)) push("sales", Number(move.delta || 0), move.at, sale._id);
    // Pre-ledger invoice: the Stage 17 trace holds EVERY edit's net sales (old ones and the ones in boxMoves). The old
    // ones, from before boxMoves existed, are one older event; the moves above are counted on their own.
    if (saleHere && !inLedger(sale) && checkLedger && sale.ledgerTrace?.editNetSales) {
      push("sales", Number(sale.ledgerTrace.editNetSales) - moves.reduce((sum, move) => sum + Number(move.delta || 0), 0), sale.createdAt, sale._id);
    }
    if (sale.status === "cancelled" && cancelledInLedger(sale) && here(sale.cancelRefundBoxId, saleHere)) push("refunds", -Number(sale.cancelRefundAmount || 0), sale.cancelledAt, sale._id);
  }
  for (const log of returns) if (inLedger(log)) push("refunds", -Number(log.finalReturnedAmount || 0), log.createdAt, log._id);
  for (const invoice of credits) if (cancelledInLedger(invoice)) push("refunds", -Number(invoice.cancelRefundAmount || 0), invoice.cancelledAt, invoice._id);
  for (const receipt of receipts) if (inLedger(receipt)) push("receipts", Number(receipt.amount || 0), receipt.createdAt, receipt._id);

  for (const transfer of transfers) {
    const sign = String(transfer.toBoxId) === String(id) ? 1 : -1;
    const kind = sign > 0 ? "transfersIn" : "transfersOut";
    push(kind, sign * Number(transfer.amount || 0), transfer.createdAt, transfer._id);
    if (transfer.status === "cancelled") push(kind, -sign * Number(transfer.amount || 0), transfer.cancelledAt, transfer._id);
  }
  const outgoing = (rows, kind) => {
    for (const row of rows) {
      push(kind, -Number(row.amount || 0), row.createdAt, row._id);
      if (row.status === "cancelled") push(kind, Number(row.amount || 0), row.cancelledAt, row._id);
    }
  };
  outgoing(expenses, "expenses");
  outgoing(drawings, "drawings");
  outgoing(payouts, "payouts");
  for (const shift of shifts) {
    // The over/short posted when the shift opened with a confirmed float, and when it closed.
    if (Number(shift.openingDifference || 0) !== 0) push("shiftDiff", Number(shift.openingDifference), shift.openedAt, shift._id);
    if (shift.status === "closed" && Number(shift.difference || 0) !== 0) push("shiftDiff", Number(shift.difference), shift.closedAt, shift._id);
  }
  return events;
}

/** Σ delta per kind (every kind present, shiftDiff included). */
const sumByKind = (events) => {
  const totals = Object.fromEntries([...KINDS, "shiftDiff"].map((kind) => [kind, 0]));
  for (const event of events) totals[event.kind] = roundMoney(totals[event.kind] + event.delta);
  return totals;
};

/**
 * Expected cash of an open shift: the opening float + what the box's documents moved since it opened.
 * Lines are positive amounts, as the shift panel shows them.
 */
async function shiftExpected(shift, box, { session = null, to = null } = {}) {
  const events = (await boxEvents(box, { from: shift.openedAt, to, session })).filter((event) => event.kind !== "shiftDiff");
  const totals = sumByKind(events);
  const lines = [
    { key: "float", amount: roundMoney(shift.openingFloat) },
    ...ADDING_KINDS.map((key) => ({ key, amount: totals[key] })),
    ...SUBTRACTING_KINDS.map((key) => ({ key, amount: roundMoney(-totals[key]) })),
  ];
  const expected = roundMoney(shift.openingFloat + KINDS.reduce((sum, kind) => sum + totals[kind], 0));
  return { expected, lines };
}

module.exports = { ADDING_KINDS, SUBTRACTING_KINDS, KINDS, boxEvents, sumByKind, shiftExpected };
