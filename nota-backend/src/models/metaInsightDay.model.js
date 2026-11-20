// Online Stage 7B: one Meta campaign on one day (the day exactly as Meta gives it, in the ad account's time zone).
// Spend is an integer in minor units of the account currency. Nothing here is posted anywhere.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  metaId: { type: String, required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  adAccountId: { type: String },
  currency: { type: String },
  spendMinor: { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
  reach: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  linkClicks: { type: Number, default: 0 },
}, { timestamps: true });

schema.index({ metaId: 1, day: 1 }, { unique: true });
schema.index({ day: 1 });

module.exports = mongoose.model("MetaInsightDay", schema);
