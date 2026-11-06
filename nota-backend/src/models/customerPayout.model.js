const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 19: paying a customer's credit balance (we owe them) out of a box. Dr CUSTOMERS (party) / Cr box.
const customerPayoutSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  date: { type: Date, required: true },
  note: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledByName: { type: String, trim: true },
}, { timestamps: true });

customerPayoutSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("CustomerPayout", customerPayoutSchema);
