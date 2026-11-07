const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 21: the monthly VAT return (VR-000001). Created when the month is FILED; "prepared" figures are computed on the fly.
//   output  = sales VAT - returns VAT (this vatPeriod)      input = purchases + expenses - purchase returns
//   carriedIn = the credit carried from the previous filed return;  net = output - input - carriedIn
//   offset = min(output, input + carriedIn) posted Dr VAT_PAYABLE / Cr VAT_INPUT
//   payable = max(net, 0) (what is owed for this month);  credit = max(-net, 0) (carried to the next month)
const vatReturnSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  output: { type: Number, required: true },
  input: { type: Number, required: true },
  carriedIn: { type: Number, required: true, default: 0 },
  net: { type: Number, required: true },
  offset: { type: Number, required: true, default: 0 },
  payable: { type: Number, required: true, default: 0 },
  credit: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ["filed", "unfiled"], default: "filed", index: true },
  filedAt: { type: Date, required: true },
  filedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  filedByName: { type: String, trim: true },
  unfileReason: { type: String, trim: true, maxlength: 500 },
  unfiledAt: Date,
  unfiledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

// One FILED return per month (an unfiled one stays as history; the month can be filed again under a new number).
vatReturnSchema.index({ period: 1 }, { unique: true, partialFilterExpression: { status: "filed" } });
vatReturnSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("VatReturn", vatReturnSchema);
