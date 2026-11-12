const mongoose = require("mongoose");

// Stage 23: how many times each printed document (INV-000125, RC-000007 ...) has been printed.
// One atomic counter per (document number, paper class): _id = "INV-000125|receipt" (80mm) or "INV-000125|page" (A4/A5, PDF).
const printCountSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  number: { type: String },
  paperClass: { type: String, enum: ["receipt", "page"] },
  count: { type: Number, required: true, min: 0, default: 0 },
}, { versionKey: false });

module.exports = mongoose.model("PrintCount", printCountSchema);
