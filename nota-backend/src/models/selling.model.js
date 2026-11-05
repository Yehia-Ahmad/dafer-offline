const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const sellingItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    productName: {
      type: String,
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم المنتج عن 200 حرف"],
    },
    categoryName: {
      type: String,
      trim: true,
      maxlength: [120, "يجب ألا يزيد اسم الفئة عن 120 حرف"],
    },
    quantity: {
      type: Number,
      required: [true, "كمية المنتج مطلوبة"],
      min: [1, "يجب أن تكون كمية المنتج 1 على الأقل"],
    },
    unitPrice: {
      type: Number,
      required: [true, "سعر المنتج للوحدة مطلوب"],
      min: [0, "سعر المنتج للوحدة لا يمكن أن يكون سالبًا"],
    },
    totalPrice: {
      type: Number,
      required: [true, "السعر الإجمالي مطلوب"],
      min: [0, "السعر الإجمالي لا يمكن أن يكون سالبًا"],
    },
    purchasePrice: {
      type: Number,
      default: 0,
      min: [0, "سعر الشراء لا يمكن أن يكون سالبًا"],
    },
    profitAmount: {
      type: Number,
      default: 0,
    },
    returnedQuantity: { type: Number, default: 0, min: 0 },
    costEstimated: { type: Boolean, default: false },
  },
  { _id: true }
);

const sellingRefundItemSchema = new mongoose.Schema({
  invoiceItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, required: true, trim: true, maxlength: 200 },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  totalPrice: { type: Number, required: true, min: 0 },
  returnReason: { type: String, trim: true, maxlength: 500 },
}, { _id: true });

const sellingRefundSchema = new mongoose.Schema({
  refundDate: { type: Date, required: true },
  note: { type: String, trim: true, maxlength: 1000 },
  items: { type: [sellingRefundItemSchema], required: true },
  totalQuantity: { type: Number, required: true, min: 1 },
  totalAmount: { type: Number, required: true, min: 0 },
  returnLog: { type: mongoose.Schema.Types.ObjectId, ref: "ReturnLog" },
}, { _id: true });

const sellingSchema = new mongoose.Schema(
  {
    number: { type: String, trim: true, unique: true, sparse: true, index: true },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    productName: {
      type: String,
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم المنتج عن 200 حرف"],
    },
    categoryName: {
      type: String,
      trim: true,
      maxlength: [120, "يجب ألا يزيد اسم الفئة عن 120 حرف"],
    },
    customerName: {
      type: String,
      required: [true, "اسم العميل مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم العميل عن 200 حرف"],
    },
    customerPhone: {
      type: String,
      trim: true,
      maxlength: [30, "يجب ألا يزيد رقم هاتف العميل عن 30 حرف"],
    },
    sellingDate: {
      type: Date,
      required: [true, "تاريخ البيع مطلوب"],
    },
    items: {
      type: [sellingItemSchema],
      default: undefined,
    },
    totalQuantity: {
      type: Number,
      min: [0, "إجمالي الكمية لا يمكن أن يكون سالبًا"],
    },
    discountAmount: {
      type: Number,
      min: [0, "قيمة الخصم لا يمكن أن تكون سالبة"],
    },
    // Legacy field kept optional so older percentage-based records still load safely.
    discountPercentage: {
      type: Number,
      min: [0, "نسبة الخصم لا يمكن أن تكون سالبة"],
      max: [100, "نسبة الخصم لا يمكن أن تتجاوز 100"],
    },
    shippingFees: {
      type: Number,
      default: 0,
      min: [0, "مصاريف الشحن لا يمكن أن تكون سالبة"],
    },

    // Legacy single-line selling fields kept optional so older records still load correctly.
    quantity: {
      type: Number,
      min: [1, "يجب أن تكون كمية المنتج 1 على الأقل"],
    },
    unitPrice: {
      type: Number,
      min: [0, "سعر المنتج للوحدة لا يمكن أن يكون سالبًا"],
    },
    totalPrice: {
      type: Number,
      required: [true, "السعر الإجمالي مطلوب"],
      min: [0, "السعر الإجمالي لا يمكن أن يكون سالبًا"],
    },
    status: { type: String, enum: ["active", "cancelled"], default: "active", index: true },
    cancelledAt: Date,
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    cancelledByName: { type: String, trim: true, maxlength: 100 },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
    cancelRefundAmount: { type: Number, default: 0, min: 0 },
    refundStatus: { type: String, enum: ["none", "partial", "full"], default: "none", index: true },
    refundedQuantity: { type: Number, default: 0, min: 0 },
    refundedAmount: { type: Number, default: 0, min: 0 },
    refunds: { type: [sellingRefundSchema], default: [] },
  },
  { timestamps: true }
);

sellingSchema.index({ "items.product": 1 });
// Stage 12: date-range reads of the dashboard summary.
sellingSchema.index({ sellingDate: -1 });

// Stage 13: createdBy / updatedBy from the signed-in user (nothing when auth is off).
sellingSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("Selling", sellingSchema);
