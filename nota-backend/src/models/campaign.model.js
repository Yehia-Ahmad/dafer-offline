// Online Stage 7A: an advertising campaign with its own tracking code. Results are read from orders, invoices and expenses;
// nothing here is read by sales, returns, payments or stock.
const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const PLATFORMS = ["facebook", "instagram", "tiktok", "whatsapp", "messenger", "other"];
const TYPES = ["paid", "organic"];
const STATUSES = ["active", "ended", "archived"];
const LANDING_KINDS = ["home", "product", "category", "path"];

const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  code: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9][a-z0-9_-]{2,31}$/ },
  platform: { type: String, enum: PLATFORMS, required: true },
  type: { type: String, enum: TYPES, required: true },
  landing: {
    kind: { type: String, enum: LANDING_KINDS, default: "home" },
    ref: { type: mongoose.Schema.Types.ObjectId },
    path: { type: String, maxlength: 300 },
  },
  // Business days (UTC midnight), like every stored date in Nota.
  startDate: { type: Date, required: true },
  endDate: { type: Date },
  plannedBudget: { type: Number, min: 0 },
  notes: { type: String, trim: true, maxlength: 1000 },
  status: { type: String, enum: STATUSES, default: "active", index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdByName: { type: String, trim: true },
}, { timestamps: true });

campaignSchema.plugin(auditFieldsPlugin);

module.exports = mongoose.model("Campaign", campaignSchema);
module.exports.PLATFORMS = PLATFORMS;
module.exports.TYPES = TYPES;
module.exports.STATUSES = STATUSES;
module.exports.LANDING_KINDS = LANDING_KINDS;
