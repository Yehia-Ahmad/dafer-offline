// Online Stage 7A: anonymous counters. No IP, no user agent and no customer data is stored here, only the campaign, the shop's
// local day (YYYY-MM-DD), a coarse device type and a random per-browser session id.
const mongoose = require("mongoose");

const DEVICES = ["mobile", "tablet", "desktop", "other"];

const clickSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  device: { type: String, enum: DEVICES, default: "other" },
  count: { type: Number, default: 0 },
});
clickSchema.index({ campaignId: 1, day: 1, device: 1 }, { unique: true });

// One document per campaign, day and browser session: the unique index is the "once per session per day" rule.
const visitSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  sessionId: { type: String, required: true, match: /^[A-Za-z0-9_-]{8,64}$/ },
});
visitSchema.index({ campaignId: 1, day: 1, sessionId: 1 }, { unique: true });

module.exports = {
  CampaignClick: mongoose.model("CampaignClick", clickSchema),
  CampaignVisit: mongoose.model("CampaignVisit", visitSchema),
  DEVICES,
};
