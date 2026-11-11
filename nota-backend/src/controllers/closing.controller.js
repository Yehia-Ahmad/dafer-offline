const PeriodClose = require("../models/periodClose.model");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const { requiredReason } = require("../cashbox/validate");
const { getLockedThrough, isoDay } = require("../accounting/period");
const closing = require("../accounting/closing");
const { computeHealth } = require("./accounting.controller");

const { httpError } = closing;

// Stage 22: period closing.
//   GET  /api/accounting/lock-date              any signed-in user: the last locked day (the posting forms disable locked dates)
//   GET  /api/accounting/closing                accounting.view: settings, lock date, the next period with its checklist, the history
//   POST /api/accounting/closing/close { periodEnd?, confirm: true }   accounting.close: closes the oldest open period only
//   POST /api/accounting/closing/reopen { reason, confirm: true }      accounting.close and owner only: the latest closed period

const actorOf = (req) => (req.user ? { _id: req.user._id ?? req.user.id, name: req.user.name } : null);

const periodView = (period) => (period ? { start: isoDay(period.start), end: isoDay(period.end), label: period.label, yearEnd: period.yearEnd } : null);
const historyView = (row) => ({
  _id: row._id, label: row.label, periodStart: isoDay(row.periodStart), periodEnd: isoDay(row.periodEnd), status: row.status, yearEnd: row.yearEnd,
  closedAt: row.closedAt, closedByName: row.closedByName || null, entryId: row.entryId || null, entryNumber: row.entryNumber || null, netProfit: row.netProfit ?? null,
  warnings: row.warnings || null, reopenedAt: row.reopenedAt || null, reopenedByName: row.reopenedByName || null, reopenReason: row.reopenReason || null,
  reversalEntryId: row.reversalEntryId || null,
});

const getLockDate = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const locked = await getLockedThrough();
  res.json({ lockedThrough: locked ? isoDay(locked) : null });
};

const getClosing = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const [settings, lockedThrough, history] = await Promise.all([
    closing.loadClosingSettings(), getLockedThrough(), PeriodClose.find({}).sort({ closedAt: -1 }).limit(200).lean(),
  ]);
  const next = await closing.nextPeriodOf({ settings, lockedThrough });
  const todayDay = require("../accounting/manualEntry").today();
  const ended = Boolean(next) && next.end.getTime() < todayDay.getTime();
  const checklist = next ? await closing.buildChecklist(next, { computeHealth }) : null;
  const latestClosed = history.find((row) => row.status === "closed");
  res.json({
    settings, lockedThrough: lockedThrough ? isoDay(lockedThrough) : null,
    next: next ? { ...periodView(next), ended, canClose: ended && checklist.canClose, endsAfter: ended ? null : isoDay(next.end) } : null,
    checklist, history: history.map(historyView), latestClosedId: latestClosed ? latestClosed._id : null,
  });
};

const closePeriod = async (req, res) => {
  const body = req.body || {};
  if (body.confirm !== true) throw httpError(400, "CONFIRM_REQUIRED", "لازم تأكد الإقفال");
  const result = await withTransaction(async (session) => {
    const done = await closing.closeNextPeriod({ expectedEnd: body.periodEnd, actor: actorOf(req), computeHealth, session });
    await audit(req, {
      action: "period.closed", entity: "PeriodClose", entityId: done.close._id,
      details: { period: done.period.label, periodEnd: isoDay(done.period.end), yearEnd: done.period.yearEnd, entry: done.entry?.number || null, netProfit: done.close.netProfit ?? null },
      session, strict: true,
    });
    return done;
  });
  res.json({ close: historyView(result.close), lockedThrough: isoDay(result.period.end), entry: result.entry ? { _id: result.entry._id, number: result.entry.number } : null, warnings: result.checklist.warnings });
};

const reopenPeriod = async (req, res) => {
  const body = req.body || {};
  if (req.authEnabled && req.user?.role !== "owner") throw httpError(403, "OWNER_ONLY", "إعادة فتح الفترة للمالك فقط");
  const reason = requiredReason(body.reason);
  if (body.confirm !== true) throw httpError(400, "CONFIRM_REQUIRED", "لازم تأكد إعادة الفتح");
  const result = await withTransaction(async (session) => {
    const done = await closing.reopenLatestPeriod({ reason, actor: actorOf(req), session });
    await audit(req, {
      action: "period.reopened", entity: "PeriodClose", entityId: done.reopened._id,
      details: { period: done.reopened.label, reason, reversal: done.reversal?.number || null }, session, strict: true,
    });
    return done;
  });
  res.json({ reopened: historyView(result.reopened), lockedThrough: result.lockedThrough ? isoDay(result.lockedThrough) : null, reversal: result.reversal ? { _id: result.reversal._id, number: result.reversal.number } : null });
};

module.exports = { getLockDate, getClosing, closePeriod, reopenPeriod };
