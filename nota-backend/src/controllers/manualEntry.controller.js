const ManualEntryDraft = require("../models/manualEntryDraft.model");
const Account = require("../models/account.model");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const { roundMoney } = require("../utils/invoicePricing");
const { requiredReason } = require("../cashbox/validate");
const manual = require("../accounting/manualEntry");

const { httpError, isId } = manual;

// Stage 22: manual journal entries (accounting.manage).
//   GET    /api/accounting/manual-entries/accounts   the accounts the form may use (blocked ones carry the reason)
//   GET    /api/accounting/manual-entries            drafts and posted manual entries
//   POST   /api/accounting/manual-entries            save a draft (lines may be incomplete or unbalanced)
//   GET/PUT/DELETE /api/accounting/manual-entries/:id   a draft only for PUT/DELETE
//   POST   /api/accounting/manual-entries/:id/post   validate and post (one transaction)
//   POST   /api/accounting/manual-entries/:id/reverse { reason, date? }

const actorOf = (req) => (req.user ? { _id: req.user._id ?? req.user.id, name: req.user.name } : null);

const totalsOf = (draft) => ({
  totalDebit: roundMoney((draft.lines || []).reduce((sum, row) => sum + Number(row.debit || 0), 0)),
  totalCredit: roundMoney((draft.lines || []).reduce((sum, row) => sum + Number(row.credit || 0), 0)),
});

const view = (draft, accounts) => {
  const plain = draft.toObject ? draft.toObject() : draft;
  return {
    ...plain,
    ...totalsOf(plain),
    lines: (plain.lines || []).map((row) => {
      const account = accounts && accounts.get(String(row.accountId));
      return { ...row, accountCode: account?.code || null, accountNameAr: account?.nameAr || null, accountNameEn: account?.nameEn || null };
    }),
  };
};

const accountMapFor = async (drafts) => {
  const ids = [...new Set(drafts.flatMap((draft) => (draft.lines || []).map((row) => String(row.accountId))))];
  const rows = await Account.find({ _id: { $in: ids } }).select("code nameAr nameEn").lean();
  return new Map(rows.map((row) => [String(row._id), row]));
};

const getAccountOptions = async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await manual.accountOptions() });
};

const listEntries = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const filter = {};
  if (req.query.status === "draft" || req.query.status === "posted") filter.status = req.query.status;
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [rows, totalItems] = await Promise.all([
    ManualEntryDraft.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ManualEntryDraft.countDocuments(filter),
  ]);
  res.json({ data: rows.map((row) => view(row, null)), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

const loadEntry = async (id) => {
  if (!isId(id)) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  const draft = await ManualEntryDraft.findById(id);
  if (!draft) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  return draft;
};

const getEntry = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const draft = await loadEntry(req.params.id);
  res.json(view(draft, await accountMapFor([draft])));
};

const createDraft = async (req, res) => {
  const data = manual.parseDraftBody(req.body);
  const draft = await ManualEntryDraft.create({ status: "draft", date: data.date, memo: data.memo || "", lines: data.lines || [] });
  res.status(201).json(view(draft, await accountMapFor([draft])));
};

const updateDraft = async (req, res) => {
  const data = manual.parseDraftBody(req.body, { partial: true });
  const draft = await withTransaction(async (session) => {
    const current = await ManualEntryDraft.findById(req.params.id).session(session);
    if (!current) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
    if (current.status !== "draft") throw httpError(409, "NOT_DRAFT", "القيد المرحّل مينفعش يتعدّل. اعمل قيد عكسي");
    if (data.date !== undefined) current.date = data.date;
    if (data.memo !== undefined) current.memo = data.memo;
    if (data.lines !== undefined) current.lines = data.lines;
    return current.save({ session });
  });
  res.json(view(draft, await accountMapFor([draft])));
};

const deleteDraft = async (req, res) => {
  if (!isId(req.params.id)) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  const removed = await ManualEntryDraft.findOneAndDelete({ _id: req.params.id, status: "draft" });
  if (!removed) {
    const exists = await ManualEntryDraft.exists({ _id: req.params.id });
    throw exists ? httpError(409, "NOT_DRAFT", "القيد المرحّل مينفعش يتمسح. اعمل قيد عكسي") : httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  }
  res.status(204).end();
};

const postEntryHandler = async (req, res) => {
  const result = await withTransaction(async (session) => {
    const posted = await manual.postDraft(req.params.id, { session, actor: actorOf(req) });
    await audit(req, {
      action: "manual_entry.posted", entity: "ManualEntry", entityId: posted.draft._id,
      details: { number: posted.draft.number, memo: posted.draft.memo, ...totalsOf(posted.draft), allocated: roundMoney(posted.allocations.reduce((sum, row) => sum + row.amount, 0)) },
      session, strict: true,
    });
    return posted;
  });
  res.json({ ...view(result.draft, await accountMapFor([result.draft])), entry: { _id: result.entry._id, number: result.entry.number } });
};

const reverseEntryHandler = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  const result = await withTransaction(async (session) => {
    const reversed = await manual.reverseDraft(req.params.id, { reason, date: req.body && req.body.date, session, actor: actorOf(req) });
    await audit(req, { action: "manual_entry.reversed", entity: "ManualEntry", entityId: reversed.draft._id, details: { number: reversed.draft.number, reversal: reversed.reversal.number, reason }, session, strict: true });
    return reversed;
  });
  const shown = view(result.draft, await accountMapFor([result.draft]));
  res.json({ ...shown, reversal: { ...shown.reversal, _id: result.reversal._id } });
};

module.exports = { getAccountOptions, listEntries, getEntry, createDraft, updateDraft, deleteDraft, postEntry: postEntryHandler, reverseEntry: reverseEntryHandler };
