// Online Stage 4: the admin API of website orders (/api/orders). Views are built field by field: the idempotency key, request
// hash and tracking token hash never leave the server.
const mongoose = require("mongoose");
const WebOrder = require("../models/webOrder.model");
const Courier = require("../models/courier.model");
const CreditSale = require("../models/creditSale.model");
const Product = require("../models/product.model");
const DeliveryZone = require("../models/deliveryZone.model");
const asyncHandler = require("../utils/asyncHandler");
const { parsePaginationInteger, buildPaginationMetadata } = require("../utils/pagination");
const { httpError } = require("../auth/middleware");
const { reservedByProduct } = require("../store/reservations");
const Selling = require("../models/selling.model");
const { loadWebsiteSettings } = require("../store/catalog");
const service = require("../services/webOrders.service");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isId = (value) => typeof value === "string" && mongoose.Types.ObjectId.isValid(value);

const isWalletMethod = (method) => WebOrder.WALLET_METHODS.includes(method);
/** Wallet orders: "verified" / "unpaid". Cash on delivery / pickup has no transfer: null. */
const paymentStatusOf = (order) => (isWalletMethod(order.paymentMethod) ? (order.payment && order.payment.status === "verified" ? "verified" : "unpaid") : null);
/** A wallet order whose transfer the shop has not confirmed yet and that is still open. */
const OPEN_STATUSES = ["new", "confirmed", "preparing", "ready_for_pickup"];
const needsTransfer = (order) => paymentStatusOf(order) === "unpaid" && OPEN_STATUSES.includes(order.status);

const DEFAULT_WHATSAPP_TEMPLATE = "أهلاً {الاسم}، تم تأكيد طلبك رقم {رقم الطلب} بإجمالي {الإجمالي} جنيه. مدة التوصيل: {مدة التوصيل}. شكرًا لاختيارك لنا.";

const listView = (order, courierNames) => ({
  id: String(order._id),
  number: order.number,
  status: order.status,
  createdAt: order.createdAt,
  customerName: order.contact.name,
  phone: order.contact.phone,
  zone: order.zone ? order.zone.name : null,
  fulfillment: service.fulfillmentOf(order),
  paymentMethod: order.paymentMethod,
  paymentStatus: paymentStatusOf(order),
  needsTransfer: needsTransfer(order),
  total: order.total,
  // Online Stage 6A (read-only): the number of lines (distinct products, "أصناف"), not the sum of quantities.
  itemsCount: (order.items || []).length,
  courierId: order.courierId ? String(order.courierId) : null,
  courierName: order.courierId ? courierNames.get(String(order.courierId)) || null : null,
});

const buildFilter = (query, { withStatus }) => {
  const filter = {};
  if (withStatus && typeof query.status === "string" && query.status) {
    if (!WebOrder.ORDER_STATUSES.includes(query.status)) throw httpError(400, "INVALID_STATUS", "حالة غير صالحة");
    filter.status = query.status;
  }
  const range = {};
  for (const [key, op, end] of [["from", "$gte", false], ["to", "$lte", true]]) {
    if (typeof query[key] === "string" && query[key]) {
      const date = new Date(query[key]);
      if (Number.isNaN(date.getTime())) throw httpError(400, "INVALID_DATE", "تاريخ غير صالح");
      if (end && /^\d{4}-\d{2}-\d{2}$/.test(query[key])) date.setUTCHours(23, 59, 59, 999);
      range[op] = date;
    }
  }
  if (Object.keys(range).length) filter.createdAt = range;
  // Online Stage 5A: fulfillment, payment method, transfer status. Orders without the fields are delivery / cash on delivery.
  if (typeof query.fulfillment === "string" && query.fulfillment) {
    if (!WebOrder.FULFILLMENTS.includes(query.fulfillment)) throw httpError(400, "INVALID_FULFILLMENT", "طريقة استلام غير صالحة");
    filter.fulfillment = query.fulfillment === "pickup" ? "pickup" : { $ne: "pickup" };
  }
  if (typeof query.paymentMethod === "string" && query.paymentMethod) {
    if (!WebOrder.PAYMENT_METHODS.includes(query.paymentMethod)) throw httpError(400, "INVALID_PAYMENT_METHOD", "طريقة دفع غير صالحة");
    filter.paymentMethod = query.paymentMethod === "cod" ? { $in: ["cod", null] } : query.paymentMethod;
  }
  if (typeof query.payment === "string" && query.payment) {
    if (query.payment === "verified") { filter.paymentMethod = { $in: WebOrder.WALLET_METHODS }; filter["payment.status"] = "verified"; }
    else if (query.payment === "unpaid") { filter.paymentMethod = { $in: WebOrder.WALLET_METHODS }; filter["payment.status"] = { $ne: "verified" }; }
    else throw httpError(400, "INVALID_PAYMENT", "حالة دفع غير صالحة");
  }
  if (query.needsTransfer === "1" || query.needsTransfer === "true") {
    filter.paymentMethod = { $in: WebOrder.WALLET_METHODS };
    filter["payment.status"] = { $ne: "verified" };
    filter.status = { $in: OPEN_STATUSES };
  }
  if (typeof query.courierId === "string" && query.courierId) {
    if (!isId(query.courierId)) throw httpError(400, "INVALID_COURIER", "مندوب غير صالح");
    filter.courierId = new mongoose.Types.ObjectId(query.courierId);
  }
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ number: regex }, { "contact.phone": regex }, { "contact.name": regex }];
  }
  return filter;
};

const courierNamesOf = async (orders) => {
  const ids = [...new Set(orders.map((order) => order.courierId).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const couriers = await Courier.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(couriers.map((courier) => [String(courier._id), courier.name]));
};

// GET /api/orders (orders.view): ?status&from&to&q&courierId&page&limit. `counts` = orders per status for the other filters.
const list = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const limit = parsePaginationInteger(req.query.limit, 20, 100);
  const page = parsePaginationInteger(req.query.page, 1);
  const filter = buildFilter(req.query, { withStatus: true });
  const countFilter = buildFilter(req.query, { withStatus: false });
  const [rows, total, counted] = await Promise.all([
    WebOrder.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    WebOrder.countDocuments(filter),
    WebOrder.aggregate([{ $match: countFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const names = await courierNamesOf(rows);
  const counts = Object.fromEntries(WebOrder.ORDER_STATUSES.map((status) => [status, 0]));
  for (const row of counted) counts[row._id] = row.count;
  res.json({ data: rows.map((order) => listView(order, names)), counts, pagination: buildPaginationMetadata({ page, limit, totalItems: total }) });
});

// GET /api/orders/summary (orders.view): the sidebar badge. Cheap on purpose: the admin app polls it every 20 s.
const summary = asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ newCount: await WebOrder.countDocuments({ status: "new" }) });
});

/** The full order for the order page: lines with stock and reserved-by-others, the courier, the invoice and the history. */
const detailView = async (order) => {
  const ids = order.items.map((line) => String(line.productId));
  const pickup = service.fulfillmentOf(order) === "pickup";
  const [products, reserved, courier, creditSale, cashSale, zone, settings] = await Promise.all([
    Product.find({ _id: { $in: ids } }).select("inventoryCount").lean(),
    reservedByProduct(ids, { excludeOrderId: order._id }),
    order.courierId ? Courier.findById(order.courierId).select("name phone").lean() : null,
    order.creditSaleId ? CreditSale.findById(order.creditSaleId).select("number totalPrice paidAmount remainingAmount status shippingFees refundedAmount").lean() : null,
    order.cashSaleId ? Selling.findById(order.cashSaleId).select("number totalPrice shippingFees refundedAmount refundStatus boxId").lean() : null,
    !pickup && order.zone && order.zone.id ? DeliveryZone.findById(order.zone.id).select("estimatedTime").lean() : null,
    loadWebsiteSettings(),
  ]);
  const stock = new Map(products.map((product) => [String(product._id), Number(product.inventoryCount || 0)]));
  return {
    id: String(order._id),
    number: order.number,
    status: order.status,
    source: order.source,
    paymentMethod: order.paymentMethod,
    fulfillment: service.fulfillmentOf(order),
    // Wallet orders: whether the shop confirmed the transfer (nothing is posted by that; the invoice is the posting).
    payment: {
      status: paymentStatusOf(order),
      verifiedAt: (order.payment && order.payment.verifiedAt) || null,
      verifiedByName: (order.payment && order.payment.verifiedByName) || null,
      reference: (order.payment && order.payment.reference) || null,
    },
    // The ONE invoice of the order: a credit sale (cash on delivery) or a cash sale (pickup / wallet).
    invoice: cashSale
      ? { kind: "cash", id: String(cashSale._id), number: cashSale.number, totalPrice: cashSale.totalPrice, shippingFees: cashSale.shippingFees || 0, refundedAmount: cashSale.refundedAmount || 0, refundStatus: cashSale.refundStatus || "none", boxId: cashSale.boxId ? String(cashSale.boxId) : null }
      : creditSale ? { kind: "credit", id: String(creditSale._id), number: creditSale.number, totalPrice: creditSale.totalPrice, shippingFees: creditSale.shippingFees || 0, refundedAmount: creditSale.refundedAmount || 0, refundStatus: null, boxId: null } : null,
    whatsappTemplate: (settings && settings.whatsappConfirmTemplate) || DEFAULT_WHATSAPP_TEMPLATE,
    deliveryTime: (zone && zone.estimatedTime) || "",
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items.map((line) => ({
      productId: String(line.productId), name: line.name, code: line.code, retailPrice: line.retailPrice, discountPercentage: line.discountPercentage,
      unitPrice: line.unitPrice, vat: line.vat, vatExempt: line.vatExempt, qty: line.qty, lineTotal: line.lineTotal,
      inventoryCount: stock.has(String(line.productId)) ? stock.get(String(line.productId)) : null,
      reservedByOthers: reserved.get(String(line.productId)) || 0,
    })),
    subtotal: order.subtotal, vat: order.vat, vatRate: order.vatRate, vatIncluded: order.vatIncluded, deliveryFee: order.deliveryFee, total: order.total,
    zone: pickup || !order.zone ? null : { id: String(order.zone.id), name: order.zone.name, fee: order.zone.fee },
    contact: { name: order.contact.name, phone: order.contact.phone, address: order.contact.address || "", notes: order.contact.notes || "" },
    storeCustomerId: order.storeCustomer ? String(order.storeCustomer) : null,
    reason: order.reason || null,
    collectedAmount: order.collectedAmount === undefined ? null : order.collectedAmount,
    courier: courier ? { id: String(courier._id), name: courier.name, phone: courier.phone } : null,
    creditSale: creditSale ? { id: String(creditSale._id), number: creditSale.number, totalPrice: creditSale.totalPrice, paidAmount: creditSale.paidAmount, remainingAmount: creditSale.remainingAmount, status: creditSale.status, shippingFees: creditSale.shippingFees } : null,
    paymentIds: (order.paymentIds || []).map(String),
    returnIds: (order.returnIds || []).map(String),
    statusHistory: (order.statusHistory || []).map((row) => ({ status: row.status, at: row.at, by: row.by, byName: row.byName || null, type: row.type || "status", note: row.note || null, details: row.details || null })),
  };
};

// GET /api/orders/delivery-zones (orders.manage): the active zones for the edit form (website.manage is not needed to edit an order).
const zones = asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const rows = await DeliveryZone.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select("name fee").lean();
  res.json({ data: rows.map((zone) => ({ id: String(zone._id), name: zone.name, fee: zone.fee })) });
});

const getOne = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const order = await service.loadOrder(req.params.id);
  res.json(await detailView(order.toObject()));
});

const action = (fn) => asyncHandler(async (req, res) => {
  const order = await fn(req, req.params.id, req.body);
  res.json(await detailView(order.toObject()));
});

module.exports = {
  list,
  summary,
  zones,
  getOne,
  confirm: action(service.confirm),
  reject: action(service.reject),
  prepare: action(service.prepare),
  ready: action(service.markReady),
  verifyPayment: action(service.verifyPayment),
  cancel: action(service.cancel),
  edit: action(service.edit),
  dispatch: action(service.dispatch),
  pickup: action(service.pickup),
  deliver: action(service.deliver),
  refuse: action(service.refuse),
  changeCourier: action(service.changeCourier),
};
