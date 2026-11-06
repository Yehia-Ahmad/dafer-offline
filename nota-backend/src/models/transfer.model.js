const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const transferSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  fromBoxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  toBoxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  date: { type: Date, required: true },
  note: { type: String, trim: true, maxlength: 500 },
  // "shift_deposit": the deposit made when a shift closes.
  kind: { type: String, enum: ["transfer", "shift_deposit"], default: "transfer" },
  shiftId: { type: mongoose.Schema.Types.ObjectId, ref: "Shift" },
  // Balances around the transfer, as shown in the design (informational snapshot).
  fromBefore: Number, fromAfter: Number, toBefore: Number, toAfter: Number,
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledByName: { type: String, trim: true },
}, { timestamps: true });

transferSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("Transfer", transferSchema);
