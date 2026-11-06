const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 19: a place money lives. Every money movement says which box it went into or out of, and
// posts to the box's ledger account. The main box is account 1111 (CASH_MAIN); a cashier drawer is
// a leaf under 111 (11102, 11103, ...); a wallet or bank is a leaf under 112 (112xx).
const cashBoxSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  type: { type: String, enum: ["cash", "wallet", "bank"], required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, unique: true },
  isMain: { type: Boolean, default: false },
  // The PC (its config instanceId) whose sales default to this box. At most one box per device.
  deviceId: { type: String, trim: true, maxlength: 64, default: undefined },
  shiftsEnabled: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

// Exactly one main box, and a device is the default of at most one box (even under concurrent requests).
cashBoxSchema.index({ isMain: 1 }, { unique: true, partialFilterExpression: { isMain: true } });
cashBoxSchema.index({ deviceId: 1 }, { unique: true, partialFilterExpression: { deviceId: { $type: "string" } } });
cashBoxSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("CashBox", cashBoxSchema);
