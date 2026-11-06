const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 18: one opening balance per customer or supplier, created by the opening wizard.
// It is NOT a sale: it is not a CreditSale, so edit/cancel/return/profit/COGS/dashboard sales never see it.
// `amount` is signed from the party's point of view in the ledger's direction:
//   customer: positive = the customer owes us (Dr CUSTOMERS), negative = we owe the customer (credit).
//   supplier: positive = we owe the supplier (Cr SUPPLIERS), negative = the supplier owes us (advance).
const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true, min: 0.01 },
  paymentDate: { type: Date, required: true },
  note: { type: String, trim: true, maxlength: 500 },
  number: { type: String, trim: true },
  receipt: { type: mongoose.Schema.Types.ObjectId, ref: "Receipt" },
}, { _id: true });

const partyOpeningSchema = new mongoose.Schema({
  partyType: { type: String, enum: ["customer", "supplier"], required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  number: { type: String, trim: true },
  // Customer receipts that collected this opening (suppliers: Stage 20 payments).
  payments: { type: [paymentSchema], default: [] },
}, { timestamps: true });

partyOpeningSchema.index({ partyType: 1, partyId: 1 }, { unique: true });
partyOpeningSchema.virtual("collected").get(function collected() {
  return Math.round(this.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) * 100) / 100;
});
partyOpeningSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("PartyOpening", partyOpeningSchema);
