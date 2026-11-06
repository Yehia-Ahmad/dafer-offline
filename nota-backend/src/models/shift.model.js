const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const breakdownSchema = new mongoose.Schema({
  key: { type: String, required: true },
  amount: { type: Number, required: true },
}, { _id: false });

const shiftSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  userName: { type: String, trim: true },
  openedAt: { type: Date, required: true },
  // Informational: what the user counted in the drawer when opening. It posts no entry.
  openingFloat: { type: Number, required: true, min: 0 },
  // The box's ledger balance when the shift opened (shown next to the float).
  openingBalance: { type: Number, default: 0 },
  closedAt: { type: Date },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  closedByName: { type: String, trim: true },
  expected: { type: Number },
  counted: { type: Number, min: 0 },
  difference: { type: Number },
  differenceNote: { type: String, trim: true, maxlength: 500 },
  depositBoxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox" },
  depositAmount: { type: Number, min: 0, default: 0 },
  depositTransferId: { type: mongoose.Schema.Types.ObjectId, ref: "Transfer" },
  // The expected-cash lines as they were at close (a closed shift's report never changes).
  breakdown: { type: [breakdownSchema], default: undefined },
  status: { type: String, enum: ["open", "closed"], default: "open", index: true },
}, { timestamps: true });

// One open shift per box, even under concurrent requests.
shiftSchema.index({ boxId: 1 }, { unique: true, partialFilterExpression: { status: "open" } });
shiftSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("Shift", shiftSchema);
