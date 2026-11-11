const mongoose = require("mongoose");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const ManualEntryDraft = require("../models/manualEntryDraft.model");
const CashBox = require("../models/cashBox.model");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const { roundMoney } = require("../utils/invoicePricing");
const boxes = require("../cashbox/boxes");

const { httpError, isId, retryable } = boxes;

// Stage 22: shaping the chart of accounts (accounting.manage).
//   GET    /api/accounting/accounts/next-code?parentId=   the code a new child would get, and the type it inherits
//   GET    /api/accounting/accounts/:id/usage              lines, balance, open drafts, what may be done to the account
//   POST   /api/accounting/accounts { parentId, nameAr, nameEn?, isGroup? }
//   PUT    /api/accounting/accounts/:id { nameAr?, nameEn?, parentId?, code? }
//   POST   /api/accounting/accounts/:id/deactivate | /reactivate
//   DELETE /api/accounting/accounts/:id                     only an account that never had lines
//
// Code rule of a new child (a leaf under 520 automatically becomes an expense category, Stage 19):
//   520            5-digit children 52001, 52002, ... (the Stage 19 expense category rule)
//   111 / 112      5-digit children 11101..., 11201... (boxes; created by the box screens, never here)
//   tens scheme    every existing child is a 3-digit multiple of 10 (the 4 and 5 trees): max + 10, up to the next hundred
//   otherwise      max child code + 1 (1 -> 13, 11 -> 116, 12 -> 122, 2 -> 24, 3 -> 34), and it must still start with the parent code
//   empty group    the parent code + "01" (a group a user created), then +1
// A branch that has run out of codes answers 409 CODE_EXHAUSTED.

const MAX_NAME = 120;
const requireName = (value, label) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_NAME) throw httpError(400, "INVALID_NAME", `${label} مطلوب ولا يزيد عن ${MAX_NAME} حرف`);
  return text;
};
const optionalName = (value, label) => {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  return requireName(value, label);
};

/** The next free child code of `parent`, and the rule that produced it. */
const nextChildCode = async (parent, session) => {
  const children = await Account.find({ parentId: parent._id }).select("code").session(session || null).lean();
  const codes = children.map((child) => String(child.code));
  const numeric = codes.map(Number).filter(Number.isFinite);
  let code; let scheme;
  if (parent.code === "520") { const max = Math.max(52000, ...numeric); code = String(max + 1); scheme = "five-digit-520"; }
  else if (parent.code === "111") { const max = Math.max(11101, ...numeric); code = String(max + 1); scheme = "five-digit-box"; }
  else if (parent.code === "112") { const max = Math.max(11200, ...numeric); code = String(max + 1); scheme = "five-digit-box"; }
  else if (!codes.length) { code = `${parent.code}01`; scheme = "first-child"; }
  else if (codes.every((value) => /^\d{3}$/.test(value) && value.endsWith("0"))) {
    const max = Math.max(...numeric); code = String(max + 10); scheme = "tens";
    if (Math.floor(Number(code) / 100) !== Math.floor(max / 100)) throw httpError(409, "CODE_EXHAUSTED", "مفيش أكواد فاضلة تحت الحساب ده", { parentCode: parent.code });
  } else { code = String(Math.max(...numeric) + 1); scheme = "plus-one"; }
  if (!code.startsWith(parent.code)) throw httpError(409, "CODE_EXHAUSTED", "مفيش أكواد فاضلة تحت الحساب ده", { parentCode: parent.code });
  return { code, scheme };
};

const isBoxBranch = (parent) => parent.code === "111" || parent.code === "112";

const loadAccount = async (id, session) => {
  if (!isId(id)) throw httpError(404, "ACCOUNT_NOT_FOUND", "الحساب غير موجود");
  const account = await Account.findById(id).session(session || null);
  if (!account) throw httpError(404, "ACCOUNT_NOT_FOUND", "الحساب غير موجود");
  return account;
};

const usageOf = async (account, session) => {
  const [hasLines, balances, openDrafts, hasChildren, box] = await Promise.all([
    JournalEntry.exists({ "lines.accountId": account._id }).session(session || null),
    boxes.accountBalances([account._id], session),
    ManualEntryDraft.countDocuments({ status: "draft", "lines.accountId": account._id }).session(session || null),
    Account.exists({ parentId: account._id }).session(session || null),
    CashBox.exists({ accountId: account._id }).session(session || null),
  ]);
  const balance = balances.get(String(account._id)) || 0;
  const reasons = [];
  if (account.isSystem) reasons.push("SYSTEM_ACCOUNT");
  if (account.isGroup) reasons.push("GROUP_ACCOUNT");
  if (box) reasons.push("BOX_ACCOUNT");
  if (balance !== 0) reasons.push("HAS_BALANCE");
  if (openDrafts) reasons.push("HAS_OPEN_DRAFTS");
  const canDeactivate = account.isActive && reasons.length === 0;
  const deleteReasons = [...(account.isSystem ? ["SYSTEM_ACCOUNT"] : []), ...(hasLines ? ["HAS_LINES"] : []), ...(hasChildren ? ["HAS_CHILDREN"] : []), ...(box ? ["BOX_ACCOUNT"] : []), ...(openDrafts ? ["HAS_OPEN_DRAFTS"] : [])];
  return {
    hasLines: Boolean(hasLines), balance, openDrafts, hasChildren: Boolean(hasChildren), isBox: Boolean(box),
    canDeactivate, deactivateBlockedBy: account.isActive ? reasons : ["ALREADY_INACTIVE"],
    canReactivate: !account.isActive, canDelete: deleteReasons.length === 0, deleteBlockedBy: deleteReasons,
    canEditStructure: !account.isSystem && !hasLines && !box,
  };
};

const view = (account) => (account.toObject ? account.toObject() : account);

// GET /api/accounting/accounts/next-code?parentId=
const getNextCode = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const parent = await loadAccount(req.query.parentId);
  if (!parent.isGroup) throw httpError(400, "PARENT_NOT_GROUP", "الحساب الأب لازم يكون تجميعي");
  if (isBoxBranch(parent)) throw httpError(400, "BOX_BRANCH", "استخدم شاشة الخزائن");
  res.json({ ...(await nextChildCode(parent)), type: parent.type, normalSide: parent.normalSide, parent: { _id: parent._id, code: parent.code, nameAr: parent.nameAr } });
};

// GET /api/accounting/accounts/:id/usage
const getUsage = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const account = await loadAccount(req.params.id);
  res.json({ account: view(account), ...(await usageOf(account)) });
};

// POST /api/accounting/accounts
const createAccount = async (req, res) => {
  const body = req.body || {};
  const nameAr = requireName(body.nameAr, "اسم الحساب");
  const nameEn = optionalName(body.nameEn, "الاسم بالإنجليزية") || nameAr;
  const isGroup = body.isGroup === true;
  if (body.isGroup !== undefined && typeof body.isGroup !== "boolean") throw httpError(400, "INVALID_GROUP", "قيمة الحساب التجميعي غير صالحة");
  const created = await withTransaction(async (session) => {
    const parent = await loadAccount(body.parentId, session);
    if (!parent.isGroup) throw httpError(400, "PARENT_NOT_GROUP", "الحساب الأب لازم يكون تجميعي");
    if (parent.isActive === false) throw httpError(400, "PARENT_INACTIVE", "الحساب الأب موقوف");
    if (isBoxBranch(parent)) throw httpError(400, "BOX_BRANCH", "استخدم شاشة الخزائن");
    const { code } = await nextChildCode(parent, session);
    let account;
    try {
      [account] = await Account.create([{ code, nameAr, nameEn, type: parent.type, normalSide: parent.normalSide, parentId: parent._id, isGroup, isSystem: false, isActive: true }], { session });
    } catch (error) { throw retryable(error); }
    await audit(req, { action: "account.created", entity: "Account", entityId: account._id, details: { code, nameAr, parent: parent.code, isGroup }, session, strict: true });
    return account;
  });
  res.status(201).json(view(created));
};

// PUT /api/accounting/accounts/:id
const updateAccount = async (req, res) => {
  const body = req.body || {};
  if (body.type !== undefined || body.normalSide !== undefined) throw httpError(400, "TYPE_LOCKED", "نوع الحساب مينفعش يتغير");
  const updated = await withTransaction(async (session) => {
    const account = await loadAccount(req.params.id, session);
    const changes = {};
    if (body.nameAr !== undefined) { account.nameAr = requireName(body.nameAr, "اسم الحساب"); changes.nameAr = account.nameAr; }
    if (body.nameEn !== undefined) { account.nameEn = requireName(body.nameEn, "الاسم بالإنجليزية"); changes.nameEn = account.nameEn; }
    const wantsParent = body.parentId !== undefined && String(body.parentId) !== String(account.parentId || "");
    const wantsCode = body.code !== undefined && String(body.code) !== account.code;
    if (wantsParent || wantsCode) {
      const usage = await usageOf(account, session);
      if (account.isSystem) throw httpError(409, "SYSTEM_ACCOUNT", "كود وأب الحساب ده ثابتين لأنه حساب نظام");
      if (usage.isBox) throw httpError(409, "BOX_ACCOUNT", "الحساب ده خزنة. غيّره من شاشة الخزائن");
      if (usage.hasLines) throw httpError(409, "ACCOUNT_HAS_LINES", "الحساب عليه قيود. مينفعش يتغير كوده أو الحساب الأب بتاعه");
      if (wantsParent) {
        const parent = await loadAccount(body.parentId, session);
        if (!parent.isGroup || parent.isActive === false) throw httpError(400, "PARENT_NOT_GROUP", "الحساب الأب لازم يكون تجميعي ونشط");
        if (isBoxBranch(parent)) throw httpError(400, "BOX_BRANCH", "استخدم شاشة الخزائن");
        if (parent.type !== account.type) throw httpError(400, "TYPE_LOCKED", "نوع الحساب مينفعش يتغير");
        if (String(parent._id) === String(account._id)) throw httpError(400, "INVALID_PARENT", "الحساب الأب غير صالح");
        // not under itself
        for (let cursor = parent; cursor && cursor.parentId; cursor = await Account.findById(cursor.parentId).session(session)) {
          if (String(cursor.parentId) === String(account._id)) throw httpError(400, "INVALID_PARENT", "الحساب الأب غير صالح");
        }
        account.parentId = parent._id; changes.parentId = parent._id;
        if (!wantsCode) { account.code = (await nextChildCode(parent, session)).code; changes.code = account.code; }
      }
      if (wantsCode) {
        const code = String(body.code).trim();
        if (!/^\d{1,8}$/.test(code)) throw httpError(400, "INVALID_CODE", "الكود أرقام بس (حتى 8 أرقام)");
        const parent = await Account.findById(account.parentId).session(session);
        if (parent && !code.startsWith(parent.code)) throw httpError(400, "INVALID_CODE", `الكود لازم يبدأ بكود الحساب الأب ${parent.code}`);
        if (await Account.exists({ code, _id: { $ne: account._id } }).session(session)) throw httpError(409, "CODE_EXISTS", "الكود ده مستخدم");
        account.code = code; changes.code = code;
      }
    }
    if (!Object.keys(changes).length) return account;
    try { await account.save({ session }); } catch (error) { throw retryable(error); }
    await audit(req, { action: "account.updated", entity: "Account", entityId: account._id, details: changes, session, strict: true });
    return account;
  });
  res.json(view(updated));
};

// POST /api/accounting/accounts/:id/deactivate
const deactivateAccount = async (req, res) => {
  const updated = await withTransaction(async (session) => {
    const account = await loadAccount(req.params.id, session);
    if (!account.isActive) throw httpError(409, "ALREADY_INACTIVE", "الحساب موقوف بالفعل");
    const usage = await usageOf(account, session);
    if (account.isSystem) throw httpError(409, "SYSTEM_ACCOUNT", "حساب نظام ومينفعش يتوقف");
    if (account.isGroup) throw httpError(409, "GROUP_ACCOUNT", "الحساب التجميعي مينفعش يتوقف");
    if (usage.isBox) throw httpError(409, "BOX_ACCOUNT", "الحساب ده خزنة. أوقفها من شاشة الخزائن");
    if (usage.balance !== 0) throw httpError(409, "HAS_BALANCE", "الحساب عليه رصيد. صفّره الأول", { balance: roundMoney(usage.balance) });
    if (usage.openDrafts) throw httpError(409, "HAS_OPEN_DRAFTS", "فيه قيود يدوية مسودة بتستخدم الحساب ده", { drafts: usage.openDrafts });
    account.isActive = false;
    await account.save({ session });
    await audit(req, { action: "account.deactivated", entity: "Account", entityId: account._id, details: { code: account.code }, session, strict: true });
    return account;
  });
  res.json(view(updated));
};

// POST /api/accounting/accounts/:id/reactivate
const reactivateAccount = async (req, res) => {
  const updated = await withTransaction(async (session) => {
    const account = await loadAccount(req.params.id, session);
    if (account.isActive) throw httpError(409, "ALREADY_ACTIVE", "الحساب شغال بالفعل");
    account.isActive = true;
    await account.save({ session });
    await audit(req, { action: "account.reactivated", entity: "Account", entityId: account._id, details: { code: account.code }, session, strict: true });
    return account;
  });
  res.json(view(updated));
};

// DELETE /api/accounting/accounts/:id
const deleteAccount = async (req, res) => {
  await withTransaction(async (session) => {
    const account = await loadAccount(req.params.id, session);
    const usage = await usageOf(account, session);
    if (account.isSystem) throw httpError(409, "SYSTEM_ACCOUNT", "حساب نظام ومينفعش يتمسح");
    if (usage.isBox) throw httpError(409, "BOX_ACCOUNT", "الحساب ده خزنة");
    if (usage.hasChildren) throw httpError(409, "HAS_CHILDREN", "تحت الحساب ده حسابات تانية");
    if (usage.hasLines) throw httpError(409, "ACCOUNT_HAS_LINES", "الحساب اتسجل عليه قيود قبل كده. وقّفه بدل ما تمسحه");
    if (usage.openDrafts) throw httpError(409, "HAS_OPEN_DRAFTS", "فيه قيود يدوية مسودة بتستخدم الحساب ده", { drafts: usage.openDrafts });
    await Account.deleteOne({ _id: account._id }, { session });
    await audit(req, { action: "account.deleted", entity: "Account", entityId: account._id, details: { code: account.code, nameAr: account.nameAr }, session, strict: true });
  });
  res.status(204).end();
};

module.exports = { getNextCode, getUsage, createAccount, updateAccount, deactivateAccount, reactivateAccount, deleteAccount, nextChildCode };
