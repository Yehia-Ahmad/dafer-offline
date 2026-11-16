const mongoose = require("mongoose");

// Online Stage 6A: one Web Push subscription of one browser/phone, owned by the signed-in user who created it.
// The endpoint is unique: if the same browser signs in as someone else, the row moves to that user.
const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  deviceId: { type: String, trim: true, maxlength: 64, default: "" },
  endpoint: { type: String, required: true, unique: true, maxlength: 2048 },
  keys: {
    p256dh: { type: String, required: true, maxlength: 512 },
    auth: { type: String, required: true, maxlength: 512 },
  },
  userAgent: { type: String, trim: true, maxlength: 300, default: "" },
  lastSuccessAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
