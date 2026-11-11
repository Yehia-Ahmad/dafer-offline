const mongoose = require("mongoose");
const Account = require("../models/account.model");
const CashBox = require("../models/cashBox.model");
const Device = require("../models/device.model");
const Shift = require("../models/shift.model");
const Transfer = require("../models/transfer.model");
const OwnerDrawing = require("../models/ownerDrawing.model");
const { postEntry, line, accountMap } = require("../accounting/posting");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { withTransaction } = require("../utils/transaction");
const { assertOpenDate } = require("../accounting/period");
const { audit } = require("../auth/audit");
const { hasPermission } = require("../auth/permissions");
const accountingController = require("./accounting.controller");
const boxes = require("../cashbox/boxes");
const { positiveAmount, optionalDate, optionalText, requiredReason, requiredName } = require("../cashbox/validate");

const { httpError, isId } = boxes;

// Stage 19: cash boxes, devices, transfers and owner drawings.

const can = (req, key) => !req.authEnabled || (req.user && hasPermission(req.user, key));
const shiftView = (shift) => (shift ? { _id: shift._id, number: shift.number, userId: shift.userId || null, userName: shift.userName || null, openedAt: shift.openedAt, openingFloat: shift.openingFloat } : null);

const boxView = (box, { account, balance, shift, deviceName } = {}) => ({
  _id: box._id, name: box.name, type: box.type, accountId: box.accountId, accountCode: account ? account.code : undefined,
  isMain: Boolean(box.isMain), deviceId: box.deviceId || null, deviceName: deviceName || null,
  shiftsEnabled: Boolean(box.shiftsEnabled), isActive: box.isActive !== false, sortOrder: box.sortOrder || 0,
  ...(balance === undefined ? {} : { balance }),
  openShift: shiftView(shift),
});

/** Makes sure a box exists for the main account and every 112xx leaf (installs that never ran the Stage 19 migration step). */
const ensureBoxesSynced = async () => {
  const [existing, leaves] = await Promise.all([CashBox.find({}).select("accountId isMain").lean(), boxes.bankLeafAccounts()]);
  const boxed = new Set(existing.map((box) => String(box.accountId)));
  if (!existing.some((box) => box.isMain) || leaves.some((account) => !boxed.has(String(account._id)))) await withTransaction((session) => boxes.syncAccountBoxes(session));
};

/** All boxes with balance, open shift and bound device name. */
const loadBoxViews = async ({ withBalance = true, onlyActive = false } = {}) => {
  await ensureBoxesSynced();
  const list = await CashBox.find(onlyActive ? { isActive: true } : {}).sort({ sortOrder: 1, createdAt: 1 }).lean();
  const [accounts, balances, shifts, devices] = await Promise.all([
    Account.find({ _id: { $in: list.map((box) => box.accountId) } }).lean(),
    withBalance ? boxes.accountBalances(list.map((box) => box.accountId)) : Promise.resolve(new Map()),
    Shift.find({ boxId: { $in: list.map((box) => box._id) }, status: "open" }).lean(),
    Device.find({ deviceId: { $in: list.map((box) => box.deviceId).filter(Boolean) } }).lean(),
  ]);
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const shiftByBox = new Map(shifts.map((shift) => [String(shift.boxId), shift]));
  const deviceName = new Map(devices.map((device) => [device.deviceId, device.name || device.deviceId]));
  return list.map((box) => boxView(box, {
    account: accountById.get(String(box.accountId)),
    balance: withBalance ? balances.get(String(box.accountId)) || 0 : undefined,
    shift: shiftByBox.get(String(box._id)),
    deviceName: box.deviceId ? deviceName.get(box.deviceId) || box.deviceId : null,
  }));
};

// GET /api/cashbox/boxes (cashbox.view)
const getBoxes = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const views = await loadBoxViews();
  const cashTotal = roundMoney(views.filter((box) => box.type === "cash" && box.isActive).reduce((sum, box) => sum + box.balance, 0));
  res.json({ data: views, cashTotal });
};

// GET /api/cashbox/payment-boxes (any signed-in user): the boxes this user may pay into/out of, and the default one.
const getPaymentBoxes = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const [views, mine] = await Promise.all([loadBoxViews({ withBalance: can(req, "cashbox.view"), onlyActive: true }), boxes.deviceBox(req.deviceId)]);
  const manager = can(req, "cashbox.manage");
  const available = views.filter((box) => manager || box.type !== "cash" || (req.deviceId && box.deviceId === req.deviceId) || (box.isMain && !mine));
  const main = views.find((box) => box.isMain);
  const defaultBoxId = String(mine ? mine._id : main?._id || "");
  res.json({
    defaultBoxId,
    deviceId: req.deviceId || null,
    // Where a closing shift can always deposit, even for a cashier who may not pick the main box as a payment box.
    mainBox: main ? { _id: main._id, name: main.name } : null,
    data: available.map((box) => ({
      _id: box._id, name: box.name, type: box.type, isMain: box.isMain, shiftsEnabled: box.shiftsEnabled,
      isDefault: String(box._id) === defaultBoxId, openShift: box.openShift, needsShift: box.shiftsEnabled && !box.openShift,
      // Stage 20: the balance is shown only to users who may see balances (cashbox.view); the others see names only.
      ...(can(req, "cashbox.view") ? { balance: box.balance ?? 0 } : {}),
    })),
  });
};

// GET /api/cashbox/boxes/:id (cashbox.view): the box, its balance and its latest shifts.
const getBox = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!isId(req.params.id)) { res.status(404); throw new Error("الخزنة غير موجودة"); }
  const views = await loadBoxViews();
  const view = views.find((box) => String(box._id) === req.params.id);
  if (!view) { res.status(404); throw new Error("الخزنة غير موجودة"); }
  const shifts = await Shift.find({ boxId: view._id }).sort({ openedAt: -1 }).limit(30).lean();
  res.json({ ...view, shifts });
};

// GET /api/cashbox/boxes/:id/ledger (cashbox.view): the box account's ledger (movements with source and running balance).
const getBoxLedger = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error("الخزنة غير موجودة"); }
  const box = await CashBox.findById(req.params.id).lean();
  if (!box) { res.status(404); throw new Error("الخزنة غير موجودة"); }
  const proxy = Object.create(req);
  proxy.params = { id: String(box.accountId) };
  return accountingController.getLedger(proxy, res);
};

const conflictOnDevice = (error) => {
  if (error && error.code === 11000 && (error.keyPattern?.deviceId || /deviceId/.test(error.message || ""))) {
    return httpError(409, "DEVICE_ALREADY_BOUND", "الجهاز ده متربط بخزنة تانية");
  }
  return error;
};

const assertDeviceFree = async (deviceId, exceptBoxId, session) => {
  if (!deviceId) return;
  const taken = await CashBox.findOne({ deviceId, ...(exceptBoxId ? { _id: { $ne: exceptBoxId } } : {}) }).session(session || null).lean();
  if (taken) throw httpError(409, "DEVICE_ALREADY_BOUND", "الجهاز ده متربط بخزنة تانية", { boxId: taken._id, boxName: taken.name });
};

const parseDeviceId = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const { validDeviceId } = require("../middlewares/device.middleware");
  const id = validDeviceId(value);
  if (!id) throw httpError(400, "INVALID_DEVICE", "معرّف الجهاز غير صالح");
  return id;
};

// POST /api/cashbox/boxes (cashbox.manage)
const createBox = async (req, res) => {
  const body = req.body || {};
  const name = requiredName(body.name, "اسم الخزنة");
  if (!["cash", "wallet", "bank"].includes(body.type)) throw httpError(400, "INVALID_TYPE", "نوع الخزنة يجب أن يكون cash أو wallet أو bank");
  const deviceId = parseDeviceId(body.deviceId);
  // Shifts: on by default for a new cash box; wallets and banks have no drawer to count.
  const shiftsEnabled = body.type === "cash" ? body.shiftsEnabled !== false : false;
  // AddCashBox: "رصيد البداية" is moved in from the main box in the same transaction (INSUFFICIENT_BALANCE if it does not cover it).
  const openingAmount = body.openingAmount === undefined || body.openingAmount === null || body.openingAmount === "" || Number(body.openingAmount) === 0 ? 0 : positiveAmount(body.openingAmount, "رصيد البداية");
  const created = await withTransaction(async (session) => {
    await boxes.ensureMainBox(session);
    await assertDeviceFree(deviceId, null, session);
    const account = await boxes.createBoxAccount({ type: body.type, name }, session);
    const sortOrder = await CashBox.countDocuments({}).session(session);
    let box;
    try {
      [box] = await CashBox.create([{ name, type: body.type, accountId: account._id, isMain: false, ...(deviceId ? { deviceId } : {}), shiftsEnabled, isActive: true, sortOrder }], { session });
    } catch (error) { throw conflictOnDevice(error); }
    let balance = 0;
    if (openingAmount > 0) {
      const main = await boxes.ensureMainBox(session);
      await postTransfer({ from: main, to: box, amount: openingAmount, date: new Date(), note: "رصيد بداية", session });
      balance = openingAmount;
    }
    await audit(req, { action: "cashbox.created", entity: "CashBox", entityId: box._id, details: { name, type: body.type, code: account.code, openingAmount }, session, strict: true });
    return { box, account, balance };
  });
  res.status(201).json(boxView(created.box, { account: created.account, balance: created.balance, shift: null }));
};

// PUT /api/cashbox/boxes/:id (cashbox.manage): name, device, shifts, sort order, active.
const updateBox = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error("الخزنة غير موجودة"); }
  const body = req.body || {};
  const updated = await withTransaction(async (session) => {
    const box = await CashBox.findById(req.params.id).session(session);
    if (!box) throw httpError(404, "BOX_NOT_FOUND", "الخزنة غير موجودة");
    const account = await Account.findById(box.accountId).session(session);
    const changes = {};
    if (body.name !== undefined) {
      box.name = requiredName(body.name, "اسم الخزنة");
      changes.name = box.name;
      if (!box.isMain) { account.nameAr = box.name; account.nameEn = box.name; await account.save({ session }); }
    }
    if (body.deviceId !== undefined) {
      const deviceId = parseDeviceId(body.deviceId);
      await assertDeviceFree(deviceId, box._id, session);
      box.deviceId = deviceId || undefined;
      changes.deviceId = deviceId;
    }
    if (body.sortOrder !== undefined) {
      if (!Number.isInteger(body.sortOrder)) throw httpError(400, "INVALID_SORT", "الترتيب غير صالح");
      box.sortOrder = body.sortOrder;
    }
    if (body.shiftsEnabled !== undefined) {
      if (typeof body.shiftsEnabled !== "boolean") throw httpError(400, "INVALID_SHIFTS", "قيمة الورديات غير صالحة");
      if (body.shiftsEnabled && box.type !== "cash") throw httpError(400, "SHIFTS_CASH_ONLY", "الورديات للخزائن النقدية فقط");
      if (!body.shiftsEnabled && box.shiftsEnabled && await boxes.openShiftOf(box._id, session)) throw httpError(409, "BOX_HAS_OPEN_SHIFT", "اقفل الوردية المفتوحة الأول");
      box.shiftsEnabled = body.shiftsEnabled;
      changes.shiftsEnabled = body.shiftsEnabled;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") throw httpError(400, "INVALID_ACTIVE", "قيمة التفعيل غير صالحة");
      if (!body.isActive && box.isActive) {
        if (box.isMain) throw httpError(409, "MAIN_BOX", "الخزنة الرئيسية لا يمكن إيقافها");
        if (await boxes.openShiftOf(box._id, session)) throw httpError(409, "BOX_HAS_OPEN_SHIFT", "في وردية مفتوحة على الخزنة دي", { boxId: box._id });
        const balance = await boxes.boxBalance(box, session);
        if (balance !== 0) throw httpError(409, "BOX_NOT_EMPTY", "الخزنة فيها رصيد. حوّله الأول", { boxId: box._id, balance });
        box.deviceId = undefined; // frees the PC for another box
      }
      box.isActive = body.isActive;
      changes.isActive = body.isActive;
    }
    try { await box.save({ session }); } catch (error) { throw conflictOnDevice(error); }
    await audit(req, { action: changes.isActive === false ? "cashbox.deactivated" : "cashbox.updated", entity: "CashBox", entityId: box._id, details: changes, session, strict: true });
    return { box, account };
  });
  const views = await loadBoxViews();
  res.json(views.find((box) => String(box._id) === String(updated.box._id)));
};

// DELETE /api/cashbox/boxes/:id (cashbox.manage): only a box with no ledger lines and no documents.
const deleteBox = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error("الخزنة غير موجودة"); }
  await withTransaction(async (session) => {
    const box = await CashBox.findById(req.params.id).session(session);
    if (!box) throw httpError(404, "BOX_NOT_FOUND", "الخزنة غير موجودة");
    if (box.isMain) throw httpError(409, "MAIN_BOX", "الخزنة الرئيسية لا تتحذف");
    if (await boxes.boxHasLines(box, session) || await Shift.exists({ boxId: box._id }).session(session)) {
      throw httpError(409, "BOX_HAS_LINES", "الخزنة عليها حركات. أوقفها بدل ما تمسحها", { boxId: box._id });
    }
    await Account.deleteOne({ _id: box.accountId }, { session });
    await box.deleteOne({ session });
    await audit(req, { action: "cashbox.deleted", entity: "CashBox", entityId: box._id, details: { name: box.name }, session, strict: true });
  });
  res.json({ message: "تم حذف الخزنة" });
};

// GET /api/devices (cashbox.manage): the PCs that talked to the backend, with the box each one defaults to.
const getDevices = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const [devices, bound] = await Promise.all([Device.find({}).sort({ role: 1, name: 1 }).lean(), CashBox.find({ deviceId: { $type: "string" } }).select("name deviceId").lean()]);
  const boxByDevice = new Map(bound.map((box) => [box.deviceId, box]));
  res.json({
    currentDeviceId: req.deviceId || null,
    data: devices.map((device) => ({
      deviceId: device.deviceId, name: device.name || device.deviceId, role: device.role, lastSeenAt: device.lastSeenAt,
      isCurrent: Boolean(req.deviceId) && device.deviceId === req.deviceId,
      boxId: boxByDevice.get(device.deviceId)?._id || null, boxName: boxByDevice.get(device.deviceId)?.name || null,
    })),
  });
};

// ------------------------------------------------------------------ transfers

const accountOf = (box, session) => Account.findById(box.accountId).session(session || null).lean();

/**
 * Posts Dr to-box / Cr from-box. The from-box must cover the amount (409 INSUFFICIENT_BALANCE). Both boxes must
 * be active. Used by POST /cashbox/transfers and by the deposit when a shift closes.
 */
const postTransfer = async ({ from, to, amount, date, note, kind = "transfer", shiftId, session }) => {
  if (String(from._id) === String(to._id)) throw httpError(400, "SAME_BOX", "اختار خزنتين مختلفتين");
  for (const box of [from, to]) if (!box.isActive) throw httpError(409, "BOX_INACTIVE", "الخزنة دي مقفولة", { boxId: box._id });
  await boxes.lockBoxes([from._id, to._id], session);
  const balances = await boxes.accountBalances([from.accountId, to.accountId], session);
  const fromBefore = balances.get(String(from.accountId)) || 0;
  const toBefore = balances.get(String(to.accountId)) || 0;
  if (roundMoney(fromBefore - amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية", { boxId: from._id, balance: fromBefore, required: amount });
  const [fromAccount, toAccount] = await Promise.all([accountOf(from, session), accountOf(to, session)]);
  const number = await nextDocumentNumber(PREFIXES.TRANSFER, session);
  const [transfer] = await Transfer.create([{
    number, fromBoxId: from._id, toBoxId: to._id, amount, date, note, kind, ...(shiftId ? { shiftId } : {}),
    fromBefore, fromAfter: roundMoney(fromBefore - amount), toBefore, toAfter: roundMoney(toBefore + amount),
  }], { session });
  await postEntry({ date, source: { type: "transfer", id: transfer._id, number }, memo: note || "", session, lines: [line(toAccount, amount, "debit"), line(fromAccount, amount, "credit")] });
  return transfer;
};

const loadActiveBox = async (id, label, session) => {
  if (!isId(id)) throw httpError(400, "INVALID_BOX", `${label} غير صالحة`);
  const box = await CashBox.findById(id).session(session);
  if (!box) throw httpError(400, "BOX_NOT_FOUND", `${label} غير موجودة`);
  return box;
};

const transferView = (transfer, names) => ({
  ...transfer, fromBoxName: names.get(String(transfer.fromBoxId)) || null, toBoxName: names.get(String(transfer.toBoxId)) || null,
});

const boxNames = async (rows) => {
  const ids = [...new Set(rows.flatMap((row) => [row.fromBoxId, row.toBoxId, row.boxId].filter(Boolean).map(String)))];
  const found = await CashBox.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(found.map((box) => [String(box._id), box.name]));
};

// POST /api/cashbox/transfers (cashbox.manage)
const createTransfer = async (req, res) => {
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const date = optionalDate(body.date);
  const note = optionalText(body.note, 500);
  const transfer = await withTransaction(async (session) => {
    await assertOpenDate(date, { session }); // Stage 22: the period lock, before anything else is checked
    await boxes.ensureMainBox(session);
    const from = await loadActiveBox(body.fromBoxId, "الخزنة المحوّل منها", session);
    const to = await loadActiveBox(body.toBoxId, "الخزنة المحوّل إليها", session);
    const created = await postTransfer({ from, to, amount, date, note, session });
    await audit(req, { action: "transfer.created", entity: "Transfer", entityId: created._id, details: { number: created.number, amount, from: from.name, to: to.name }, session, strict: true });
    return created;
  });
  const names = await boxNames([transfer]);
  res.status(201).json(transferView(transfer.toObject(), names));
};

// GET /api/cashbox/transfers (cashbox.view)
const getTransfers = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const filter = {};
  if (req.query.boxId) {
    if (!isId(req.query.boxId)) { res.status(400); throw new Error("معرّف الخزنة غير صالح"); }
    filter.$or = [{ fromBoxId: req.query.boxId }, { toBoxId: req.query.boxId }];
  }
  const [rows, totalItems] = await Promise.all([Transfer.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Transfer.countDocuments(filter)]);
  const names = await boxNames(rows);
  res.json({ data: rows.map((row) => transferView(row, names)), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

// POST /api/cashbox/transfers/:id/cancel (cashbox.manage): a reversal with a reason.
const cancelTransfer = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  if (!isId(req.params.id)) { res.status(404); throw new Error("التحويل غير موجود"); }
  const cancelled = await withTransaction(async (session) => {
    const transfer = await Transfer.findById(req.params.id).session(session);
    if (!transfer) throw httpError(404, "TRANSFER_NOT_FOUND", "التحويل غير موجود");
    if (transfer.status === "cancelled") throw httpError(409, "ALREADY_CANCELLED", "التحويل ملغي بالفعل");
    // The deposit of a closed shift is part of that shift's report: it cannot be undone on its own.
    if (transfer.kind === "shift_deposit") throw httpError(409, "SHIFT_DEPOSIT", "توريد الوردية مينفعش يتلغى لوحده");
    await boxes.assertBoxActive(transfer.fromBoxId, session);
    const to = await CashBox.findById(transfer.toBoxId).session(session);
    await boxes.lockAndTouch([transfer.fromBoxId, transfer.toBoxId], session);
    const balance = await boxes.boxBalance(to, session);
    if (roundMoney(balance - transfer.amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "الخزنة المحوّل إليها صرفت الفلوس. مينفعش تلغي", { boxId: to._id, balance, required: transfer.amount });
    const now = new Date();
    transfer.status = "cancelled"; transfer.cancelReason = reason; transfer.cancelledAt = now;
    transfer.cancelledBy = req.user?._id; transfer.cancelledByName = req.user?.name;
    await transfer.save({ session });
    await boxes.reverseSourceEntries("transfer", transfer._id, { date: now, memo: `Transfer cancelled: ${reason}`, session });
    await audit(req, { action: "transfer.cancelled", entity: "Transfer", entityId: transfer._id, details: { number: transfer.number, reason }, session, strict: true });
    return transfer;
  });
  const names = await boxNames([cancelled]);
  res.json(transferView(cancelled.toObject(), names));
};

// ------------------------------------------------------------------ owner drawings

const drawingView = (drawing, names) => ({ ...drawing, boxName: names.get(String(drawing.boxId)) || null });

// POST /api/cashbox/drawings (owner.drawings)
const createDrawing = async (req, res) => {
  const body = req.body || {};
  const amount = positiveAmount(body.amount);
  const date = optionalDate(body.date);
  const note = optionalText(body.note, 500);
  const drawing = await withTransaction(async (session) => {
    await assertOpenDate(date, { session }); // Stage 22: the period lock, before anything else is checked
    const box = await boxes.resolveBox({ req, boxId: body.boxId, session, direction: "out", alsoAllow: ["owner.drawings"], oneBoxAllowed: false });
    await boxes.lockBoxes([box._id], session);
    const balance = await boxes.boxBalance(box, session);
    if (roundMoney(balance - amount) < 0) throw httpError(409, "INSUFFICIENT_BALANCE", "رصيد الخزنة مش كفاية", { boxId: box._id, balance, required: amount });
    const accounts = await accountMap(["OWNER_DRAWINGS"], session);
    const number = await nextDocumentNumber(PREFIXES.OWNER_DRAWING, session);
    const [created] = await OwnerDrawing.create([{ number, boxId: box._id, amount, date, note }], { session });
    await postEntry({ date, source: { type: "owner_drawing", id: created._id, number }, memo: note || "", session, lines: [
      line(accounts.get("OWNER_DRAWINGS"), amount, "debit"), line(await accountOf(box, session), amount, "credit"),
    ] });
    await audit(req, { action: "drawing.created", entity: "OwnerDrawing", entityId: created._id, details: { number, amount, box: box.name }, session, strict: true });
    return created;
  });
  res.status(201).json(drawingView(drawing.toObject(), await boxNames([drawing])));
};

// GET /api/cashbox/drawings (owner.drawings)
const getDrawings = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [rows, totalItems] = await Promise.all([OwnerDrawing.find({}).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), OwnerDrawing.countDocuments({})]);
  const names = await boxNames(rows);
  res.json({ data: rows.map((row) => drawingView(row, names)), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

// POST /api/cashbox/drawings/:id/cancel (owner.drawings)
const cancelDrawing = async (req, res) => {
  const reason = requiredReason(req.body && req.body.reason);
  if (!isId(req.params.id)) { res.status(404); throw new Error("السحب غير موجود"); }
  const cancelled = await withTransaction(async (session) => {
    const drawing = await OwnerDrawing.findById(req.params.id).session(session);
    if (!drawing) throw httpError(404, "DRAWING_NOT_FOUND", "السحب غير موجود");
    if (drawing.status === "cancelled") throw httpError(409, "ALREADY_CANCELLED", "السحب ملغي بالفعل");
    await boxes.assertBoxActive(drawing.boxId, session);
    await boxes.lockAndTouch([drawing.boxId], session);
    const now = new Date();
    drawing.status = "cancelled"; drawing.cancelReason = reason; drawing.cancelledAt = now;
    drawing.cancelledBy = req.user?._id; drawing.cancelledByName = req.user?.name;
    await drawing.save({ session });
    await boxes.reverseSourceEntries("owner_drawing", drawing._id, { date: now, memo: `Owner drawing cancelled: ${reason}`, session });
    await audit(req, { action: "drawing.cancelled", entity: "OwnerDrawing", entityId: drawing._id, details: { number: drawing.number, reason }, session, strict: true });
    return drawing;
  });
  res.json(drawingView(cancelled.toObject(), await boxNames([cancelled])));
};

module.exports = {
  getBoxes, getPaymentBoxes, getBox, getBoxLedger, createBox, updateBox, deleteBox, getDevices,
  createTransfer, getTransfers, cancelTransfer, createDrawing, getDrawings, cancelDrawing,
  postTransfer, loadBoxViews, can,
};
