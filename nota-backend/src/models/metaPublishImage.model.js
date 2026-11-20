// Online Stage 7C: an image the owner uploaded in the publish wizard (one request per image, each at most 8 MB, stored as base64 under
// Mongo's 16 MB document limit). It is first STAGED (publishId "stage-<imageId>") and CLAIMED by the draft that names its imageId; it is
// dropped when its publish is finished or cancelled, and a staged image nobody claimed is dropped after a day.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  publishId: { type: String, required: true, index: true },
  index: { type: Number, required: true },
  imageId: { type: String, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId },
  mime: { type: String, required: true },
  bytesBase64: { type: String, required: true },
}, { timestamps: true });
schema.index({ publishId: 1, index: 1 }, { unique: true });

module.exports = mongoose.model("MetaPublishImage", schema);
