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

/**
 * The status guard: moves the order from one of `from` to `status`, or answers 409. It is the first write of every
 * transition, so a concurrent transition on the same order conflicts here and then sees the new status.
 */
const moveOrder = async (id, from, status, { req, set = {}, note, session }) => {
  const updated = await WebOrder.findOneAndUpdate(
    { _id: id, status: { $in: from } },
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
const assertAvailable = async (lines, { orderId, session }) => {
  const ids = lines.map((line) => String(line.productId));
  const [products, reserved] = await Promise.all([
    Product.find({ _id: { $in: ids } }).select("inventoryCount isArchived name").session(session).lean(),
    reservedByProduct(ids, { session, excludeOrderId: orderId }),
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
  const updated = await moveOrder(order._id, ["new"], "confirmed", { req, session });
  await audit(req, { action: "order.confirmed", entity: "WebOrder", entityId: order._id, details: { number: order.number }, session, strict: true });
  return updated;
});

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

const cancel = (req, id, body) => withTransaction(async (session) => {
  const reason = readReason(body && body.reason, true);
  const updated = await moveOrder(id, ["confirmed", "preparing"], "cancelled", { req, set: { reason }, note: reason, session });
  await audit(req, { action: "order.cancelled", entity: "WebOrder", entityId: updated._id, details: { number: updated.number, reason }, session, strict: true });
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

const readEditContact = (input, current) => {
  if (input === undefined) return { contact: undefined, changes: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("INVALID_CONTACT", "بيانات التواصل غير صالحة");
  const next = { name: current.name, phone: current.phone, address: current.address, notes: current.notes || "" };
  if (input.name !== undefined) { next.name = str(input.name, 121); if (!next.name || next.name.length > 120) throw bad("INVALID_CONTACT", "الاسم مطلوب"); }
  if (input.phone !== undefined) { next.phone = normalizeStorePhone(input.phone); if (!next.phone) throw bad("INVALID_PHONE", "رقم الموبايل غير صالح"); }
  if (input.address !== undefined) { next.address = str(input.address, 501); if (!next.address || next.address.length > 500) throw bad("INVALID_CONTACT", "العنوان مطلوب"); }
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
  const { contact, changes: contactChanges } = readEditContact(input.contact, order.contact);

  let feeOverride;
  if (input.deliveryFee !== undefined && input.deliveryFee !== null && input.deliveryFee !== "") {
    const fee = Number(input.deliveryFee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1e6) throw bad("INVALID_AMOUNT", "رسوم التوصيل لازم تكون رقم صفر أو أكبر");
    feeOverride = roundMoney(fee);
  }
  let zone = { id: order.zone.id, name: order.zone.name, fee: order.zone.fee };
  let zoneChanged = false;
  if (input.zoneId !== undefined && String(input.zoneId) !== String(order.zone.id)) {
    if (!isId(input.zoneId)) throw bad("INVALID_ZONE", "اختار منطقة التوصيل");
    const found = await DeliveryZone.findOne({ _id: input.zoneId, isActive: true }).session(session).lean();
    if (!found) throw httpError(409, "ZONE_UNAVAILABLE", "منطقة التوصيل غير متاحة");
    zone = { id: found._id, name: found.name, fee: found.fee };
    zoneChanged = true;
  }
  // The fee stays as it is unless staff set it or change the zone.
  if (feeOverride === undefined && !zoneChanged) feeOverride = order.deliveryFee;

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
  const priced = await priceWebOrder({ lines, zone, settings, session, feeOverride });

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
    items: priced.items, subtotal: priced.subtotal, vat: priced.vat, deliveryFee: priced.deliveryFee, total: priced.total, zone,
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

/** Sends the order out: the credit sale on the courier's customer account is created by the existing credit-sale function. */
const dispatch = (req, id, body) => withTransaction(async (session) => {
  const input = body && typeof body === "object" ? body : {};
  const courier = await loadCourier(input.courierId, session);
  const order = await loadOrder(id, session);
  if (!["confirmed", "preparing"].includes(order.status)) throw httpError(409, "INVALID_STATUS", "حالة الطلب اتغيرت. حدّث الصفحة", { status: order.status });

  // The status guard comes first: a second parallel dispatch conflicts here, then answers 409 and creates nothing.
  await moveOrder(order._id, ["confirmed", "preparing"], "out_for_delivery", { req, set: { courierId: courier._id }, note: courier.name, session });

  // Every line's problem at once (the credit sale itself would name only the first). The credit sale stays the final guard.
  const products = await Product.find({ _id: { $in: order.items.map((line) => line.productId) } }).select("inventoryCount name").session(session).lean();
  const stock = new Map(products.map((product) => [String(product._id), product]));
  const problems = order.items
    .filter((line) => Number((stock.get(String(line.productId)) || {}).inventoryCount || 0) < line.qty)
    .map((line) => ({ productId: String(line.productId), name: line.name, reason: "quantity_exceeds_stock", requested: line.qty, available: Number((stock.get(String(line.productId)) || {}).inventoryCount || 0) }));
  if (problems.length) throw httpError(409, "ORDER_ITEMS_INVALID", "المخزون مش كفاية لبعض الأصناف", { lines: problems });

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
  if (!order.creditSaleId) throw httpError(409, "ORDER_NOT_DISPATCHED", "الطلب مالوش فاتورة");
  await moveOrder(order._id, ["out_for_delivery"], "refused", { req, set: reason ? { reason } : {}, note: reason, session });

  const res = makeRes();
  await callHandler(() => refundCreditSaleInTransaction(handlerReq(req, { refundAll: true, note: reason || `رفض طلب موقع ${order.number}` }, { id: String(order.creditSaleId) }), res, session), res);
  const creditSale = await CreditSale.findById(order.creditSaleId).select("refunds").session(session).lean();
  const updated = await WebOrder.findByIdAndUpdate(order._id, { $set: { returnIds: returnLogIds(creditSale), collectedAmount: 0 } }, { new: true, session });
  await audit(req, { action: "order.refused", entity: "WebOrder", entityId: order._id, details: { number: order.number, reason }, session, strict: true });
  return updated;
});

module.exports = { confirm, reject, prepare, cancel, edit, dispatch, deliver, refuse, loadOrder, isId };
