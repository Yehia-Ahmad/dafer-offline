const mongoose = require("mongoose");
const Account = require("../models/account.model");
const CashBox = require("../models/cashBox.model");
const Expense = require("../models/expense.model");
const JournalEntry = require("../models/journalEntry.model");
const { postEntry, line, boxAccount, accountMap } = require("../accounting/posting");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { can } = require("./cashbox.controller");
const { positiveAmount, optionalDate, optionalText, requiredReason, requiredName } = require("../cashbox/validate");
const { loadVatSettings, vatContext, periodFor, recordVatEvent } = require("../accounting/vat");

const { httpError, isId } = boxes;

// Stage 19: expenses. A category is a leaf account under 520 (521-525 are seeded, a new one is 526, 527, ...).
// An expense posts Dr category / Cr box, from a box that covers it (and has an open shift when it uses shifts).

const loadParent = (session) => Account.findOne({ code: "520" }).session(session || null).lean();

const categoryView = (account, usedIds) => ({
  _id: account._id, code: account.code, nameAr: account.nameAr, nameEn: account.nameEn,
  isSystem: Boolean(account.isSystem), isActive: account.isActive !== false, hasLines: usedIds ? usedIds.has(String(account._id)) : undefined,
});

const categoriesWithUsage = async () => {
  const parent = await loadParent();
  if (!parent) return [];
  // Numeric order: the seeded 521-525 first, then 52001, 52002, ...
  const accounts = (await Account.find({ parentId: parent._id, isGroup: false }).lean()).sort((left, right) => Number(left.code) - Number(right.code));
  const used = await JournalEntry.aggregate([
    { $match: { "lines.accountId": { $in: accounts.map((account) => account._id) } } },
    { $unwind: "$lines" }, { $match: { "lines.accountId": { $in: accounts.map((account) => account._id) } } },
    { $group: { _id: "$lines.accountId" } },
  ]);
  const usedIds = new Set(used.map((row) => String(row._id)));
  return accounts.map((account) => categoryView(account, usedIds));
};

// GET /api/expenses/categories
const getCategories = async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await categoriesWithUsage() });
};

// POST /api/expenses/categories { nameAr, nameEn? } (expenses.manage)
const createCategory = async (req, res) => {
  const nameAr = requiredName(req.body && req.body.nameAr, "اسم البند");
  const nameEn = req.body && req.body.nameEn ? requiredName(req.body.nameEn, "الاسم بالإنجليزية") : nameAr;
  const created = await withTransaction(async (session) => {
    // 5-digit children of 520 (52001, 52002, ...), like the 112xx banks: they can never run into 530 and above.
    const { parent, code } = await boxes.nextLeafCode("520", 52000, session);
    const [account] = await Account.create([{ code, nameAr, nameEn, type: "expense", normalSide: "debit", parentId: parent._id, isGroup: false, isSystem: false, isActive: true }], { session });
    await audit(req, { action: "expense.category.created", entity: "Account", entityId: account._id, details: { code, nameAr }, session, strict: true });
    return account;
  });
  res.status(201).json(categoryView(created.toObject(), new Set()));
};

// PUT /api/expenses/categories/:id { nameAr?, nameEn?, isActive? } (expenses.manage)
const updateCategory = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error("البند غير موجود"); }
  const body = req.body || {};
  const updated = await withTransaction(async (session) => {
    const parent = await loadParent(session);
    const account = await Account.findById(req.params.id).session(session);
    if (!account || !parent || String(account.parentId) !== String(parent._id)) throw httpError(404, "CATEGORY_NOT_FOUND", "البند غير موجود");
    const changes = {};
    if (body.nameAr !== undefined || body.nameEn !== undefined) {
      if (account.isSystem) throw httpError(409, "SYSTEM_CATEGORY", "البند ده من النظام ومينفعش يتغير اسمه");
      if (body.nameAr !== undefined) { account.nameAr = requiredName(body.nameAr, "اسم البند"); changes.nameAr = account.nameAr; }
      if (body.nameEn !== undefined) { account.nameEn = requiredName(body.nameEn, "الاسم بالإنجليزية"); changes.nameEn = account.nameEn; }
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") throw httpError(400, "INVALID_ACTIVE", "قيمة التفعيل غير صالحة");
      if (!body.isActive && account.isActive) {
        if (account.isSystem) throw httpError(409, "SYSTEM_CATEGORY", "البند ده من النظام ومينفعش يتوقف");
        if (await JournalEntry.exists({ "lines.accountId": account._id }).session(session)) throw httpError(409, "CATEGORY_HAS_LINES", "البند عليه مصروفات. مينفعش يتوقف");
      }
      account.isActive = body.isActive; changes.isActive = body.isActive;
    }
    await account.save({ session });
    await audit(req, { action: "expense.category.updated", entity: "Account", entityId: account._id, details: changes, session, strict: true });
    return account;
  });
  res.json(categoryView(updated.toObject(), undefined));
};

const monthRange = (value) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  const now = new Date();
  const year = match ? Number(match[1]) : now.getFullYear();
  const month = match ? Number(match[2]) : now.getMonth() + 1;
  if (month < 1 || month > 12) return null;
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}`, from: new Date(year, month - 1, 1), to: new Date(year, month, 1) };
};

const previousMonth = (range) => monthRange(range.month === 1 ? `${range.year - 1}-12` : `${range.year}-${String(range.month - 1).padStart(2, "0")}`);

const breakdown = async (filter) => {
  const rows = await Expense.aggregate([
    { $match: { ...filter, status: "posted" } },
    { $group: { _id: "$accountId", total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const accounts = new Map((await Account.find({ _id: { $in: rows.map((row) => row._id) } }).select("code nameAr nameEn").lean()).map((account) => [String(account._id), account]));
  const byCategory = rows.map((row) => ({ accountId: row._id, code: accounts.get(String(row._id))?.code, nameAr: accounts.get(String(row._id))?.nameAr, nameEn: accounts.get(String(row._id))?.nameEn, total: roundMoney(row.total), count: row.count }))
    .sort((left, right) => right.total - left.total);
  return { total: roundMoney(byCategory.reduce((sum, row) => sum + row.total, 0)), count: byCategory.reduce((sum, row) => sum + row.count, 0), byCategory };
};

const expenseView = (expense, categories, boxNames) => ({
  ...expense,
  categoryName: categories.get(String(expense.accountId))?.nameAr || null, categoryCode: categories.get(String(expense.accountId))?.code || null,
  boxName: boxNames.get(String(expense.boxId)) || null,
});

// GET /api/expenses?month=YYYY-MM&category=&box=&page=&limit=
const getExpenses = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const range = monthRange(req.query.month);
  if (!range) { res.status(400); throw new Error("الشهر غير صالح"); }
  const filter = { date: { $gte: range.from, $lt: range.to } };
  if (req.query.category) {
    if (!isId(req.query.category)) { res.status(400); throw new Error("البند غير صالح"); }
    filter.accountId = new mongoose.Types.ObjectId(req.query.category);
  }
  if (req.query.box) {
    if (!isId(req.query.box)) { res.status(400); throw new Error("الخزنة غير صالحة"); }
    filter.boxId = new mongoose.Types.ObjectId(req.query.box);
  }
  // A cashier who may only record expenses sees their own.
  if (req.authEnabled && req.user && !can(req, "expenses.manage") && !can(req, "cashbox.view")) filter.createdBy = req.user._id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const previous = previousMonth(range);
  const previousFilter = { ...filter, date: { $gte: previous.from, $lt: previous.to } };
  const [rows, totalItems, current, last, categories, boxList] = await Promise.all([
    Expense.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Expense.countDocuments(filter),
    breakdown(filter), breakdown(previousFilter),
    categoriesWithUsage(), CashBox.find({}).select("name").lean(),
  ]);
  const categoryById = new Map(categories.map((category) => [String(category._id), category]));
  const boxNames = new Map(boxList.map((box) => [String(box._id), box.name]));
  res.json({
    month: range.key, data: rows.map((row) => expenseView(row, categoryById, boxNames)), total: current.total, count: current.count, byCategory: current.byCategory,
    previous: { month: previous.key, total: last.total, count: last.count, byCategory: last.byCategory },
    pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
  });
};

// POST /api/expenses { date, accountId, amount, boxId?, note } (expenses.create)
const createExpense = async (req, res) => {
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const date = optionalDate(body.date);
  const note = optionalText(body.note, 500);
  if (!isId(body.accountId)) throw httpError(400, "INVALID_CATEGORY", "اختار بند المصروف");
  // Stage 21: the VAT the bill shows (recoverable). Only with VAT on; it is part of `amount`, not on top of it.
  const vat = body.vatAmount === undefined || body.vatAmount === null || body.vatAmount === "" ? 0 : Number(body.vatAmount);
  if (!Number.isFinite(vat) || vat < 0 || roundMoney(vat) !== vat) throw httpError(400, "INVALID_VAT", "قيمة الضريبة غير صالحة");
  const expense = await withTransaction(async (session) => {
    const vatCtx = vatContext(await loadVatSettings(session), date);
    if (vat > 0 && !vatCtx) throw httpError(400, "VAT_NOT_ENABLED", "الضريبة غير مفعّلة");
    if (vat >= amount) throw httpError(400, "VAT_TOO_LARGE", "الضريبة لازم تكون أقل من إجمالي الفاتورة");
    const parent = await loadParent(session);
    const category = await Account.findById(body.accountId).session(session).lean();
    if (!category || !parent || String(category.parentId) !== String(parent._id) || category.isGroup || category.isActive === false) {
      throw httpError(400, "INVALID_CATEGORY", "بند المصروف غير صالح");
    }
    const box = await boxes.resolveBox({ req, boxId: body.boxId, session, direction: "out" });
    await boxes.lockBoxes([box._id], session);
    const balance = await boxes.boxBalance(box, session);
    if (roundMoney(balance - amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية", { boxId: box._id, balance, required: amount });
    const number = await nextDocumentNumber(PREFIXES.EXPENSE, session);
    const [created] = await Expense.create([{ number, date, accountId: category._id, amount, boxId: box._id, note, ...(vat > 0 ? { vatAmount: vat, vatPeriod: await periodFor(date, session) } : {}) }], { session });
    // Dr category (net) [+ Dr VAT_INPUT = the VAT on the bill] / Cr box = amount (the cash that left).
    const vatAccount = vat > 0 ? (await accountMap(["VAT_INPUT"], session)).get("VAT_INPUT") : null;
    await postEntry({ date, source: { type: "expense", id: created._id, number }, memo: note || category.nameAr, session, lines: [
      line(category, roundMoney(amount - vat), "debit"), ...(vatAccount ? [line(vatAccount, vat, "debit")] : []), line(await boxAccount(box._id, session), amount, "credit"),
    ] });
    if (vat > 0) await recordVatEvent({ kind: "expense", direction: "input", sourceType: "expense", sourceId: created._id, number, date, net: roundMoney(amount - vat), vat, session });
    await audit(req, { action: "expense.created", entity: "Expense", entityId: created._id, details: { number, amount, category: category.code, box: box.name }, session, strict: true });
    return created;
  });
  res.status(201).json(expense);
};

// POST /api/expenses/:id/cancel { reason } (expenses.manage): a reversal, the expense stays on file.
const cancelExpense = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  if (!isId(req.params.id)) { res.status(404); throw new Error("المصروف غير موجود"); }
  const cancelled = await withTransaction(async (session) => {
    const expense = await Expense.findById(req.params.id).session(session);
    if (!expense) throw httpError(404, "EXPENSE_NOT_FOUND", "المصروف غير موجود");
    if (expense.status === "cancelled") throw httpError(409, "ALREADY_CANCELLED", "المصروف ملغي بالفعل");
    await boxes.assertBoxActive(expense.boxId, session);
    await boxes.lockAndTouch([expense.boxId], session);
    const now = new Date();
    expense.status = "cancelled"; expense.cancelReason = reason; expense.cancelledAt = now;
    expense.cancelledBy = req.user?._id; expense.cancelledByName = req.user?.name;
    await expense.save({ session });
    await boxes.reverseSourceEntries("expense", expense._id, { date: now, memo: `Expense cancelled: ${reason}`, session });
    if (expense.vatAmount > 0) await recordVatEvent({ kind: "expense_cancel", direction: "input", sourceType: "expense", sourceId: expense._id, number: expense.number, date: now, net: -roundMoney(expense.amount - expense.vatAmount), vat: -expense.vatAmount, session });
    await audit(req, { action: "expense.cancelled", entity: "Expense", entityId: expense._id, details: { number: expense.number, reason }, session, strict: true });
    return expense;
  });
  res.json(cancelled);
};

module.exports = { getCategories, createCategory, updateCategory, getExpenses, createExpense, cancelExpense };
