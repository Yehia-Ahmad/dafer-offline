const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 21: a VAT payment (VP-000001): Dr VAT_PAYABLE / Cr box, against one filed return. May be partial.
const vatPaymentSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  returnId: { type: mongoose.Schema.Types.ObjectId, ref: "VatReturn", required: true, index: true },
  period: { type: String, required: true },
  date: { type: Date, required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  reference: { type: String, trim: true, maxlength: 100 },
  note: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
}, { timestamps: true });

vatPaymentSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("VatPayment", vatPaymentSchema);
