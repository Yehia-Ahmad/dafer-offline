// Online Stage 7A: a person who asked through a message or a lead form. "Bought?" is never stored: it is looked up when the
// lead is read (leads.service.js), so nothing in the sales code knows about leads.
const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const SOURCES = ["facebook", "instagram", "tiktok", "whatsapp", "messenger", "website", "walk_in", "other"];
const STATUSES = ["new", "contacted", "interested", "not_interested"];

const leadSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  // Normalized like StoreCustomer (01xxxxxxxxx). Optional when a profile link is given.
  phone: { type: String },
  profileLink: { type: String, trim: true, maxlength: 300 },
  source: { type: String, enum: SOURCES, required: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", index: true },
  status: { type: String, enum: STATUSES, default: "new", index: true },
  notes: { type: String, trim: true, maxlength: 2000 },
  // Business day (UTC midnight).
  lastContactDate: { type: Date },
  noteLog: {
    type: [{ _id: false, at: Date, byName: String, text: { type: String, maxlength: 1000 } }],
    default: [],
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdByName: { type: String, trim: true },
}, { timestamps: true });

// A phone is unique among leads that have one.
leadSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });

leadSchema.plugin(auditFieldsPlugin);

module.exports = mongoose.model("Lead", leadSchema);
module.exports.SOURCES = SOURCES;
module.exports.STATUSES = STATUSES;
