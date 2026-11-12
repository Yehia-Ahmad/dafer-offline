const mongoose = require("mongoose");

// Stage 23: how many times each printed document (INV-000125, RC-000007 ...) has been printed.
// One atomic counter per document number, so two PCs can never both print "the original".
const printCountSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  count: { type: Number, required: true, min: 0, default: 0 },
}, { versionKey: false });

module.exports = mongoose.model("PrintCount", printCountSchema);
