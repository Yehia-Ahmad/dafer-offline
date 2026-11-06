const mongoose = require("mongoose");
const CashBox = require("../models/cashBox.model");
const Shift = require("../models/shift.model");
const { postEntry, line, accountMap, boxAccount } = require("../accounting/posting");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { shiftExpected } = require("../cashbox/events");
const { postTransfer, can } = require("./cashbox.controller");
const { nonNegativeAmount, positiveAmount, optionalText } = require("../cashbox/validate");

const { httpError, isId } = boxes;

// Stage 19: shifts. A shift belongs to one box and to the user who opened it. It posts nothing when it opens
// (the money is already in the box). When it closes, the counted cash is compared with the cash the box's
// DOCUMENTS say should be there; a difference posts to CASH_OVER_SHORT (530), and an optional deposit is a
// transfer to another box.

const isOwn = (req, shift) => !req.authEnabled || !req.user || !shift.userId || String(shift.userId) === String(req.user._id);

const shiftView = (shift) => ({
  _id: shift._id, number: shift.number, boxId: shift.boxId, userId: shift.userId || null, userName: shift.userName || null,
  openedAt: shift.openedAt, openingFloat: shift.openingFloat, openingBalance: shift.openingBalance,
  openingDifference: shift.openingDifference || 0, openingNote: shift.openingNote || null,
  closedAt: shift.closedAt || null, closedByName: shift.closedByName || null,
  expected: shift.expected ?? null, counted: shift.counted ?? null, difference: shift.difference ?? null, differenceNote: shift.differenceNote || null,
  depositBoxId: shift.depositBoxId || null, depositAmount: shift.depositAmount || 0, status: shift.status,
});

/** The shift with its expected-cash lines: live for an open shift, as stored for a closed one. */
const reportOf = async (shift, box, session) => {
  if (shift.status === "closed") {
    return { ...shiftView(shift), lines: shift.breakdown || [], remaining: roundMoney((shift.counted || 0) - (shift.depositAmount || 0)) };
  }
  const { expected, lines } = await shiftExpected(shift, box, { session });
  return { ...shiftView(shift), expected, lines, remaining: null };
};

const loadShift = async (req, session) => {
  if (!isId(req.params.id)) throw httpError(404, "SHIFT_NOT_FOUND", "الوردية غير موجودة");
  const shift = await Shift.findById(req.params.id).session(session || null);
  if (!shift) throw httpError(404, "SHIFT_NOT_FOUND", "الوردية غير موجودة");
  return shift;
};

// POST /api/shifts { boxId, openingFloat, confirmFloat? } (shift.operate | shift.manage)
const openShift = async (req, res) => {
  const body = req.body || {};
  if (!isId(body.boxId)) throw httpError(400, "INVALID_BOX", "اختار الخزنة");
  const openingFloat = nonNegativeAmount(body.openingFloat, "رصيد بداية الوردية");
  const shift = await withTransaction(async (session) => {
    await boxes.ensureMainBox(session);
    const box = await CashBox.findById(body.boxId).session(session);
    if (!box) throw httpError(400, "BOX_NOT_FOUND", "الخزنة غير موجودة");
    if (!can(req, "shift.manage")) await boxes.assertBoxAllowed(req, box, session);
    if (!box.isActive) throw httpError(409, "BOX_INACTIVE", "الخزنة دي مقفولة", { boxId: box._id });
    if (!box.shiftsEnabled) throw httpError(409, "SHIFTS_DISABLED", "الورديات مش مفعّلة على الخزنة دي", { boxId: box._id });
    const open = await boxes.openShiftOf(box._id, session);
    if (open) throw httpError(409, "SHIFT_ALREADY_OPEN", "في وردية مفتوحة على الخزنة دي", { boxId: box._id, shiftId: open._id, userName: open.userName || null });
    await boxes.lockBoxes([box._id], session);
    const balance = await boxes.boxBalance(box, session);
    // The float is what the user counted; it posts nothing. It should equal the box balance: otherwise confirm the difference.
    const openingDifference = roundMoney(openingFloat - balance);
    if (openingDifference !== 0 && body.confirmFloat !== true) {
      throw httpError(409, "FLOAT_MISMATCH", "رصيد البداية مختلف عن رصيد الخزنة. أكّد الفرق", { boxId: box._id, balance, openingFloat, difference: openingDifference });
    }
    // A confirmed difference is a real shortage or overage found at the start: it needs a note and is posted now, so the
    // box balance IS the float and the shift's expected cash starts from the truth.
    const openingNote = optionalText(body.openingNote, 500, "سبب الفرق");
    if (openingDifference !== 0 && !openingNote) throw httpError(400, "NOTE_REQUIRED", "اكتب سبب الفرق", { balance, openingFloat, difference: openingDifference });
    const number = await nextDocumentNumber(PREFIXES.SHIFT, session);
    const shiftId = new mongoose.Types.ObjectId();
    const openedAt = new Date();
    if (openingDifference !== 0) {
      const accounts = await accountMap(["CASH_OVER_SHORT"], session);
      const drawerAccount = await boxAccount(box._id, session);
      const shortage = openingDifference < 0;
      const amount = Math.abs(openingDifference);
      await postEntry({ date: openedAt, source: { type: "shift_open", id: shiftId, number }, memo: `${shortage ? "Shortage" : "Overage"} at opening: ${openingNote}`, session, lines: [
        line(shortage ? accounts.get("CASH_OVER_SHORT") : drawerAccount, amount, "debit"),
        line(shortage ? drawerAccount : accounts.get("CASH_OVER_SHORT"), amount, "credit"),
      ] });
    }
    let created;
    try {
      [created] = await Shift.create([{
        _id: shiftId, number, boxId: box._id, userId: req.user?._id, userName: req.user?.name, openedAt, openingFloat, openingBalance: balance,
        ...(openingDifference !== 0 ? { openingDifference, openingNote } : {}), openCutAt: new Date(), status: "open",
      }], { session });
    } catch (error) {
      if (error && error.code === 11000) throw httpError(409, "SHIFT_ALREADY_OPEN", "في وردية مفتوحة على الخزنة دي", { boxId: box._id });
      throw error;
    }
    await audit(req, { action: "shift.opened", entity: "Shift", entityId: created._id, details: { number, box: box.name, openingFloat, balance, openingDifference }, session, strict: true });
    return created;
  });
  res.status(201).json(shiftView(shift));
};

// GET /api/shifts?boxId&status&page (shift.operate | shift.manage): all shifts with shift.manage, else your own.
const getShifts = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const filter = {};
  if (req.authEnabled && req.user && !can(req, "shift.manage")) filter.userId = req.user._id;
  if (req.query.boxId) {
    if (!isId(req.query.boxId)) { res.status(400); throw new Error("معرّف الخزنة غير صالح"); }
    filter.boxId = req.query.boxId;
  }
  if (["open", "closed"].includes(req.query.status)) filter.status = req.query.status;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [rows, totalItems] = await Promise.all([Shift.find(filter).sort({ openedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Shift.countDocuments(filter)]);
  const names = new Map((await CashBox.find({ _id: { $in: rows.map((row) => row.boxId) } }).select("name").lean()).map((box) => [String(box._id), box.name]));
  res.json({ data: rows.map((row) => ({ ...shiftView(row), boxName: names.get(String(row.boxId)) || null })), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

// GET /api/shifts/:id (shift.operate | shift.manage): the shift report; your own unless shift.manage.
const getShift = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const shift = await loadShift(req);
  if (!isOwn(req, shift) && !can(req, "shift.manage")) throw httpError(403, "FORBIDDEN", "ليست لديك صلاحية للقيام بهذه العملية");
  const box = await CashBox.findById(shift.boxId).lean();
  res.json({ ...(await reportOf(shift, box)), boxName: box?.name || null });
};

// POST /api/shifts/:id/close { counted, differenceNote, depositBoxId?, depositAmount? }
const closeShift = async (req, res) => {
  const body = req.body || {};
  const counted = nonNegativeAmount(body.counted, "المبلغ المعدود");
  const note = optionalText(body.differenceNote, 500, "سبب الفرق");
  const wantsDeposit = body.depositAmount !== undefined && body.depositAmount !== null && body.depositAmount !== "" && Number(body.depositAmount) !== 0;
  const depositAmount = wantsDeposit ? positiveAmount(body.depositAmount, "مبلغ التوريد") : 0;
  if (wantsDeposit && !isId(body.depositBoxId)) throw httpError(400, "INVALID_BOX", "اختار الخزنة اللي هتورّد فيها");
  if (depositAmount > counted) throw httpError(400, "INVALID_DEPOSIT", "التوريد أكبر من المبلغ المعدود");

  const closed = await withTransaction(async (session) => {
    const shift = await loadShift(req, session);
    if (shift.status !== "open") throw httpError(409, "SHIFT_CLOSED", "الوردية مقفولة بالفعل");
    if (!isOwn(req, shift) && !can(req, "shift.manage")) throw httpError(403, "FORBIDDEN", "ليست لديك صلاحية للقيام بهذه العملية");
    const box = await CashBox.findById(shift.boxId).session(session);
    const depositBox = wantsDeposit ? await CashBox.findById(body.depositBoxId).session(session) : null;
    if (wantsDeposit && !depositBox) throw httpError(400, "BOX_NOT_FOUND", "خزنة التوريد غير موجودة");
    await boxes.lockBoxes([box._id], session);

    const now = new Date();
    const { expected, lines } = await shiftExpected(shift, box, { session, to: now });
    const difference = roundMoney(counted - expected);
    if (difference !== 0 && !note) throw httpError(400, "NOTE_REQUIRED", "اكتب سبب الفرق", { expected, counted, difference });

    if (difference !== 0) {
      const accounts = await accountMap(["CASH_OVER_SHORT"], session);
      const drawerAccount = await boxAccount(box._id, session);
      const shortage = difference < 0;
      const amount = Math.abs(difference);
      await postEntry({ date: now, source: { type: "shift", id: shift._id, number: shift.number }, memo: `${shortage ? "Shortage" : "Overage"}: ${note}`, session, lines: [
        line(shortage ? accounts.get("CASH_OVER_SHORT") : drawerAccount, amount, "debit"),
        line(shortage ? drawerAccount : accounts.get("CASH_OVER_SHORT"), amount, "credit"),
      ] });
    }

    const closeCutAt = new Date(); // the over/short is in; the deposit is not
    let transfer = null;
    if (wantsDeposit) {
      transfer = await postTransfer({ from: box, to: depositBox, amount: depositAmount, date: now, note: `Shift ${shift.number} deposit`, kind: "shift_deposit", shiftId: shift._id, session });
    }

    Object.assign(shift, {
      status: "closed", closedAt: now, closeCutAt, closedBy: req.user?._id, closedByName: req.user?.name, expected, counted, difference,
      differenceNote: note, breakdown: lines, depositAmount,
      ...(transfer ? { depositBoxId: depositBox._id, depositTransferId: transfer._id } : {}),
    });
    await shift.save({ session });
    await audit(req, { action: "shift.closed", entity: "Shift", entityId: shift._id, details: { number: shift.number, box: box.name, expected, counted, difference, deposit: depositAmount }, session, strict: true });
    return { shift, box };
  });
  res.json({ ...(await reportOf(closed.shift, closed.box)), boxName: closed.box.name });
};

module.exports = { openShift, getShifts, getShift, closeShift };
