// Online Stage 4: delivery couriers (/api/couriers). A courier is created together, in ONE transaction, with
//   - a cash box (type cash, not main, shifts off: a courier has no drawer shift) with its ledger account (boxes.createBoxAccount), and
//   - a customer account (Customer.isCourier) that owes the order total from dispatch until the cash is collected.
// "Hand in cash" is an ordinary transfer from the courier's box to the main box (POST /api/cashbox/transfers): no money logic here.
const mongoose = require("mongoose");
const Courier = require("../models/courier.model");
const Customer = require("../models/customer.model");
const CashBox = require("../models/cashBox.model");
const Account = require("../models/account.model");
const WebOrder = require("../models/webOrder.model");
const asyncHandler = require("../utils/asyncHandler");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const boxes = require("../cashbox/boxes");
const { customerCreditOf } = require("../services/customerCredit.service");
const { requiredName } = require("../cashbox/validate");

const { httpError } = boxes;
const BOX_PREFIX = "مندوب – ";

const readPhone = (value) => {
  const phone = typeof value === "string" ? value.trim() : "";
  if (phone.length < 5 || phone.length > 30) throw httpError(400, "INVALID_PHONE", "رقم الموبايل مطلوب (من 5 إلى 30 حرف)");
  return phone;
};

const view = (courier, extra = {}) => ({
  id: String(courier._id), name: courier.name, phone: courier.phone, isActive: courier.isActive,
  boxId: String(courier.boxId), customerId: String(courier.customerId), ...extra,
});

/** Box balance (cash in his box), amount owed (his customer balance: invoices not yet paid), open orders (out for delivery). */
const figures = async (courier, session) => {
  const box = await CashBox.findById(courier.boxId).session(session || null).lean();
  const [boxBalance, credit, openOrders] = await Promise.all([
    box ? boxes.boxBalance(box, session) : 0,
    customerCreditOf(courier.customerId, { session }),
    WebOrder.countDocuments({ courierId: courier._id, status: "out_for_delivery" }).session(session || null),
  ]);
  return { boxBalance, amountOwed: credit.balance, openOrders };
};

const list = asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const couriers = await Courier.find({}).sort({ isActive: -1, createdAt: 1 }).lean();
  res.json({ data: await Promise.all(couriers.map(async (courier) => view(courier, await figures(courier)))) });
});

const load = async (id, session) => {
  if (!boxes.isId(id)) throw httpError(404, "COURIER_NOT_FOUND", "المندوب غير موجود");
  const courier = await Courier.findById(id).session(session || null);
  if (!courier) throw httpError(404, "COURIER_NOT_FOUND", "المندوب غير موجود");
  return courier;
};

const orderRow = (order) => ({ id: String(order._id), number: order.number, status: order.status, createdAt: order.createdAt, customerName: order.contact.name, total: order.total, collectedAmount: order.collectedAmount === undefined ? null : order.collectedAmount });

// GET /api/couriers/:id: the courier with his open and recent orders.
const getOne = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const courier = await load(req.params.id);
  const [open, recent, numbers] = await Promise.all([
    WebOrder.find({ courierId: courier._id, status: "out_for_delivery" }).sort({ createdAt: -1 }).lean(),
    WebOrder.find({ courierId: courier._id, status: { $ne: "out_for_delivery" } }).sort({ updatedAt: -1 }).limit(20).lean(),
    figures(courier),
  ]);
  res.json({ ...view(courier, numbers), openOrderRows: open.map(orderRow), recentOrderRows: recent.map(orderRow) });
});

// POST /api/couriers { name, phone } (website.manage + customers.manage)
const create = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const name = requiredName(body.name, "اسم المندوب");
  const phone = readPhone(body.phone);
  const created = await withTransaction(async (session) => {
    if (await Customer.exists({ phone }).session(session)) throw httpError(409, "PHONE_IN_USE", "رقم الموبايل ده مستخدم لعميل تاني");
    await boxes.ensureMainBox(session);
    const account = await boxes.createBoxAccount({ type: "cash", name: `${BOX_PREFIX}${name}` }, session);
    const sortOrder = await CashBox.countDocuments({}).session(session);
    const [box] = await CashBox.create([{ name: `${BOX_PREFIX}${name}`, type: "cash", accountId: account._id, isMain: false, shiftsEnabled: false, isActive: true, sortOrder }], { session });
    const courierId = new mongoose.Types.ObjectId();
    const [customer] = await Customer.create([{ name: `${BOX_PREFIX}${name}`, phone, isCourier: true, courierId }], { session });
    const [courier] = await Courier.create([{ _id: courierId, name, phone, isActive: true, boxId: box._id, customerId: customer._id }], { session });
    await audit(req, { action: "courier.created", entity: "Courier", entityId: courier._id, details: { name, box: box.name }, session, strict: true });
    return courier;
  });
  res.status(201).json(view(created, await figures(created)));
});

// PUT /api/couriers/:id { name?, phone?, isActive? }
const update = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const updated = await withTransaction(async (session) => {
    const courier = await load(req.params.id, session);
    const customer = await Customer.findById(courier.customerId).session(session);
    const box = await CashBox.findById(courier.boxId).session(session);
    const changes = {};
    if (body.name !== undefined) {
      const name = requiredName(body.name, "اسم المندوب");
      if (name !== courier.name) {
        courier.name = name; changes.name = name;
        customer.name = `${BOX_PREFIX}${name}`; box.name = `${BOX_PREFIX}${name}`;
        await Account.updateOne({ _id: box.accountId }, { $set: { nameAr: box.name, nameEn: box.name } }, { session });
      }
    }
    if (body.phone !== undefined) {
      const phone = readPhone(body.phone);
      if (phone !== courier.phone) {
        if (await Customer.exists({ phone, _id: { $ne: customer._id } }).session(session)) throw httpError(409, "PHONE_IN_USE", "رقم الموبايل ده مستخدم لعميل تاني");
        courier.phone = phone; customer.phone = phone; changes.phone = phone;
      }
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") throw httpError(400, "INVALID_ACTIVE", "قيمة التفعيل غير صالحة");
      if (body.isActive !== courier.isActive) {
        if (!body.isActive) {
          // A courier who still carries orders, cash or debt cannot be deactivated.
          const { boxBalance, amountOwed, openOrders } = await figures(courier, session);
          if (openOrders > 0) throw httpError(409, "COURIER_HAS_OPEN_ORDERS", "المندوب معاه طلبات خارجة للتوصيل", { openOrders });
          if (boxBalance !== 0) throw httpError(409, "COURIER_BOX_NOT_EMPTY", "خزنة المندوب فيها رصيد. حوّله الأول", { boxBalance });
          if (amountOwed !== 0) throw httpError(409, "COURIER_HAS_BALANCE", "على المندوب رصيد. سوّيه الأول", { amountOwed });
        }
        courier.isActive = body.isActive; box.isActive = body.isActive; changes.isActive = body.isActive;
      }
    }
    await courier.save({ session }); await customer.save({ session }); await box.save({ session });
    await audit(req, { action: changes.isActive === false ? "courier.deactivated" : "courier.updated", entity: "Courier", entityId: courier._id, details: changes, session, strict: true });
    return courier;
  });
  res.json(view(updated, await figures(updated)));
});

module.exports = { list, getOne, create, update };
