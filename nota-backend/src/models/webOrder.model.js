const mongoose = require("mongoose");

const ORDER_STATUSES = ["new", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled", "rejected"];
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
    statusHistory: {
      type: [{ _id: false, status: String, at: Date, by: String }],
      default: [],
    },
    // The same client key twice must give the same order. A hash of the request body tells a retry from a different request.
    idempotencyKey: { type: String, required: true, unique: true },
    requestHash: { type: String, required: true },
    // Only the hash is stored (the token itself is shown once, in the placement response).
    trackingTokenHash: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WebOrder", webOrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
