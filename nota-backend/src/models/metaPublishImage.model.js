// Online Stage 7C: an image the owner uploaded in the publish wizard, kept (base64) only until its publish is finished or cancelled,
// so a retry of the image step does not need the browser again. One document per image (each at most 8 MB, under Mongo's 16 MB limit).
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  publishId: { type: String, required: true, index: true },
  index: { type: Number, required: true },
  mime: { type: String, required: true },
  bytesBase64: { type: String, required: true },
}, { timestamps: true });
schema.index({ publishId: 1, index: 1 }, { unique: true });

module.exports = mongoose.model("MetaPublishImage", schema);
