const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 20: money a supplier gave back (SR-000001, "استرداد من مورد"): Dr box / Cr SUPPLIERS (party).
const supplierRefundSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  date: { type: Date, required: true, index: true },
  note: { type: String, trim: true, maxlength: 500 },
  purchaseReturnId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseReturn" },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted" },
}, { timestamps: true });

supplierRefundSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("SupplierRefund", supplierRefundSchema);
