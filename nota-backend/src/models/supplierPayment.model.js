const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 20: a payment voucher (PV-000001): Dr SUPPLIERS (party) / Cr box. purchaseId is set when it was paid with a purchase invoice.
const supplierPaymentSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
  date: { type: Date, required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  reference: { type: String, trim: true, maxlength: 100 },
  note: { type: String, trim: true, maxlength: 500 },
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", index: true },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledByName: { type: String, trim: true },
}, { timestamps: true });

supplierPaymentSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("SupplierPayment", supplierPaymentSchema);
