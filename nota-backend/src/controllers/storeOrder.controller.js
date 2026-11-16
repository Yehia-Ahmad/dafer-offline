// Online Stage 3: placing a website order, tracking it, and a customer's own orders. The server prices everything; the
// body is only read for product ids, quantities, the zone id, contact data and the idempotency key. Placing an order
// reserves and deducts no stock (Stage 4 does that when the shop confirms and invoices it).
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Product = require("../models/product.model");
const DeliveryZone = require("../models/deliveryZone.model");
const WebOrder = require("../models/webOrder.model");
const CashBox = require("../models/cashBox.model");
const asyncHandler = require("../utils/asyncHandler");
const { withTransaction } = require("../utils/transaction");
const { PREFIXES, nextDocumentNumber } = require("../utils/documentNumber");
const { parsePaginationInteger, buildPaginationMetadata } = require("../utils/pagination");
const { httpError } = require("../auth/middleware");
const { normalizeStorePhone } = require("../utils/storePhone");
const { priceWebOrder } = require("../store/orderPricing");
const catalog = require("../store/catalog");
const wl = require("../store/whitelist");
const { withAvailableStock } = require("../store/reservations");

const MAX_LINES = 50;
const MAX_QTY = 99;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (code, message) => httpError(400, code, message);
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** The tracking token of an order is derived from the secret and the idempotency key, so a retry returns the same one
 *  while only its hash is stored. */
const trackingTokenFor = (secret, idempotencyKey) => crypto.createHmac("sha256", secret).update(`track:${idempotencyKey.toLowerCase()}`).digest("base64url");

const readItems = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LINES) throw fail("INVALID_ITEMS", `الطلب من 1 إلى ${MAX_LINES} صنف`);
  const seen = new Set();
  return value.map((row) => {
    const productId = row && typeof row.productId === "string" ? row.productId.toLowerCase() : "";
    if (!mongoose.Types.ObjectId.isValid(productId) || String(new mongoose.Types.ObjectId(productId)) !== productId) throw fail("INVALID_ITEMS", "معرّف منتج غير صالح");
    if (seen.has(productId)) throw fail("DUPLICATE_PRODUCT", "المنتج مكرر في الطلب");
    seen.add(productId);
    const qty = row.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw fail("INVALID_QTY", `الكمية من 1 إلى ${MAX_QTY}`);
    return { productId, qty };
  });
};

// Pickup: the address is optional (a delivery order must have one).
const readContact = (input, { addressRequired = true } = {}) => {
  const body = input && typeof input === "object" ? input : {};
  const name = str(body.name, 121);
  const phone = normalizeStorePhone(body.phone);
  const address = str(body.address, 501);
  if (!name || name.length > 120) throw fail("INVALID_CONTACT", "الاسم مطلوب");
  if (!phone) throw fail("INVALID_PHONE", "رقم الموبايل غير صالح");
  if ((addressRequired && !address) || address.length > 500) throw fail("INVALID_CONTACT", "العنوان مطلوب");
  return { name, phone, address, notes: str(body.notes, 500) };
};

// quote (Online Stage 5B): the same body as placing, but no idempotency key and no contact are needed (the price depends on
// the items, the fulfillment, the zone and the payment method only). A saved address id is still checked.
const readOrderRequest = (body, customer, { quote = false } = {}) => {
  const input = body && typeof body === "object" ? body : {};
  if (!quote && (typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey))) throw fail("INVALID_IDEMPOTENCY_KEY", "مفتاح الطلب غير صالح");
  const items = readItems(input.items);
  // Online Stage 5A: how the customer gets the order and how they pay. Absent = delivery / cash on delivery (the Stage 3 request).
  const fulfillment = input.fulfillment === undefined ? "delivery" : input.fulfillment;
  if (!WebOrder.FULFILLMENTS.includes(fulfillment)) throw fail("INVALID_FULFILLMENT", "طريقة الاستلام غير صالحة");
  const paymentMethod = input.paymentMethod === undefined ? "cod" : input.paymentMethod;
  if (!WebOrder.PAYMENT_METHODS.includes(paymentMethod)) throw fail("INVALID_PAYMENT_METHOD", "طريقة الدفع غير صالحة");
  const zoneId = fulfillment === "pickup" ? null : (typeof input.zoneId === "string" && mongoose.Types.ObjectId.isValid(input.zoneId) ? input.zoneId : null);
  if (fulfillment === "delivery" && !zoneId) throw fail("INVALID_ZONE", "اختار منطقة التوصيل");
  if (quote) {
    if (input.addressId !== undefined && input.addressId !== null && input.addressId !== "" && !(customer && mongoose.Types.ObjectId.isValid(input.addressId) && customer.addresses.id(input.addressId))) {
      throw fail("INVALID_ADDRESS", "العنوان المحفوظ غير موجود");
    }
    return { items, zoneId, fulfillment, paymentMethod };
  }
  let contact;
  if (input.addressId !== undefined && input.addressId !== null && input.addressId !== "") {
    const saved = customer && mongoose.Types.ObjectId.isValid(input.addressId) ? customer.addresses.id(input.addressId) : null;
    if (!saved) throw fail("INVALID_ADDRESS", "العنوان المحفوظ غير موجود");
    contact = { name: customer.name, phone: customer.phone, address: saved.address, notes: str(input.contact && input.contact.notes, 500) || saved.notes || "" };
  } else {
    contact = readContact(input.contact, { addressRequired: fulfillment === "delivery" });
  }
  const canonical = {
    items: [...items].sort((a, b) => (a.productId < b.productId ? -1 : 1)),
    zoneId: zoneId ? zoneId.toLowerCase() : undefined,
    contact,
    customerId: customer ? String(customer._id) : null,
    // Only when not the default, so the hash of a Stage 3 / 4 request (and its idempotent retry) does not change.
    ...(fulfillment !== "delivery" ? { fulfillment } : {}),
    ...(paymentMethod !== "cod" ? { paymentMethod } : {}),
  };
  return { idempotencyKey: input.idempotencyKey.toLowerCase(), items, zoneId, fulfillment, paymentMethod, contact, requestHash: sha256(JSON.stringify(canonical)) };
};

const createStoreOrderController = ({ secret }) => {
  const placed = (order, idempotencyKey) => wl.publicPlacedOrder(order, trackingTokenFor(secret, idempotencyKey));

  const findExisting = async (request, customer, session) => {
    const existing = await WebOrder.findOne({ idempotencyKey: request.idempotencyKey }).session(session || null);
    if (!existing) return null;
    if (existing.requestHash !== request.requestHash || String(existing.storeCustomer || "") !== String(customer ? customer._id : "")) {
      throw httpError(409, "IDEMPOTENCY_MISMATCH", "مفتاح الطلب مستخدم لطلب مختلف");
    }
    return existing;
  };

  // Everything that decides whether an order can be placed and what it costs; shared by placing and the quote (Online Stage 5B).
  // Writes nothing.
  const validateAndPrice = async (request, session) => {
    const scope = await catalog.storeScope({ session });
    const { settings, rules } = scope;
    if (!settings || !settings.enabled) throw httpError(503, "STORE_CLOSED", "الموقع مقفول حاليًا");
    if (settings.orderingEnabled === false) throw httpError(409, "ORDERING_DISABLED", "استقبال الطلبات متوقف حاليًا");

    // Online Stage 5A: a fulfillment or payment option the shop switched off (or a wallet whose box is no longer usable) is refused.
    if (!rules.fulfillment[request.fulfillment]) throw httpError(409, "FULFILLMENT_UNAVAILABLE", "طريقة الاستلام دي مش متاحة");
    if (!rules.payments[request.paymentMethod].enabled) throw httpError(409, "PAYMENT_UNAVAILABLE", "طريقة الدفع دي مش متاحة");
    if (request.paymentMethod !== "cod") {
      const box = await CashBox.findById(rules.payments[request.paymentMethod].boxId).select("type isActive").session(session).lean();
      if (!box || !box.isActive || !["wallet", "bank"].includes(box.type)) throw httpError(409, "PAYMENT_UNAVAILABLE", "طريقة الدفع دي مش متاحة");
    }

    const pickup = request.fulfillment === "pickup";
    const zone = pickup ? null : await DeliveryZone.findOne({ _id: request.zoneId, isActive: true }).session(session).lean();
    if (!pickup && !zone) throw httpError(409, "ZONE_UNAVAILABLE", "منطقة التوصيل غير متاحة");

    const filter = scope.filter;
    const products = await Product.find({ ...filter, _id: { $in: request.items.map((row) => row.productId), ...(filter._id || {}) } })
      .select("name code retailPrice discountPercentage inventoryCount vatExempt")
      .session(session)
      .lean();
    // Online Stage 4: the placement check uses inventoryCount - reserved by confirmed/preparing orders.
    const byId = new Map((await withAvailableStock(products, { session })).map((product) => [String(product._id), product]));

    const problems = [];
    const lines = [];
    for (const row of request.items) {
      const product = byId.get(row.productId);
      if (!product) {
        problems.push({ productId: row.productId, reason: "not_available" });
      } else if (row.qty > Number(product.inventoryCount || 0)) {
        problems.push({ productId: row.productId, reason: "quantity_exceeds_stock", max: wl.maxOrderQtyOf(product) });
      } else {
        lines.push({ product, qty: row.qty });
      }
    }
    if (problems.length) {
      const error = httpError(409, "ORDER_ITEMS_INVALID", "بعض الأصناف غير متاحة أو الكمية أكبر من المتاح");
      error.responseData.lines = problems;
      throw error;
    }

    // Pickup: no zone, delivery fee 0 (priced like a delivery order with a zero fee, so VAT and the total use the same code).
    const priced = await priceWebOrder({ lines, zone: pickup ? { fee: 0 } : zone, settings, session, ...(pickup ? { feeOverride: 0 } : {}) });
    if (settings.minOrderAmount !== undefined && settings.minOrderAmount !== null && priced.subtotal < Number(settings.minOrderAmount)) {
      const error = httpError(409, "MIN_ORDER_NOT_REACHED", "الطلب أقل من الحد الأدنى");
      error.responseData.minOrderAmount = Number(settings.minOrderAmount);
      throw error;
    }
    return { zone, pickup, priced };
  };

  const buildOrder = async (request, customer, session) => {
    const existing = await findExisting(request, customer, session);
    if (existing) return { order: existing, created: false };

    const { zone, pickup, priced } = await validateAndPrice(request, session);

    const number = await nextDocumentNumber(PREFIXES.WEB_ORDER, session);
    const at = new Date();
    const [order] = await WebOrder.create([{
      number,
      status: "new",
      source: "website",
      fulfillment: request.fulfillment,
      paymentMethod: request.paymentMethod,
      ...(request.paymentMethod !== "cod" ? { payment: { status: "unpaid" } } : {}),
      items: priced.items,
      subtotal: priced.subtotal,
      vat: priced.vat,
      ...(priced.vatRate !== undefined ? { vatRate: priced.vatRate, vatIncluded: priced.vatIncluded } : {}),
      deliveryFee: priced.deliveryFee,
      total: priced.total,
      ...(pickup ? {} : { zone: { id: zone._id, name: zone.name, fee: zone.fee } }),
      contact: request.contact,
      ...(customer ? { storeCustomer: customer._id } : {}),
      statusHistory: [{ status: "new", at, by: customer ? `customer:${customer._id}` : "guest" }],
      idempotencyKey: request.idempotencyKey,
      requestHash: request.requestHash,
      trackingTokenHash: sha256(trackingTokenFor(secret, request.idempotencyKey)),
    }], { session });
    return { order, created: true };
  };

  const placeOrder = asyncHandler(async (req, res) => {
    const customer = req.storeCustomer || null;
    const request = readOrderRequest(req.body, customer);
    let result;
    try {
      result = await withTransaction((session) => buildOrder(request, customer, session));
    } catch (error) {
      if (!(error && error.code === 11000)) throw error;
      // A parallel request with the same key won the unique index: answer with its order.
      const existing = await findExisting(request, customer);
      if (!existing) throw error;
      result = { order: existing, created: false };
    }
    res.status(result.created ? 201 : 200).json(placed(result.order, request.idempotencyKey));
  });

  // Online Stage 5B: price an order without creating anything (no key lookup, no document number, no transaction).
  const quoteOrder = asyncHandler(async (req, res) => {
    const request = readOrderRequest(req.body, req.storeCustomer || null, { quote: true });
    const { zone, priced } = await validateAndPrice(request, null);
    res.json(wl.publicQuote({ priced, fulfillment: request.fulfillment, paymentMethod: request.paymentMethod, zone }));
  });

  const trackOrder = asyncHandler(async (req, res) => {
    const token = typeof req.params.token === "string" ? req.params.token : "";
    if (!token || token.length > 100) throw httpError(404, "NOT_FOUND", "غير موجود");
    const order = await WebOrder.findOne({ trackingTokenHash: sha256(token) }).lean();
    if (!order) throw httpError(404, "NOT_FOUND", "غير موجود");
    res.json(wl.publicTracking(order));
  });

  const ownOrder = async (req) => {
    const id = req.params.id;
    const order = mongoose.Types.ObjectId.isValid(id) ? await WebOrder.findOne({ _id: id, storeCustomer: req.storeCustomer._id }).lean() : null;
    if (!order) throw httpError(404, "NOT_FOUND", "الطلب غير موجود");
    return order;
  };

  const listMyOrders = asyncHandler(async (req, res) => {
    const limit = parsePaginationInteger(req.query.limit, 10, 50);
    const page = parsePaginationInteger(req.query.page, 1);
    const filter = { storeCustomer: req.storeCustomer._id };
    const [rows, total] = await Promise.all([
      WebOrder.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      WebOrder.countDocuments(filter),
    ]);
    res.json({ data: rows.map(wl.publicOwnOrder), pagination: buildPaginationMetadata({ page, limit, totalItems: total }) });
  });

  const getMyOrder = asyncHandler(async (req, res) => res.json(wl.publicOwnOrder(await ownOrder(req))));

  const cancelMyOrder = asyncHandler(async (req, res) => {
    const own = await ownOrder(req);
    // Online Stage 5A review: once the shop confirmed the transfer, the customer cannot cancel on their own (a refund is outside Nota).
    if (own.payment && own.payment.status === "verified" && own.status === "new") throw httpError(409, "PAYMENT_VERIFIED", "التحويل اتأكد. كلّم المحل لو عايز تلغي الطلب");
    const order = await WebOrder.findOneAndUpdate(
      { _id: req.params.id, storeCustomer: req.storeCustomer._id, status: "new", "payment.status": { $ne: "verified" } },
      { $set: { status: "cancelled" }, $push: { statusHistory: { status: "cancelled", at: new Date(), by: `customer:${req.storeCustomer._id}` } } },
      { new: true }
    ).lean();
    if (!order) throw httpError(409, "NOT_CANCELLABLE", "مينفعش إلغاء الطلب بعد ما المحل بدأ يتعامل معاه");
    res.json(wl.publicOwnOrder(order));
  });

  return { placeOrder, quoteOrder, trackOrder, listMyOrders, getMyOrder, cancelMyOrder };
};

module.exports = { createStoreOrderController, trackingTokenFor };
