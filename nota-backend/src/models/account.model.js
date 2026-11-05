const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, index: true },
  nameAr: { type: String, required: true, trim: true },
  nameEn: { type: String, required: true, trim: true },
  type: { type: String, enum: ["asset", "liability", "equity", "revenue", "expense"], required: true },
  normalSide: { type: String, enum: ["debit", "credit"], required: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", default: null, index: true },
  isGroup: { type: Boolean, default: false },
  isSystem: { type: Boolean, default: false },
  systemKey: { type: String, unique: true, sparse: true, index: true },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

accountSchema.index({ parentId: 1, code: 1 });
module.exports = mongoose.model("Account", accountSchema);
