// Online Stage 7C: one attempt to create a Facebook/Instagram campaign from Nota. It holds the spec the owner confirmed and the Meta id
// of every object created so far, saved the moment Meta returns it, so a retry never creates anything twice.
// The ad text and image bytes are NOT kept here (only the hash Meta returns); the spec keeps the text because a retry needs it.
const mongoose = require("mongoose");

const STEPS = ["validate", "campaign", "images", "adset", "creatives", "ads", "link"];
const STEP_STATES = ["pending", "done", "failed"];
const STATUSES = ["draft", "running", "failed", "published", "cancelled"];

const stepSchema = new mongoose.Schema({
  state: { type: String, enum: STEP_STATES, default: "pending" },
  errorCode: { type: String },
  errorMessage: { type: String },
  at: { type: Date },
}, { _id: false });

const adSchema = new mongoose.Schema({
  index: { type: Number, required: true },
  imageHash: { type: String },
  creativeId: { type: String },
  adId: { type: String },
  // What Meta applied to the creative (degrees_of_freedom_spec read back after creating it).
  appliedFeatures: { type: mongoose.Schema.Types.Mixed },
}, { _id: false });

const schema = new mongoose.Schema({
  publishId: { type: String, required: true, unique: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
  adAccountId: { type: String, required: true },
  // The confirmed spec (goal, budget in the account currency, audience, ads with their text and image reference).
  spec: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: STATUSES, default: "draft", index: true },
  steps: { type: Map, of: stepSchema, default: {} },
  metaCampaignId: { type: String, index: true },
  adSetId: { type: String },
  ads: { type: [adSchema], default: [] },
  createdById: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdByName: { type: String },
  publishedAt: { type: Date },
  cancelledAt: { type: Date },
  lastError: { step: String, code: String, message: String, at: Date },
  // Lease lock: a double click or a second tab cannot run the same publish twice.
  lockedUntil: { type: Date },
  lockOwner: { type: String },
}, { timestamps: true });

module.exports = mongoose.model("MetaPublish", schema);
module.exports.STEPS = STEPS;
module.exports.STATUSES = STATUSES;
