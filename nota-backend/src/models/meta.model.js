const mongoose = require("mongoose");

const metaSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  version: { type: Number, required: true, min: 0, default: 0 },
  migrationProgress: { type: mongoose.Schema.Types.Mixed, default: undefined },
  ledgerStartAt: { type: Date, default: undefined },
}, { versionKey: false });

module.exports = mongoose.model("Meta", metaSchema);
