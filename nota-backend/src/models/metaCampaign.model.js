// Online Stage 7B: a campaign of the shop's Meta ad account, as read from Meta. `campaignId` links it to a Nota campaign
// (at most one: the partial unique index is only about this side; a Nota campaign may have many).
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  metaId: { type: String, required: true, unique: true },
  name: { type: String, default: "" },
  status: { type: String },
  effectiveStatus: { type: String },
  objective: { type: String },
  createdTime: { type: Date },
  syncedAt: { type: Date },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", index: true },
  linkedAt: { type: Date },
  linkedByName: { type: String },
}, { timestamps: true });

module.exports = mongoose.model("MetaCampaign", schema);
