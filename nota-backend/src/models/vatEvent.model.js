const mongoose = require("mongoose");

// Stage 21: one row per VAT-affecting document or event, written in the same transaction as the document. The monthly VAT
// return (prepare, drill-down, Excel) and the health check read ONLY these stored rows, never the current rate.
// `vat` is signed: a sale/purchase/expense adds, a return/cancel/edit-decrease takes away. `period` is the vatPeriod of the
// event's own business date (the first unfiled month after it when that month's return is already filed).
const vatEventSchema = new mongoose.Schema({
  kind: { type: String, required: true, enum: ["sale", "sale_edit", "sale_cancel", "sale_return", "purchase", "purchase_cancel", "purchase_return", "expense", "expense_cancel"], index: true },
  direction: { type: String, required: true, enum: ["output", "input"], index: true },
  sourceType: { type: String, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  number: { type: String },
  date: { type: Date, required: true },
  period: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
  net: { type: Number, required: true },
  vat: { type: Number, required: true },
}, { timestamps: true });

vatEventSchema.index({ period: 1, direction: 1, kind: 1 });
module.exports = mongoose.model("VatEvent", vatEventSchema);
