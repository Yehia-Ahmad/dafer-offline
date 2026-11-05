const mongoose = require("mongoose");

const metaSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  version: { type: Number, required: true, min: 0, default: 0 },
}, { versionKey: false });

module.exports = mongoose.model("Meta", metaSchema);
