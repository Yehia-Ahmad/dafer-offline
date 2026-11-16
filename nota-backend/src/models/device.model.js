const mongoose = require("mongoose");

// Stage 19: the devices (browsers) that talk to the backend (registered from X-Nota-Device-Id / X-Nota-Device-Name).
// Used only to pick a default cash box and to bind a drawer to a device. Not an authentication factor.
// Old documents may still carry a `role` field from the desktop edition; it is ignored (no migration needed).
const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
  name: { type: String, trim: true, maxlength: 64, default: "" },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("Device", deviceSchema);
