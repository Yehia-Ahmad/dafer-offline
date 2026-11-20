// Online Stage 7B: a campaign of the shop's Meta ad account, as read from Meta. `campaignId` links it to a Nota campaign
// (at most one: the partial unique index is only about this side; a Nota campaign may have many).
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  metaId: { type: String, required: true, unique: true },
  // The ad account it was synced from (rows without it count as the current account).
  adAccountId: { type: String, index: true },
  name: { type: String, default: "" },
  status: { type: String },
  effectiveStatus: { type: String },
  objective: { type: String },
  createdTime: { type: Date },
  syncedAt: { type: Date },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", index: true },
  linkedAt: { type: Date },
  linkedByName: { type: String },
  // Online Stage 7C: set only when Nota created this campaign (MetaPublish). Only those can be switched on/off or changed from Nota.
  createdByNota: { type: Boolean, default: false },
  publishId: { type: String },
  // Read back from Meta after a change (minor units of the account currency).
  dailyBudgetMinor: { type: Number },
  lifetimeBudgetMinor: { type: Number },
  endTime: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model("MetaCampaign", schema);
