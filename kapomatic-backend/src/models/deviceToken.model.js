const mongoose = require("mongoose");

const DEVICE_PLATFORMS = ["android", "ios"];

const deviceTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: [true, "رمز الجهاز مطلوب"],
      unique: true,
      trim: true,
      maxlength: [4096, "رمز الجهاز طويل جدًا"],
    },
    platform: {
      type: String,
      required: [true, "نظام تشغيل الجهاز مطلوب"],
      enum: {
        values: DEVICE_PLATFORMS,
        message: "نظام تشغيل الجهاز غير مدعوم",
      },
    },
    lastSeenAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

const DeviceToken = mongoose.model("DeviceToken", deviceTokenSchema);

DeviceToken.DEVICE_PLATFORMS = DEVICE_PLATFORMS;

module.exports = DeviceToken;
