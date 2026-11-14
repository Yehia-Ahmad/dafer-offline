const mongoose = require("mongoose");

// Stage 19: the PCs that talk to the backend (registered from X-Nota-Device-Id / X-Nota-Device-Name).
// Used only to pick a default cash box and to bind a drawer to a PC. Not an authentication factor.
const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
  name: { type: String, trim: true, maxlength: 64, default: "" },
  role: { type: String, enum: ["main", "client"], default: "client" },
  lastSeenAt: { type: Date, default: Date.now },
  // Stage 24: a client PC holds one of the license's maxClients slots while paired. The owner can unpair it to free the slot.
  paired: { type: Boolean, default: false },
  pairedAt: { type: Date, default: undefined },
  // Stage 24: the owner unpaired it. A revoked PC cannot pair itself again; the owner re-allows it from the license card.
  revoked: { type: Boolean, default: false },
  revokedAt: { type: Date, default: undefined },
}, { timestamps: true });

module.exports = mongoose.model("Device", deviceSchema);
