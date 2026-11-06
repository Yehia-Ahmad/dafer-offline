const mongoose = require("mongoose");
const Account = require("../models/account.model");
const CashBox = require("../models/cashBox.model");
const Shift = require("../models/shift.model");
const JournalEntry = require("../models/journalEntry.model");
const { accountMap, boxAccount, reverseEntry } = require("../accounting/posting");
const { roundMoney } = require("../utils/invoicePricing");
const { hasPermission } = require("../auth/permissions");

// Stage 19: cash boxes. The single place that knows how a box maps to a ledger account, what its
// balance is, and which box a request's money goes through.

const MAIN_BOX_NAME = "الخزنة الرئيسية";

const httpError = (statusCode, code, message, extra = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code, ...extra };
  return error;
};

const isId = (value) => mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(String(value))) === String(value);

// A concurrent first creation can hit a unique index. Let the transaction helper retry from a fresh snapshot.
const retryable = (error) => {
  if (error?.code === 11000 && typeof error.addErrorLabel === "function") error.addErrorLabel("TransientTransactionError");
  return error;
};

/** Leaf accounts under 112 (banks and wallets), in code order. */
const bankLeafAccounts = async (session) => {
  const parent = await Account.findOne({ code: "112" }).session(session || null).lean();
  if (!parent) return [];
  return Account.find({ parentId: parent._id, isGroup: false }).sort({ code: 1 }).session(session || null).lean();
};

/**
 * The main box (account 1111, CASH_MAIN). Created on first use, so a shop that never opens the
 * cash screen keeps working exactly as before: one main box, no shifts.
 */
const ensureMainBox = async (session) => {
  const existing = await CashBox.findOne({ isMain: true }).session(session || null);
  if (existing) return existing;
  const accounts = await accountMap(["CASH_MAIN"], session);
  try {
    const [created] = await CashBox.create([{
      name: MAIN_BOX_NAME, type: "cash", accountId: accounts.get("CASH_MAIN")._id, isMain: true, shiftsEnabled: false, isActive: true, sortOrder: 0,
    }], { session });
    return created;
  } catch (error) {
    throw retryable(error);
  }
};

/** Makes sure the main box and a box for every 112xx leaf exist (same name and kind). Returns the number created. */
const syncAccountBoxes = async (session) => {
  let created = 0;
  const main = await CashBox.findOne({ isMain: true }).session(session || null);
  if (!main) { await ensureMainBox(session); created += 1; }
  const known = new Set((await CashBox.find({}).select("accountId").session(session || null).lean()).map((box) => String(box.accountId)));
  let order = await CashBox.countDocuments({}).session(session || null);
  for (const account of await bankLeafAccounts(session)) {
    if (known.has(String(account._id))) continue;
    try {
      await CashBox.create([{ name: account.nameAr, type: account.kind === "wallet" ? "wallet" : "bank", accountId: account._id, shiftsEnabled: false, isActive: account.isActive !== false, sortOrder: order }], { session });
    } catch (error) {
      throw retryable(error);
    }
    order += 1; created += 1;
  }
  return created;
};

/** Box ledger balance = the balance of its account, one aggregation for any number of accounts. Map(accountId -> balance). */
const accountBalances = async (accountIds, session) => {
  const ids = accountIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return new Map();
  const rows = await JournalEntry.aggregate([
    { $match: { status: "posted", "lines.accountId": { $in: ids } } },
    { $unwind: "$lines" },
    { $match: { "lines.accountId": { $in: ids } } },
    { $group: { _id: "$lines.accountId", balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ]).session(session || null);
  return new Map(ids.map((id) => [String(id), roundMoney(rows.find((row) => String(row._id) === String(id))?.balance || 0)]));
};

/** The ledger balance of one box (the single balance helper). */
const boxBalance = async (box, session) => (await accountBalances([box.accountId], session)).get(String(box.accountId)) || 0;

/** Does `box` have any ledger line? A box with lines is never deleted. */
const boxHasLines = async (box, session) => Boolean(await JournalEntry.exists({ "lines.accountId": box.accountId }).session(session || null));

const openShiftOf = (boxId, session) => Shift.findOne({ boxId, status: "open" }).session(session || null);

/** The box a PC's sales go to by default (an active box bound to the device), else null. */
const deviceBox = (deviceId, session) => (deviceId ? CashBox.findOne({ deviceId, isActive: true }).session(session || null) : null);

/**
 * May this user pick this box? Only checked when permissions are on. A user with cashbox.manage may use any
 * box. Others: wallets and banks, their own PC's drawer, and the main box only when the PC has no drawer.
 */
const assertBoxAllowed = async (req, box, session) => {
  if (!req || !req.authEnabled || !req.user) return;
  if (hasPermission(req.user, "cashbox.manage")) return;
  if (box.type !== "cash") return;
  if (req.deviceId && box.deviceId === req.deviceId) return;
  if (box.isMain && !(await deviceBox(req.deviceId, session))) return;
  throw httpError(403, "BOX_NOT_ALLOWED", "الخزنة دي مش متاحة ليك", { boxId: box._id });
};

/**
 * The box a money document goes through.
 * - `boxId` given: that box (checked for the user).
 * - else the device's default box, else the main box.
 * Errors: 400 INVALID_BOX / BOX_NOT_FOUND, 409 BOX_INACTIVE, 409 NO_OPEN_SHIFT (shift-enabled box, no open shift).
 * `requireShift: false` is for movements a manager makes between shifts (transfers).
 */
const resolveBox = async ({ req = null, boxId = null, session, requireShift = true }) => {
  const main = await ensureMainBox(session);
  let box;
  if (boxId !== undefined && boxId !== null && boxId !== "") {
    if (!isId(boxId)) throw httpError(400, "INVALID_BOX", "معرّف الخزنة غير صالح");
    box = await CashBox.findById(boxId).session(session || null);
    if (!box) throw httpError(400, "BOX_NOT_FOUND", "الخزنة غير موجودة");
    await assertBoxAllowed(req, box, session);
  } else {
    box = (await deviceBox(req && req.deviceId, session)) || main;
  }
  if (!box.isActive) throw httpError(409, "BOX_INACTIVE", "الخزنة دي مقفولة", { boxId: box._id });
  if (requireShift && box.shiftsEnabled) {
    const shift = await openShiftOf(box._id, session);
    if (!shift) throw httpError(409, "NO_OPEN_SHIFT", "مفيش وردية مفتوحة على الخزنة دي", { boxId: box._id, boxName: box.name });
  }
  return box;
};

/** Next free code under a parent account (first free code is floor + 1). */
const nextLeafCode = async (parentCode, floor, session) => {
  const parent = await Account.findOne({ code: parentCode }).session(session || null).lean();
  if (!parent) throw new Error(`Missing parent account ${parentCode}`);
  const children = await Account.find({ parentId: parent._id }).select("code").session(session || null).lean();
  const max = children.reduce((top, child) => Math.max(top, Number(child.code) || 0), floor);
  return { parent, code: String(max + 1) };
};

/**
 * The ledger account of a new box: a cash drawer is a leaf under 111 (11102, 11103, ...), a wallet or bank a leaf
 * under 112 (the next 112xx, kind wallet|bank).
 */
const createBoxAccount = async ({ type, name }, session) => {
  const { parent, code } = type === "cash" ? await nextLeafCode("111", 11101, session) : await nextLeafCode("112", 11200, session);
  try {
    const [account] = await Account.create([{
      code, nameAr: name, nameEn: name, type: "asset", normalSide: "debit", parentId: parent._id, isGroup: false, isSystem: false,
      kind: type === "cash" ? null : type, isActive: true,
    }], { session });
    return account;
  } catch (error) {
    throw retryable(error);
  }
};

/**
 * Serialises money leaving a box: two concurrent transactions touching the same box conflict here, one retries,
 * and its balance check then sees the other's posting.
 */
const lockBoxes = async (boxIds, session) => {
  for (const id of [...new Set(boxIds.map(String))].sort()) {
    await CashBox.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $currentDate: { updatedAt: true } }, { session });
  }
};

/** Reverses the open auto entries of one source document (an expense, a transfer, ...). Returns the reversals. */
const reverseSourceEntries = async (sourceType, sourceId, { date, memo, session }) => {
  const entries = await JournalEntry.find({ "source.type": sourceType, "source.id": sourceId, type: "auto", reversedBy: null }).sort({ createdAt: 1 }).session(session);
  const results = [];
  for (const entry of entries) results.push(await reverseEntry(entry._id, { date, memo, session }));
  return results;
};

module.exports = {
  nextLeafCode, createBoxAccount, lockBoxes, reverseSourceEntries,
  MAIN_BOX_NAME, httpError, isId, retryable, bankLeafAccounts, ensureMainBox, syncAccountBoxes, boxAccount, accountBalances,
  boxBalance, boxHasLines, openShiftOf, deviceBox, assertBoxAllowed, resolveBox,
};
