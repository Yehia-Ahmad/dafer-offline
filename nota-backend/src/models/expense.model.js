const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const expenseSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  date: { type: Date, required: true, index: true },
  // The category: a leaf account under 520.
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  note: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledByName: { type: String, trim: true },
}, { timestamps: true });

expenseSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("Expense", expenseSchema);
