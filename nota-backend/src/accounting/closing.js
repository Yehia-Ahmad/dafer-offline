// Stage 22: period closing. meta.closing.lockedThrough locks every business date on or before it (accounting/period.js). A period is a
// calendar month (frequency "monthly") or a whole fiscal year ("yearly"; the rest of a fiscal year whose first months were closed
// monthly). Periods close in order, oldest open first, only after they ended (local time). A period that ends on the fiscal year end
// also posts the year-end closing entry (type "closing", source period_close): every revenue and expense account and the owner
// drawings are zeroed into RETAINED_EARNINGS (32).
const mongoose = require("mongoose");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const Meta = require("../models/meta.model");
const PeriodClose = require("../models/periodClose.model");
const ManualEntryDraft = require("../models/manualEntryDraft.model");
const Shift = require("../models/shift.model");
const CashBox = require("../models/cashBox.model");
const ShopProfile = require("../models/shopProfile.model");
const VatReturn = require("../models/vatReturn.model");
const Customer = require("../models/customer.model");
const Supplier = require("../models/supplier.model");
const { postEntry, line, accountMap, reverseEntry } = require("./posting");
const { getLockedThrough, localStartOf, localEndOf, isoDay } = require("./period");
const { loadVatSettings } = require("./vat");
const { customerStatementBalances } = require("../services/customerStatement.service");
const { supplierStatementBalances } = require("../services/supplierStatement.service");
const { businessDay, localDayAsUtc, now } = require("../utils/clock");
const { roundMoney } = require("../utils/invoicePricing");

const httpError = (statusCode, code, message, extra = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code, ...extra };
  return error;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (value) => String(value).padStart(2, "0");
const DEFAULT_CLOSING = Object.freeze({ frequency: "monthly", fiscalYearStartMonth: 1 });

const loadClosingSettings = async (session = null) => {
  const profile = await ShopProfile.findOne({ key: "default" }).select("closing").session(session).lean();
  return { ...DEFAULT_CLOSING, ...(profile?.closing || {}) };
};

const utc = (year, monthIndex, day) => new Date(Date.UTC(year, monthIndex, day));
const addDays = (day, count) => new Date(day.getTime() + count * DAY_MS);
const monthBounds = (day) => ({ start: utc(day.getUTCFullYear(), day.getUTCMonth(), 1), end: utc(day.getUTCFullYear(), day.getUTCMonth() + 1, 0) });

/** The fiscal year containing `day`: it starts on the 1st of fiscalYearStartMonth and ends on the last day of the month before it. */
const fiscalYearOf = (day, startMonth) => {
  const year = day.getUTCMonth() + 1 >= startMonth ? day.getUTCFullYear() : day.getUTCFullYear() - 1;
  return { start: utc(year, startMonth - 1, 1), end: utc(year + 1, startMonth - 1, 0) };
};

const isFiscalYearEnd = (day, startMonth) => fiscalYearOf(day, startMonth).end.getTime() === day.getTime();

/** The oldest open period: { start, end, label, yearEnd } or null when there is no entry yet. */
const nextPeriodOf = async ({ settings, lockedThrough, session = null }) => {
  let from;
  if (lockedThrough) from = addDays(lockedThrough, 1);
  else {
    const first = await JournalEntry.findOne({ status: "posted" }).sort({ date: 1 }).select("date").session(session).lean();
    if (!first) return null;
    from = businessDay(first.date);
  }
  let start; let end;
  if (settings.frequency === "yearly") {
    const fiscal = fiscalYearOf(from, settings.fiscalYearStartMonth);
    start = lockedThrough ? from : fiscal.start; end = fiscal.end;
  } else {
    const month = monthBounds(from);
    start = lockedThrough ? from : month.start; end = month.end;
  }
  const label = settings.frequency === "yearly" ? `FY${end.getUTCFullYear()}` : `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}`;
  return { start, end, label, yearEnd: isFiscalYearEnd(end, settings.fiscalYearStartMonth) };
};

const today = () => localDayAsUtc(now());

// ---------------------------------------------------------------- the pre-close checklist

/**
 * { blocking: [{ key, ok, items?, ... }], warnings: [...], canClose }. computeHealth is passed in (the accounting controller owns it).
 * Blocking: an open shift opened on/before the period end, unposted manual drafts dated in the period, any non-zero health check,
 * unfiled VAT months in the period (VAT on), the opening balance not finalized.
 */
const buildChecklist = async (period, { computeHealth, session = null }) => {
  const periodEndLocal = localEndOf(period.end);
  const [shifts, drafts, meta, vat, filed] = await Promise.all([
    Shift.find({ status: "open", openedAt: { $lte: periodEndLocal } }).select("number boxId openedAt").session(session).lean(),
    ManualEntryDraft.find({ status: "draft", date: { $lte: period.end } }).select("memo date").session(session).lean(),
    Meta.findById("schema").select("opening").session(session).lean(),
    loadVatSettings(session),
    VatReturn.find({ status: "filed" }).select("period").session(session).lean(),
  ]);
  let health = await computeHealth();
  // A posting can commit between the snapshot above and the health read: before reporting a difference, read health once more.
  // Only a difference that is still there on the second run blocks the close.
  const hasDifference = (result) => Object.values(result).some((check) => Number(check.difference || 0) !== 0 || check.ok === false);
  if (hasDifference(health)) health = await computeHealth();
  const boxes = await CashBox.find({ _id: { $in: shifts.map((shift) => shift.boxId) } }).select("name").lean();
  const boxName = new Map(boxes.map((box) => [String(box._id), box.name]));
  const failing = Object.entries(health).filter(([, check]) => Number(check.difference || 0) !== 0 || check.ok === false).map(([name, check]) => ({ name, difference: roundMoney(check.difference || 0) }));
  const unfiled = [];
  if (vat.enabled && vat.startDate) {
    const filedSet = new Set(filed.map((row) => row.period));
    const startMonth = businessDay(vat.startDate);
    for (let cursor = utc(period.start.getUTCFullYear(), period.start.getUTCMonth(), 1); cursor.getTime() <= period.end.getTime(); cursor = utc(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)) {
      const month = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}`;
      if (cursor.getTime() < utc(startMonth.getUTCFullYear(), startMonth.getUTCMonth(), 1).getTime()) continue;
      if (!filedSet.has(month)) unfiled.push(month);
    }
  }
  const finalized = meta?.opening?.status === "finalized";
  const blocking = [
    { key: "openShifts", ok: shifts.length === 0, items: shifts.map((shift) => ({ number: shift.number, box: boxName.get(String(shift.boxId)) || null, openedAt: shift.openedAt })) },
    { key: "manualDrafts", ok: drafts.length === 0, items: drafts.map((draft) => ({ _id: draft._id, memo: draft.memo, date: draft.date })) },
    { key: "health", ok: failing.length === 0, items: failing },
    ...(vat.enabled ? [{ key: "vatUnfiled", ok: unfiled.length === 0, items: unfiled }] : []),
    { key: "openingNotFinalized", ok: finalized },
  ];
  const [customers, suppliers] = await Promise.all([Customer.find({}).select("_id").lean(), Supplier.find({}).select("_id paymentTermsDays").lean()]);
  const customerBalances = (await customerStatementBalances(customers)).balances;
  const supplierBalances = await supplierStatementBalances(suppliers);
  const nonZero = (map) => [...map.values()].filter((value) => roundMoney(value) !== 0);
  const warnings = [
    { key: "customerBalances", count: nonZero(customerBalances).length, total: roundMoney(nonZero(customerBalances).reduce((sum, value) => sum + value, 0)) },
    { key: "supplierBalances", count: nonZero(supplierBalances).length, total: roundMoney(nonZero(supplierBalances).reduce((sum, value) => sum + value, 0)) },
  ];
  return { blocking, warnings, canClose: blocking.every((item) => item.ok) };
};

// ---------------------------------------------------------------- the year-end closing entry

/** Revenue and expense accounts and the owner drawings: balances (debit - credit) as of the end of `day`, from the ledger. */
const profitAndLossBalances = async (day, session) => {
  const accounts = await Account.find({ $or: [{ type: { $in: ["revenue", "expense"] } }, { systemKey: "OWNER_DRAWINGS" }], isGroup: false }).session(session).lean();
  const ids = accounts.map((account) => account._id);
  const rows = ids.length ? await JournalEntry.aggregate([
    { $match: { status: "posted", date: { $lte: localEndOf(day) }, "lines.accountId": { $in: ids } } }, { $unwind: "$lines" }, { $match: { "lines.accountId": { $in: ids } } },
    { $group: { _id: "$lines.accountId", balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ]).session(session) : [];
  const balance = new Map(rows.map((row) => [String(row._id), roundMoney(row.balance)]));
  return accounts.map((account) => ({ account, balance: balance.get(String(account._id)) || 0 })).filter((row) => row.balance !== 0);
};

/** Posts the year-end entry of `close`. Returns { entry, netProfit } (entry null when there is nothing to close). */
const postYearEndEntry = async ({ close, period, actor, session }) => {
  const balances = await profitAndLossBalances(period.end, session);
  const retained = (await accountMap(["RETAINED_EARNINGS"], session)).get("RETAINED_EARNINGS");
  const lines = [];
  let profit = 0; let drawings = 0; let drawingsAccount = null;
  for (const { account, balance } of balances) {
    if (account.systemKey === "OWNER_DRAWINGS") { drawings = balance; drawingsAccount = account; continue; }
    profit = roundMoney(profit - balance); // credit-positive: a net credit balance is profit
    lines.push(line(account, Math.abs(balance), balance > 0 ? "credit" : "debit"));
  }
  if (drawings !== 0) lines.push(line(drawingsAccount, Math.abs(drawings), drawings > 0 ? "credit" : "debit"));
  if (profit !== 0) lines.push(line(retained, Math.abs(profit), profit > 0 ? "credit" : "debit", { description: profit > 0 ? "صافي ربح السنة" : "صافي خسارة السنة" }));
  if (drawings !== 0) lines.push(line(retained, Math.abs(drawings), drawings > 0 ? "debit" : "credit", { description: "إقفال جاري المالك" }));
  const entry = await postEntry({
    date: period.end, type: "closing", source: { type: "period_close", id: close._id, number: period.label }, memo: `إقفال ${period.label}`,
    lines, session, allowLocked: true, createdBy: actor?._id || null, createdByName: actor?.name || null,
  });
  return { entry, netProfit: profit };
};

// ---------------------------------------------------------------- close / reopen

const toDay = (value) => {
  const text = typeof value === "string" ? value : "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw httpError(400, "INVALID_PERIOD", "نهاية الفترة غير صالحة (YYYY-MM-DD)");
  return utc(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

/** Closes the oldest open period. `expectedEnd` (YYYY-MM-DD) is what the screen showed: another PC may have closed it meanwhile. */
const closeNextPeriod = async ({ expectedEnd, actor, computeHealth, session }) => {
  const settings = await loadClosingSettings(session);
  const lockedThrough = await getLockedThrough(session);
  const period = await nextPeriodOf({ settings, lockedThrough, session });
  if (!period) throw httpError(409, "NOTHING_TO_CLOSE", "مفيش قيود تتقفل");
  if (expectedEnd && isoDay(period.end) !== isoDay(toDay(expectedEnd))) {
    throw httpError(409, "PERIOD_CHANGED", "الفترة المطلوب إقفالها اتغيرت. حدّث الصفحة", { nextPeriodEnd: isoDay(period.end) });
  }
  if (period.end.getTime() >= today().getTime()) throw httpError(409, "PERIOD_NOT_ENDED", "الفترة لسه ما خلصتش", { periodEnd: isoDay(period.end) });
  const checklist = await buildChecklist(period, { computeHealth, session });
  if (!checklist.canClose) throw httpError(409, "CHECKLIST_BLOCKED", "فيه حاجات لازم تتحل قبل الإقفال", { checklist });
  // Writing the meta document conflicts with any back-dated posting running now (assertOpenDate touches it), so one of the two retries.
  const closedAt = new Date();
  const [close] = await PeriodClose.create([{
    periodStart: period.start, periodEnd: period.end, label: period.label, yearEnd: period.yearEnd, status: "closed", closedAt,
    closedBy: actor?._id, closedByName: actor?.name, warnings: checklist.warnings,
  }], { session });
  let entry = null; let netProfit;
  if (period.yearEnd) {
    ({ entry, netProfit } = await postYearEndEntry({ close, period, actor, session }));
    close.entryId = entry?._id; close.entryNumber = entry?.number; close.netProfit = netProfit;
    await close.save({ session });
  }
  await Meta.collection.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": period.end }, $currentDate: { "closing.touchedAt": true } }, { session });
  return { close, period, entry, checklist };
};

/** Reopens the latest closed period: the lock moves back to the previous one and a year-end closing entry is reversed (linked). */
const reopenLatestPeriod = async ({ reason, actor, session }) => {
  const closes = await PeriodClose.find({ status: "closed" }).sort({ periodEnd: -1 }).limit(2).session(session);
  if (!closes.length) throw httpError(409, "NOTHING_TO_REOPEN", "مفيش فترة مقفولة");
  const [latest, previous] = closes;
  let reversal = null;
  if (latest.entryId) {
    reversal = await reverseEntry(latest.entryId, { date: latest.periodEnd, memo: `إعادة فتح ${latest.label}: ${reason}`, session, allowLocked: true });
    latest.reversalEntryId = reversal?._id;
  }
  latest.status = "reopened"; latest.reopenedAt = new Date(); latest.reopenedBy = actor?._id; latest.reopenedByName = actor?.name; latest.reopenReason = reason;
  await latest.save({ session });
  if (previous) await Meta.collection.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": previous.periodEnd }, $currentDate: { "closing.touchedAt": true } }, { session });
  else await Meta.collection.updateOne({ _id: "schema" }, { $unset: { "closing.lockedThrough": "" }, $currentDate: { "closing.touchedAt": true } }, { session });
  return { reopened: latest, reversal, lockedThrough: previous ? previous.periodEnd : null };
};

module.exports = {
  DEFAULT_CLOSING, loadClosingSettings, fiscalYearOf, isFiscalYearEnd, nextPeriodOf, buildChecklist, profitAndLossBalances, postYearEndEntry,
  closeNextPeriod, reopenLatestPeriod, httpError, localStartOf,
};
