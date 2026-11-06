const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");
const { endsSetupModePlugin } = require("../accounting/setupState");

const allocationSchema = new mongoose.Schema({
  // Exactly one of creditSale / opening (a customer opening balance, Stage 18).
  creditSale: { type: mongoose.Schema.Types.ObjectId, ref: "CreditSale" },
  opening: { type: mongoose.Schema.Types.ObjectId, ref: "PartyOpening" },
  amount: { type: Number, required: true, min: 0.01 },
}, { _id: false });
allocationSchema.pre("validate", function checkTarget(next) {
  if (Boolean(this.creditSale) === Boolean(this.opening)) return next(new Error("An allocation needs exactly one of creditSale or opening"));
  return next();
});

const receiptSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  paymentDate: { type: Date, required: true, index: true },
  note: { type: String, trim: true, maxlength: 500 },
  kind: { type: String, enum: ["payment", "down_payment"], required: true },
  allocations: { type: [allocationSchema], default: [] },
}, { timestamps: true });

receiptSchema.plugin(auditFieldsPlugin);
receiptSchema.plugin(endsSetupModePlugin);
module.exports = mongoose.model("Receipt", receiptSchema);
