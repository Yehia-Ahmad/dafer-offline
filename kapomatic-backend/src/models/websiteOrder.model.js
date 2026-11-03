const mongoose = require("mongoose");
const {
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_VALUES,
} = require("../utils/orderPayment");
const isBase64Image = require("../utils/isBase64Image");

const websiteOrderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    productCode: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    categoryName: {
      type: String,
      trim: true,
      maxlength: 120,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: true }
);

const websiteOrderSchema = new mongoose.Schema(
  {
    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
    },
    shippingLocation: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    government: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    orderDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    items: {
      type: [websiteOrderItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "يجب أن يحتوي طلب الموقع على منتج واحد على الأقل",
      },
    },
    totalQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    shippingFees: {
      type: Number,
      required: true,
      min: 0,
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "refunded"],
      default: "pending",
      index: true,
    },
    selling: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Selling",
      index: true,
    },
    acceptedAt: Date,
    refundedAt: Date,
    refundReason: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHOD_VALUES,
      required: true,
      default: PAYMENT_METHODS.CASH,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      required: true,
      default: PAYMENT_STATUSES.PENDING,
      index: true,
    },
    transferPhone: {
      type: String,
      trim: true,
      maxlength: 30,
    },
    transferImage: {
      type: String,
      trim: true,
      validate: {
        validator: (value) => value === undefined || value === null || value === "" || isBase64Image(value),
        message: "صورة التحويل يجب أن تكون base64 image صالحة",
      },
    },
    paymentReference: {
      type: String,
      trim: true,
      maxlength: 120,
    },
    paymentNotes: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { timestamps: true }
);

websiteOrderSchema.index({ orderDate: -1, createdAt: -1 });
websiteOrderSchema.index({ paymentStatus: 1, orderDate: -1 });

module.exports = mongoose.model("WebsiteOrder", websiteOrderSchema);
