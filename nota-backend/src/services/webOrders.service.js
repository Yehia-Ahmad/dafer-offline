// Online Stage 4: everything staff do with a website order. Every transition is ONE transaction: the status change (a
// conditional update on the expected status, so two staff members clicking at once cannot both win: the second gets 409),
// the history entry and every invoice / payment / return it creates commit together or not at all.
//
// The documents are NOT built here. They go through the same in-transaction functions the existing routes use:
//   dispatch  -> createCreditSaleInTransaction   (credit sale on the courier's customer account, order snapshot prices, shippingFees)
//   delivered -> addCreditSalePaymentInTransaction (customer payment into the courier's box)
//   returns   -> refundCreditSaleInTransaction   (the credit-sale return, full or by line)
// They read `req`/`res` like a handler, so a request-shaped object is built for them and a tiny `res` records the status code
// they set before throwing (copied onto the error, the way errorHandler reads it).
const mongoose = require("mongoose");
const WebOrder = require("../models/webOrder.model");
const Product = require("../models/product.model");
const DeliveryZone = require("../models/deliveryZone.model");
const CashBox = require("../models/cashBox.model");
const Courier = require("../models/courier.model");
const CreditSale = require("../models/creditSale.model");
const Receipt = require("../models/receipt.model");
const Counter = require("../models/counter.model");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const { hasPermission } = require("../auth/permissions");
const { httpError, assertUsable } = require("../cashbox/boxes");
const { today } = require("../accounting/vat");
const { roundMoney } = require("../utils/invoicePricing");
const { priceWebOrder } = require("../store/orderPricing");
const { loadWebsiteSettings } = require("../store/catalog");
const { reservedByProduct } = require("../store/reservations");
const { normalizeStorePhone } = require("../utils/storePhone");
const { createCreditSaleInTransaction, addCreditSalePaymentInTransaction, refundCreditSaleInTransaction } = require("../controllers/creditSale.controller");
// Online Stage 5A: pickup and wallet orders create a CASH sale (and its return) through the same in-transaction functions the POS uses.
const { createCashSaleInTransaction, refundSellingInTransaction } = require("../controllers/selling.controller");
const Selling = require("../models/selling.model");

const MAX_QTY = 9999;
const MAX_LINES = 50;
const EPSILON = 0.005;

const isId = (value) => (typeof value === "string" || value instanceof mongoose.Types.ObjectId) && mongoose.Types.ObjectId.isValid(String(value)) && String(new mongoose.Types.ObjectId(String(value))) === String(value).toLowerCase();
const bad = (code, message, extra) => httpError(400, code, message, extra);
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

const makeRes = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; } });
/** Runs a handler-shaped function; the status it set on `res` before throwing becomes error.statusCode. */
const callHandler = async (fn, res) => {
  try {
    return await fn();
  } catch (error) {
    if (!error.statusCode && res.statusCode !== 200) error.statusCode = res.statusCode;
    throw error;
  }
};

const actorOf = (req) => ({ id: req.user ? String(req.user._id) : undefined, name: req.user ? req.user.name : undefined });
const historyEntry = (req, status, { type = "status", note, details } = {}) => {
  const actor = actorOf(req);
  return { status, at: new Date(), by: actor.id || "system", byName: actor.name, type, ...(note ? { note } : {}), ...(details ? { details } : {}) };
};

const readReason = (value, required) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && (text.length < 3 || text.length > 500)) throw bad("REASON_REQUIRED", "السبب مطلوب ويجب أن يكون بين 3 و500 حرف");
  if (text.length > 500) throw bad("INVALID_REASON", "السبب طويل (حتى 500 حرف)");
  return text;
};

const loadOrder = async (id, session) => {
  if (!isId(id)) throw httpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
  const order = await WebOrder.findById(id).session(session || null);
  if (!order) throw httpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
  return order;
};

// Online Stage 5A. An order placed before this stage has neither field: it is a delivery order (paid on delivery).
const fulfillmentOf = (order) => (order.fulfillment === "pickup" ? "pickup" : "delivery");
const isWallet = (order) => WebOrder.WALLET_METHODS.includes(order.paymentMethod);
const isVerified = (order) => Boolean(order.payment && order.payment.status === "verified");
/** The fulfillment condition of the status guard (`$ne` for delivery so orders without the field still match). */
const fulfillmentFilter = (fulfillment) => (fulfillment === "pickup" ? { fulfillment: "pickup" } : { fulfillment: { $ne: "pickup" } });
const wrongFulfillment = (order, expected) => {
  if (fulfillmentOf(order) !== expected) throw httpError(409, "WRONG_FULFILLMENT", expected === "pickup" ? "الإجراء ده لطلبات الاستلام من المحل بس" : "الإجراء ده لطلبات التوصيل بس", { fulfillment: fulfillmentOf(order) });
};
const assertPermission = (req, key, message) => {
  if (!hasPermission(req.user, key)) throw httpError(403, "FORBIDDEN", message);
};
/** A wallet order's invoice is refused until the shop checked the transfer. */
const assertPaid = (order) => {
  if (isWallet(order) && !isVerified(order)) throw httpError(409, "PAYMENT_NOT_VERIFIED", "أكّد استلام التحويل الأول");
};

/**
 * The status guard: moves the order from one of `from` to `status`, or answers 409. It is the first write of every
 * transition, so a concurrent transition on the same order conflicts here and then sees the new status.
 * `fulfillment` (Stage 5A) is part of the same condition, so a pickup-only or delivery-only transition cannot hit the other kind.
 */
const moveOrder = async (id, from, status, { req, set = {}, note, session, fulfillment }) => {
  const updated = await WebOrder.findOneAndUpdate(
    { _id: id, status: { $in: from }, ...(fulfillment ? fulfillmentFilter(fulfillment) : {}) },
    { $set: { status, ...set }, $push: { statusHistory: historyEntry(req, status, { note }) } },
    { new: true, session }
  );
  if (updated) return updated;
  const existing = await WebOrder.findById(id).select("status").session(session).lean();
  if (!existing) throw httpError(404, "ORDER_NOT_FOUND", "الطلب غير موجود");
  throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: existing.status });
};

/** Two transactions that reserve stock (confirm / edit) conflict here, so the second re-reads the first one's reservation. */
const lockReservations = (session) => Counter.collection.updateOne({ _id: "WEB_RESERVATION_LOCK" }, { $inc: { seq: 1 } }, { upsert: true, session });

/** Every line must fit in `inventoryCount - reserved by other orders`; the problems of ALL lines come back together. */
const assertAvailable = async (lines, { orderId, session, before = null }) => {
  const ids = lines.map((line) => String(line.productId));
  const [products, reserved] = await Promise.all([
    Product.find({ _id: { $in: ids } }).select("inventoryCount isArchived name").session(session).lean(),
    reservedByProduct(ids, { session, excludeOrderId: orderId, before }),
  ]);
  const byId = new Map(products.map((product) => [String(product._id), product]));
  const problems = [];
  for (const line of lines) {
    const product = byId.get(String(line.productId));
    if (!product) { problems.push({ productId: String(line.productId), reason: "not_found" }); continue; }
    const available = Math.max(0, Number(product.inventoryCount || 0) - (reserved.get(String(line.productId)) || 0));
    if (line.qty > available) problems.push({ productId: String(line.productId), name: product.name, reason: "quantity_exceeds_stock", requested: line.qty, available });
  }
  if (problems.length) throw httpError(409, "ORDER_ITEMS_INVALID", "بعض الأصناف الكمية فيها أكبر من المتاح", { lines: problems });
};

// ---------------------------------------------------------------- simple transitions

const confirm = (req, id) => withTransaction(async (session) => {
  await lockReservations(session);
  const order = await loadOrder(id, session);
  if (order.status !== "new") throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });
  await assertAvailable(order.items, { orderId: order._id, session });
  const updated = await moveOrder(order._id, ["new"], "confirmed", { req, set: { confirmedAt: new Date() }, session });
  await audit(req, { action: "order.confirmed", entity: "WebOrder", entityId: order._id, details: { number: order.number }, session, strict: true });
  return updated;
});

// (reject: new / confirmed, both fulfillments)
const reject = (req, id, body) => withTransaction(async (session) => {
  const reason = readReason(body && body.reason, true);
  const updated = await moveOrder(id, ["new", "confirmed"], "rejected", { req, set: { reason }, note: reason, session });
  await audit(req, { action: "order.rejected", entity: "WebOrder", entityId: updated._id, details: { number: updated.number, reason }, session, strict: true });
  return updated;
});

const prepare = (req, id) => withTransaction(async (session) => {
  const updated = await moveOrder(id, ["confirmed"], "preparing", { req, session });
  await audit(req, { action: "order.preparing", entity: "WebOrder", entityId: updated._id, details: { number: updated.number }, session, strict: true });
  return updated;
});

// Online Stage 5A: a pickup order can also be cancelled when it is ready and the customer never comes (reason required).
// A verified transfer posted nothing, so there is nothing to reverse; the refund to the customer happens outside Nota and the reason records it.
const cancel = (req, id, body) => withTransaction(async (session) => {
  const reason = readReason(body && body.reason, true);
  const order = await loadOrder(id, session);
  const pickup = fulfillmentOf(order) === "pickup";
  const updated = await moveOrder(order._id, pickup ? ["confirmed", "preparing", "ready_for_pickup"] : ["confirmed", "preparing"], "cancelled", { req, set: { reason }, note: reason, session, fulfillment: fulfillmentOf(order) });
  await audit(req, { action: "order.cancelled", entity: "WebOrder", entityId: updated._id, details: { number: updated.number, reason }, session, strict: true });
  return updated;
});

/** Pickup: the order is packed and waiting at the shop. Its stock stays reserved. */
const markReady = (req, id) => withTransaction(async (session) => {
  wrongFulfillment(await loadOrder(id, session), "pickup");
  const updated = await moveOrder(id, ["preparing"], "ready_for_pickup", { req, session, fulfillment: "pickup" });
  await audit(req, { action: "order.ready_for_pickup", entity: "WebOrder", entityId: updated._id, details: { number: updated.number }, session, strict: true });
  return updated;
});

const PAYMENT_METHOD_KEY = { instapay: "instapay", vodafone_cash: "vodafoneCash" };
const VERIFIABLE = ["new", "confirmed", "preparing", "ready_for_pickup"];

/**
 * Staff checked the transfer. NOTHING IS POSTED here: the money is posted when the invoice (a cash sale) is created. The wallet box of the
 * method is stored on the order now (the moment the money is seen), so a later settings change cannot move the sale to another box.
 */
const verifyPayment = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  const reference = str(input.reference, 101);
  if (reference.length > 100) throw bad("INVALID_REFERENCE", "رقم العملية طويل (حتى 100 حرف)");
  const order = await loadOrder(id, session);
  if (!isWallet(order)) throw httpError(409, "NOT_WALLET_ORDER", "الطلب ده دفعه عند الاستلام");
  if (isVerified(order)) throw httpError(409, "ALREADY_VERIFIED", "التحويل اتأكد قبل كده");
  if (!VERIFIABLE.includes(order.status)) throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });

  const settings = await loadWebsiteSettings(session);
  const configured = settings && settings.payments && settings.payments[PAYMENT_METHOD_KEY[order.paymentMethod]];
  const box = configured && configured.boxId ? await CashBox.findById(configured.boxId).session(session).lean() : null;
  if (!box || !box.isActive || !["wallet", "bank"].includes(box.type)) throw httpError(409, "PAYMENT_BOX_UNAVAILABLE", "خزنة طريقة الدفع دي مش متاحة. راجع إعدادات الدفع");

  const actor = actorOf(req);
  const at = new Date();
  const updated = await WebOrder.findOneAndUpdate(
    { _id: order._id, status: { $in: VERIFIABLE }, "payment.status": { $ne: "verified" } },
    {
      $set: { payment: { status: "verified", verifiedAt: at, verifiedBy: actor.id || "system", verifiedByName: actor.name, ...(reference ? { reference } : {}), boxId: box._id } },
      $push: { statusHistory: historyEntry(req, order.status, { type: "payment", note: reference || undefined, details: { event: "payment_verified", ...(reference ? { reference } : {}) } }) },
    },
    { new: true, session }
  );
  if (!updated) throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة");
  await audit(req, { action: "order.payment_verified", entity: "WebOrder", entityId: order._id, details: { number: order.number, method: order.paymentMethod, ...(reference ? { reference } : {}) }, session, strict: true });
  return updated;
});

// ---------------------------------------------------------------- edit

const readEditItems = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LINES) throw bad("INVALID_ITEMS", `الطلب من 1 إلى ${MAX_LINES} صنف`);
  const seen = new Set();
  return value.map((row) => {
    const productId = row && typeof row.productId === "string" ? row.productId.toLowerCase() : "";
    if (!isId(productId)) throw bad("INVALID_ITEMS", "معرّف منتج غير صالح");
    if (seen.has(productId)) throw bad("DUPLICATE_PRODUCT", "المنتج مكرر في الطلب");
    seen.add(productId);
    if (!Number.isInteger(row.qty) || row.qty < 1 || row.qty > MAX_QTY) throw bad("INVALID_QTY", `الكمية من 1 إلى ${MAX_QTY}`);
    return { productId, qty: row.qty };
  });
};

const readEditContact = (input, current, { addressRequired = true } = {}) => {
  if (input === undefined) return { contact: undefined, changes: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("INVALID_CONTACT", "بيانات التواصل غير صالحة");
  const next = { name: current.name, phone: current.phone, address: current.address, notes: current.notes || "" };
  if (input.name !== undefined) { next.name = str(input.name, 121); if (!next.name || next.name.length > 120) throw bad("INVALID_CONTACT", "الاسم مطلوب"); }
  if (input.phone !== undefined) { next.phone = normalizeStorePhone(input.phone); if (!next.phone) throw bad("INVALID_PHONE", "رقم الموبايل غير صالح"); }
  // A pickup order's address is optional.
  if (input.address !== undefined) { next.address = str(input.address, 501); if ((addressRequired && !next.address) || next.address.length > 500) throw bad("INVALID_CONTACT", "العنوان مطلوب"); }
  if (input.notes !== undefined) next.notes = str(input.notes, 500);
  const changes = {};
  for (const key of ["name", "phone", "address", "notes"]) if (next[key] !== (current[key] || "")) changes[key] = { from: current[key] || "", to: next[key] };
  return { contact: next, changes };
};

/** Changes quantities, removes/adds lines, changes zone / fee / contact. Old lines keep their snapshot price; added lines take the current one. */
const edit = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  await lockReservations(session);
  const order = await loadOrder(id, session);
  if (!WebOrder.EDITABLE_STATUSES.includes(order.status)) throw httpError(409, "NOT_EDITABLE", "الطلب خرج للتوصيل ومينفعش يتعدّل. اعمل مرتجع", { status: order.status });

  const items = input.items === undefined ? order.items.map((line) => ({ productId: String(line.productId), qty: line.qty })) : readEditItems(input.items);
  const pickupOrder = fulfillmentOf(order) === "pickup";
  const { contact, changes: contactChanges } = readEditContact(input.contact, order.contact, { addressRequired: !pickupOrder });

  let feeOverride;
  const feeGiven = input.deliveryFee !== undefined && input.deliveryFee !== null && input.deliveryFee !== "";
  // Pickup: no zone and no delivery fee, ever.
  if (pickupOrder && (feeGiven || input.zoneId !== undefined)) throw bad("NOT_DELIVERY", "طلب الاستلام من المحل مالوش منطقة ولا رسوم توصيل");
  if (feeGiven) {
    const fee = Number(input.deliveryFee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1e6) throw bad("INVALID_AMOUNT", "رسوم التوصيل لازم تكون رقم صفر أو أكبر");
    feeOverride = roundMoney(fee);
  }
  let zone = pickupOrder ? null : { id: order.zone.id, name: order.zone.name, fee: order.zone.fee };
  let zoneChanged = false;
  if (!pickupOrder && input.zoneId !== undefined && String(input.zoneId) !== String(order.zone.id)) {
    if (!isId(input.zoneId)) throw bad("INVALID_ZONE", "اختار منطقة التوصيل");
    const found = await DeliveryZone.findOne({ _id: input.zoneId, isActive: true }).session(session).lean();
    if (!found) throw httpError(409, "ZONE_UNAVAILABLE", "منطقة التوصيل غير متاحة");
    zone = { id: found._id, name: found.name, fee: found.fee };
    zoneChanged = true;
  }
  // The fee stays as it is unless staff set it or change the zone.
  if (feeOverride === undefined && !zoneChanged) feeOverride = order.deliveryFee;
  if (pickupOrder) feeOverride = 0;

  const oldByProduct = new Map(order.items.map((line) => [String(line.productId), line]));
  const products = await Product.find({ _id: { $in: items.map((row) => row.productId) } }).select("name code retailPrice discountPercentage vatExempt isArchived").session(session).lean();
  const productById = new Map(products.map((product) => [String(product._id), product]));
  const lines = items.map((row) => {
    const product = productById.get(row.productId);
    const old = oldByProduct.get(row.productId);
    if (!product) throw httpError(409, "PRODUCT_NOT_FOUND", "منتج غير موجود", { lines: [{ productId: row.productId, reason: "not_found" }] });
    if (product.isArchived && !old) throw httpError(409, "PRODUCT_ARCHIVED", `المنتج ${product.name} مؤرشف`, { lines: [{ productId: row.productId, reason: "archived" }] });
    if (old) return { product: { ...product, name: old.name, code: old.code, vatExempt: old.vatExempt }, qty: row.qty, unitPrice: old.unitPrice, retailPrice: old.retailPrice, discountPercentage: old.discountPercentage };
    return { product, qty: row.qty };
  });
  await assertAvailable(lines.map((line) => ({ productId: line.product._id, qty: line.qty })), { orderId: order._id, session });

  const settings = await loadWebsiteSettings(session);
  const priced = await priceWebOrder({ lines, zone: zone || { fee: 0 }, settings, session, feeOverride });
  // The customer paid the old total by transfer: an edit that changes it is refused (staff cancel the order and refund outside Nota).
  if (isWallet(order) && isVerified(order) && priced.total !== order.total) throw httpError(409, "PAYMENT_VERIFIED", "التحويل اتأكد بمبلغ الطلب. مينفعش تعديل يغيّر الإجمالي. الغي الطلب لو لازم", { total: order.total, newTotal: priced.total });

  const lineChanges = [];
  for (const line of priced.items) {
    const old = oldByProduct.get(String(line.productId));
    if (!old) lineChanges.push({ productId: String(line.productId), name: line.name, change: "added", qty: line.qty });
    else if (old.qty !== line.qty) lineChanges.push({ productId: String(line.productId), name: line.name, change: "qty", from: old.qty, to: line.qty });
  }
  for (const old of order.items) if (!priced.items.some((line) => String(line.productId) === String(old.productId))) lineChanges.push({ productId: String(old.productId), name: old.name, change: "removed", qty: old.qty });
  const details = {
    ...(lineChanges.length ? { lines: lineChanges } : {}),
    ...(zoneChanged ? { zone: { from: order.zone.name, to: zone.name } } : {}),
    ...(priced.deliveryFee !== order.deliveryFee ? { deliveryFee: { from: order.deliveryFee, to: priced.deliveryFee } } : {}),
    ...(Object.keys(contactChanges).length ? { contact: contactChanges } : {}),
    total: { from: order.total, to: priced.total },
  };
  if (Object.keys(details).length === 1 && priced.total === order.total) throw bad("NO_CHANGES", "مفيش تغييرات");

  const set = {
    items: priced.items, subtotal: priced.subtotal, vat: priced.vat, deliveryFee: priced.deliveryFee, total: priced.total, ...(zone ? { zone } : {}),
    ...(priced.vatRate !== undefined ? { vatRate: priced.vatRate, vatIncluded: priced.vatIncluded } : {}),
    ...(contact ? { contact } : {}),
  };
  const unset = priced.vatRate === undefined ? { vatRate: "", vatIncluded: "" } : {};
  const updated = await WebOrder.findOneAndUpdate(
    { _id: order._id, status: order.status },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $push: { statusHistory: historyEntry(req, order.status, { type: "edit", details }) } },
    { new: true, session }
  );
  if (!updated) throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة");
  await audit(req, { action: "order.edited", entity: "WebOrder", entityId: order._id, details: { number: order.number, total: priced.total }, session, strict: true });
  return updated;
});

// ---------------------------------------------------------------- dispatch / delivered / refused

const loadCourier = async (courierId, session) => {
  if (!isId(courierId)) throw bad("INVALID_COURIER", "اختار المندوب");
  const courier = await Courier.findById(courierId).session(session);
  if (!courier) throw httpError(404, "COURIER_NOT_FOUND", "المندوب غير موجود");
  if (!courier.isActive) throw httpError(409, "COURIER_INACTIVE", "المندوب موقوف");
  return courier;
};

const handlerReq = (req, body, params = {}) => ({ user: req.user, ip: req.ip, deviceId: req.deviceId, body, params });

const creditSaleItem = (creditSale, productId) => creditSale.items.find((item) => String(item.product && item.product._id ? item.product._id : item.product) === String(productId));

/**
 * Online Stage 5A: the cash sale of a pickup or wallet order, created by the POS's own function (box, number, stock, VAT, audit, posting).
 * Same lines at the order's snapshot prices, the delivery fee as shippingFees, and the order total as the expected total, so the invoice
 * total IS the order total (or nothing is created: 409 TOTAL_CHANGED).
 */
const createOrderCashSale = async (req, order, boxId, session) => {
  const res = makeRes();
  // A website order's sale is a walk-in sale: the customer's name and phone are NEVER passed (the cash sale upserts a Customer by phone
  // and overwrites its name, which would rename a shop customer or a courier). The sale keeps the order as its reference.
  return callHandler(() => createCashSaleInTransaction({ ...handlerReq(req, {
    sellingDate: today(),
    items: order.items.map((line) => ({ productId: String(line.productId), price: line.unitPrice, quantity: line.qty })),
    shippingFees: order.deliveryFee,
    expectedTotal: order.total,
    ...(boxId ? { boxId: String(boxId) } : {}),
  }), walkIn: true, sourceRef: `طلب موقع ${order.number}` }, res, session), res);
};

/** Every line against stock minus what orders confirmed BEFORE this one still reserve (see dispatch). */
const assertAvailableInQueue = (order, session) => assertAvailable(order.items, { orderId: order._id, session, before: { at: order.confirmedAt || order.createdAt, id: order._id } });

/**
 * Sends the order out.
 *  - cash on delivery: the credit sale on the courier's customer account is created by the existing credit-sale function (Stage 4, unchanged).
 *  - wallet (Stage 5A): the transfer must be verified; a CASH sale into the wallet box stored at verification is created instead. The
 *    courier collects nothing.
 */
const dispatch = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  await lockReservations(session); // two dispatches / confirms / edits competing for the same stock conflict here
  const courier = await loadCourier(input.courierId, session);
  const order = await loadOrder(id, session);
  wrongFulfillment(order, "delivery");
  const wallet = isWallet(order);
  if (wallet) assertPermission(req, "sales.create", "مش مسموحلك تعمل فاتورة نقدية");
  else assertPermission(req, "credit.create", "مش مسموحلك تعمل فاتورة آجلة");
  if (!["confirmed", "preparing"].includes(order.status)) throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });
  assertPaid(order);

  // The status guard comes first: a second parallel dispatch conflicts here, then answers 409 and creates nothing.
  await moveOrder(order._id, ["confirmed", "preparing"], "out_for_delivery", { req, set: { courierId: courier._id }, note: courier.name, session, fulfillment: "delivery" });

  // Every line against stock minus what orders confirmed BEFORE this one still reserve (first come, first served: the POS may have
  // sold reserved stock, and the later order is the one that waits). All line problems come back at once, before the credit
  // sale, which stays the final guard.
  await assertAvailableInQueue(order, session);

  if (wallet) {
    const sale = await createOrderCashSale(req, order, order.payment && order.payment.boxId, session);
    const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { cashSaleId: sale._id } }, { new: true, session });
    await audit(req, { action: "order.dispatched", entity: "WebOrder", entityId: order._id, details: { number: order.number, courier: courier.name, invoice: sale.number, kind: "cash" }, session, strict: true });
    return updated;
  }

  const res = makeRes();
  const creditSale = await callHandler(() => createCreditSaleInTransaction(handlerReq(req, {
    customerId: String(courier.customerId),
    sellingDate: today(),
    items: order.items.map((line) => ({ productId: String(line.productId), quantity: line.qty, price: line.unitPrice })),
    shippingFees: order.deliveryFee,
    notes: `طلب موقع ${order.number}`,
    expectedTotal: order.total,
  }), res, session), res);

  const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { creditSaleId: creditSale._id } }, { new: true, session });
  await audit(req, { action: "order.dispatched", entity: "WebOrder", entityId: order._id, details: { number: order.number, courier: courier.name, invoice: creditSale.number }, session, strict: true });
  return updated;
});

/**
 * Picked up (pickup only): the order becomes a cash sale. Cash on pickup goes into the box the staff member chose (`boxId`, resolved by
 * resolveBox like any POS sale: their device's drawer by default); a wallet order goes into the wallet box stored at verification.
 */
const pickup = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  await lockReservations(session);
  const order = await loadOrder(id, session);
  wrongFulfillment(order, "pickup");
  assertPermission(req, "sales.create", "مش مسموحلك تعمل فاتورة نقدية");
  if (order.status !== "ready_for_pickup") throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });
  assertPaid(order);

  await moveOrder(order._id, ["ready_for_pickup"], "picked_up", { req, session, fulfillment: "pickup" });
  await assertAvailableInQueue(order, session);

  // A wallet order ignores any box in the request: the money is in the wallet that was verified.
  const boxId = isWallet(order) ? order.payment && order.payment.boxId : input.boxId;
  const sale = await createOrderCashSale(req, order, boxId, session);
  const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { cashSaleId: sale._id } }, { new: true, session });
  await audit(req, { action: "order.picked_up", entity: "WebOrder", entityId: order._id, details: { number: order.number, invoice: sale.number }, session, strict: true });
  return updated;
});

const readReturns = (value, order) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad("INVALID_RETURNS", "المرتجع غير صالح");
  const seen = new Set();
  return value.filter((row) => row && Number(row.qty) !== 0).map((row) => {
    const productId = row && typeof row.productId === "string" ? row.productId.toLowerCase() : "";
    const line = order.items.find((item) => String(item.productId) === productId);
    if (!line) throw bad("INVALID_RETURNS", "منتج المرتجع مش في الطلب");
    if (seen.has(productId)) throw bad("INVALID_RETURNS", "المنتج مكرر في المرتجع");
    seen.add(productId);
    if (!Number.isInteger(row.qty) || row.qty < 1 || row.qty > line.qty) throw bad("INVALID_RETURNS", "كمية المرتجع أكبر من كمية الطلب");
    return { productId, qty: row.qty, reason: str(row.reason, 500) };
  });
};

const returnLogIds = (creditSale) => (creditSale.refunds || []).map((refund) => refund.returnLog).filter(Boolean);

/** Online Stage 5A: a return of the order's cash sale by the existing cash-sale return, refunded from the box the sale went into. */
const returnCashSale = async (req, order, items, note, session) => {
  const sale = await Selling.findById(order.cashSaleId).select("boxId").session(session).lean();
  if (!sale) throw httpError(409, "ORDER_NOT_DISPATCHED", "فاتورة الطلب غير موجودة");
  const res = makeRes();
  const result = await callHandler(() => refundSellingInTransaction(handlerReq(req, { items, note, ...(sale.boxId ? { boxId: String(sale.boxId) } : {}) }, { id: String(order.cashSaleId) }), res, session), res);
  return returnLogIds(result.selling);
};

/**
 * Delivered. `returns` (optional) = lines/quantities the customer refused: a credit-sale return first, then the payment for
 * what was collected (`collectedAmount`, default: everything still owed on the invoice) into the courier's box.
 */
const deliver = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  const order = await loadOrder(id, session);
  if (order.status !== "out_for_delivery") throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });
  const returns = readReturns(input.returns, order);
  if (returns.length && !hasPermission(req.user, "returns.create")) throw httpError(403, "FORBIDDEN", "مش مسموحلك تسجّل مرتجع");
  const returnedQty = returns.reduce((sum, row) => sum + row.qty, 0);
  if (returns.length && returnedQty === order.items.reduce((sum, line) => sum + line.qty, 0)) throw bad("USE_REFUSE", "المرتجع بالكامل = رفض الطلب. استخدم زر الرفض");
  const note = readReason(input.note, false);

  // Online Stage 5A: a wallet order was paid before it left (the cash sale was made at dispatch). Delivered only changes the status; lines
  // the customer refused are a return of that cash sale, refunded from the box the sale went into. The courier collects nothing.
  if (isWallet(order)) {
    if (!order.cashSaleId) throw httpError(409, "ORDER_NOT_DISPATCHED", "الطلب مالوش فاتورة");
    await moveOrder(order._id, ["out_for_delivery"], "delivered", { req, note, session });
    let returnIds = [];
    if (returns.length) returnIds = await returnCashSale(req, order, returns.map((row) => ({ productId: row.productId, quantity: row.qty, ...(row.reason ? { returnReason: row.reason } : {}) })), note || `مرتجع طلب موقع ${order.number}`, session);
    const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { returnIds } }, { new: true, session });
    await audit(req, { action: "order.delivered", entity: "WebOrder", entityId: order._id, details: { number: order.number, collected: 0, returnedQty }, session, strict: true });
    return updated;
  }
  assertPermission(req, "credit.collect", "مش مسموحلك تسجّل تحصيل");

  const courier = await Courier.findById(order.courierId).session(session);
  if (!courier || !order.creditSaleId) throw httpError(409, "ORDER_NOT_DISPATCHED", "الطلب مالوش فاتورة أو مندوب");
  await moveOrder(order._id, ["out_for_delivery"], "delivered", { req, note, session });

  const res = makeRes();
  let creditSale = await CreditSale.findById(order.creditSaleId).session(session);
  if (!creditSale) throw httpError(409, "ORDER_NOT_DISPATCHED", "فاتورة الطلب غير موجودة");
  if (returns.length) {
    const refundItems = returns.map((row) => {
      const item = creditSaleItem(creditSale, row.productId);
      if (!item) throw bad("INVALID_RETURNS", "منتج المرتجع مش في الفاتورة");
      return { itemId: String(item._id), quantity: row.qty, ...(row.reason ? { returnReason: row.reason } : {}) };
    });
    await callHandler(() => refundCreditSaleInTransaction(handlerReq(req, { items: refundItems, note: note || `مرتجع طلب موقع ${order.number}` }, { id: String(creditSale._id) }), res, session), res);
    creditSale = await CreditSale.findById(order.creditSaleId).session(session);
  }

  const remaining = roundMoney(creditSale.remainingAmount || 0);
  let collected = remaining;
  if (input.collectedAmount !== undefined && input.collectedAmount !== null && input.collectedAmount !== "") {
    collected = Number(input.collectedAmount);
    if (!Number.isFinite(collected) || collected < 0) throw bad("INVALID_AMOUNT", "المبلغ المحصّل غير صالح");
    collected = roundMoney(collected);
    if (collected - remaining > EPSILON) throw bad("EXCEEDS_REMAINING", "المبلغ المحصّل أكبر من المطلوب", { remaining });
  }
  const paymentIds = [];
  if (collected > EPSILON) {
    const box = await CashBox.findById(courier.boxId).session(session);
    if (!box) throw httpError(409, "BOX_NOT_FOUND", "خزنة المندوب غير موجودة");
    await assertUsable(box, { session });
    const result = await callHandler(() => addCreditSalePaymentInTransaction(handlerReq(req, { amount: collected, note: `تحصيل طلب موقع ${order.number}` }, { id: String(creditSale._id) }), res, session, { box }), res);
    const receipt = await Receipt.findOne({ number: result.receiptNumber }).select("_id").session(session).lean();
    if (receipt) paymentIds.push(receipt._id);
  }

  const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { collectedAmount: collected, returnIds: returnLogIds(creditSale) }, $push: { paymentIds: { $each: paymentIds } } }, { new: true, session });
  await audit(req, { action: "order.delivered", entity: "WebOrder", entityId: order._id, details: { number: order.number, collected, returnedQty }, session, strict: true });
  return updated;
});

/** Refused: a full return of the credit sale (the existing full-return rule decides about the delivery fee). */
const refuse = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  const reason = readReason(input.reason, false);
  const order = await loadOrder(id, session);
  if (order.status !== "out_for_delivery") throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });
  if (isWallet(order)) {
    // Online Stage 5A: a wallet order was a cash sale: refused = a full return of it, refunded from the box the sale went into.
    if (!order.cashSaleId) throw httpError(409, "ORDER_NOT_DISPATCHED", "الطلب مالوش فاتورة");
    await moveOrder(order._id, ["out_for_delivery"], "refused", { req, set: reason ? { reason } : {}, note: reason, session });
    const returnIds = await returnCashSale(req, order, order.items.map((line) => ({ productId: String(line.productId), quantity: line.qty })), reason || `رفض طلب موقع ${order.number}`, session);
    const refusedWallet = await WebOrder.findByIdAndUpdate(order._id, { $set: { returnIds } }, { new: true, session });
    await audit(req, { action: "order.refused", entity: "WebOrder", entityId: order._id, details: { number: order.number, reason }, session, strict: true });
    return refusedWallet;
  }
  if (!order.creditSaleId) throw httpError(409, "ORDER_NOT_DISPATCHED", "الطلب مالوش فاتورة");
  await moveOrder(order._id, ["out_for_delivery"], "refused", { req, set: reason ? { reason } : {}, note: reason, session });

  const res = makeRes();
  await callHandler(() => refundCreditSaleInTransaction(handlerReq(req, { refundAll: true, note: reason || `رفض طلب موقع ${order.number}` }, { id: String(order.creditSaleId) }), res, session), res);
  const creditSale = await CreditSale.findById(order.creditSaleId).select("refunds").session(session).lean();
  const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { returnIds: returnLogIds(creditSale), collectedAmount: 0 } }, { new: true, session });
  await audit(req, { action: "order.refused", entity: "WebOrder", entityId: order._id, details: { number: order.number, reason }, session, strict: true });
  return updated;
});

module.exports = { confirm, reject, prepare, cancel, markReady, verifyPayment, edit, dispatch, pickup, deliver, refuse, loadOrder, isId, fulfillmentOf };
