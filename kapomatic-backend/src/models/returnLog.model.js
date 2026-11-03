const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productName: { type: String, required: true, trim: true, maxlength: 200 },
  productCode: { type: String, trim: true, maxlength: 100 },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  returnReason: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const returnLogSchema = new mongoose.Schema({
  returnType: { type: String, enum: ["cash", "credit"], required: true, index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  invoiceNumber: { type: String, trim: true, maxlength: 150 },
  invoiceCode: { type: String, trim: true, maxlength: 150 },
  customerName: { type: String, required: true, trim: true, maxlength: 200, index: true },
  customerPhone: { type: String, trim: true, maxlength: 30, index: true },
  returnDate: { type: Date, required: true, index: true },
  note: { type: String, trim: true, maxlength: 1000 },
  items: {
    type: [itemSchema],
    required: true,
    validate: { validator: (items) => items.length > 0, message: "يجب أن يحتوي المرتجع على عناصر" },
  },
  subtotalReturnedAmount: { type: Number, required: true, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  shippingFees: { type: Number, default: 0, min: 0 },
  finalReturnedAmount: { type: Number, required: true, min: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

returnLogSchema.index({ returnDate: -1, createdAt: -1 });
returnLogSchema.index({ "items.productId": 1 });
returnLogSchema.index({ "items.productCode": 1 });

module.exports = mongoose.model("ReturnLog", returnLogSchema);
