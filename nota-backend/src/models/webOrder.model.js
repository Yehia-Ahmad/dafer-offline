const mongoose = require("mongoose");

const ORDER_STATUSES = ["new", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled", "rejected", "refused"];
// Online Stage 4: statuses whose quantities are reserved (computed from WebOrder, never stored on the product).
const RESERVING_STATUSES = ["confirmed", "preparing"];
// An order can be edited until it leaves with the courier.
const EDITABLE_STATUSES = ["new", "confirmed", "preparing"];
const PAYMENT_METHODS = ["cod"];

const itemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    code: { type: String },
    retailPrice: { type: Number, required: true, min: 0 },
    discountPercentage: { type: Number, default: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    vat: { type: Number, default: 0 },
    vatExempt: { type: Boolean, default: false },
    qty: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// The order as the customer saw it. A snapshot: never recalculated from products, zones or settings afterwards.
const webOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    status: { type: String, enum: ORDER_STATUSES, default: "new", index: true },
    source: { type: String, enum: ["website"], default: "website" },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: "cod" },
    items: { type: [itemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    vat: { type: Number, default: 0 },
    vatRate: { type: Number },
    vatIncluded: { type: Boolean },
    deliveryFee: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    zone: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: "DeliveryZone", required: true },
      name: { type: String, required: true },
      fee: { type: Number, required: true },
    },
    contact: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      address: { type: String, required: true },
      notes: { type: String },
    },
    storeCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "StoreCustomer", index: true },
    // Public views only read { status, at }. Stage 4 adds who (name), the reason/note and, for an edit, what changed.
    statusHistory: {
      type: [{ _id: false, status: String, at: Date, by: String, byName: String, type: { type: String }, note: String, details: mongoose.Schema.Types.Mixed }],
      default: [],
    },
    // Online Stage 4: what the order created, and who carries it.
    courierId: { type: mongoose.Schema.Types.ObjectId, ref: "Courier", index: true },
    creditSaleId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditSale" },
    paymentIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    returnIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    collectedAmount: { type: Number },
    reason: { type: String },
    // The same client key twice must give the same order. A hash of the request body tells a retry from a different request.
    idempotencyKey: { type: String, required: true, unique: true },
    requestHash: { type: String, required: true },
    // Only the hash is stored (the token itself is shown once, in the placement response).
    trackingTokenHash: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

// Reservation lookups (confirmed/preparing quantities per product) and the admin list filters.
webOrderSchema.index({ status: 1, "items.productId": 1 });
webOrderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("WebOrder", webOrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.RESERVING_STATUSES = RESERVING_STATUSES;
module.exports.EDITABLE_STATUSES = EDITABLE_STATUSES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
