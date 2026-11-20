// Online Stage 7B: «سعر الصرف» history for an ad account whose currency is not EGP. rate = EGP per 1 unit of `currency`,
// effective from `effectiveFrom` (a local day). A day uses the latest rate with effectiveFrom <= that day.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  currency: { type: String, required: true, uppercase: true, trim: true },
  rate: { type: Number, required: true, min: 0.000001, max: 1e6 },
  effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  createdByName: { type: String },
}, { timestamps: true });

schema.index({ currency: 1, effectiveFrom: 1 }, { unique: true });

module.exports = mongoose.model("ExchangeRate", schema);
