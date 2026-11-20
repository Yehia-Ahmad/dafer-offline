// Online Stage 7B: the shop's Meta ad account connection. One document (_id "default"). The token and app secret are stored
// encrypted (utils/secretBox) and are never returned by any endpoint: only their last 4 characters.
// This is deliberately NOT part of WebsiteSettings: that document is returned whole to every website.manage user.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: { type: String, default: "default" },
  connected: { type: Boolean, default: false },
  adAccountId: { type: String },
  tokenSealed: { type: String },
  tokenLast4: { type: String },
  appSecretSealed: { type: String },
  appSecretLast4: { type: String },
  account: {
    name: String,
    currency: String,
    timezoneName: String,
    accountStatus: Number,
    disableReason: Number,
  },
  scopes: [String],
  // Online Stage 7C: the Facebook Page (and optionally the Instagram account) the ads are published as. Chosen from Meta's own lists.
  pageId: { type: String },
  pageName: { type: String },
  instagramId: { type: String },
  instagramName: { type: String },
  // Online Stage 7C: the ad account's minimum daily budget in minor units, when Meta exposes it.
  minDailyBudgetMinor: { type: Number },
  connectedAt: Date,
  lastSyncAt: Date,
  lastSyncOkAt: Date,
  lastBackfillAt: Date,
  // A safe, fixed code and message (never Meta's text).
  lastError: { code: String, message: String, at: Date },
  // The daily run is paused after an invalid token / missing permission until the owner reconnects.
  paused: { type: Boolean, default: false },
  // Rate limit back-off: no call before this time.
  retryAfter: Date,
  lastManualSyncAt: Date,
  // The lease lock of the sync (the CLI and the HTTP button are separate processes).
  lockedUntil: Date,
  lockOwner: String,
}, { timestamps: true });

module.exports = mongoose.model("MetaConnection", schema);
