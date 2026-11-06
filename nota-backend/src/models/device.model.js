const mongoose = require("mongoose");

// Stage 19: the PCs that talk to the backend (registered from X-Nota-Device-Id / X-Nota-Device-Name).
// Used only to pick a default cash box and to bind a drawer to a PC. Not an authentication factor.
const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
  name: { type: String, trim: true, maxlength: 64, default: "" },
  role: { type: String, enum: ["main", "client"], default: "client" },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("Device", deviceSchema);
