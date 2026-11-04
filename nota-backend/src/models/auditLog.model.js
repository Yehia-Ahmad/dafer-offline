const mongoose = require("mongoose");

// Stage 13: sensitive actions (who, what, when). Never holds passwords, hashes, tokens or codes:
// src/auth/audit.js filters `details` before saving.
const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    userName: { type: String, trim: true },
    action: { type: String, required: true, trim: true },
    entity: { type: String, trim: true },
    entityId: { type: String, trim: true },
    details: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, trim: true },
  },
  { versionKey: false }
);

auditLogSchema.index({ at: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
