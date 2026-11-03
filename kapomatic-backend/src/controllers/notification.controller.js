const DeviceToken = require("../models/deviceToken.model");
const asyncHandler = require("../utils/asyncHandler");

const MAX_TOKEN_LENGTH = 4096;

const normalizeDeviceToken = (value, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error("رمز الجهاز مطلوب");
  }

  const token = value.trim();
  if (token.length > MAX_TOKEN_LENGTH) {
    res.status(400);
    throw new Error("رمز الجهاز طويل جدًا");
  }

  return token;
};

const normalizePlatform = (value, res) => {
  const platform = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!DeviceToken.DEVICE_PLATFORMS.includes(platform)) {
    res.status(400);
    throw new Error("نظام تشغيل الجهاز يجب أن يكون android أو ios");
  }

  return platform;
};

const toDeviceTokenResponse = (deviceToken) => ({
  token: deviceToken.token,
  platform: deviceToken.platform,
  createdAt: deviceToken.createdAt,
  lastSeenAt: deviceToken.lastSeenAt,
});

const registerDevice = asyncHandler(async (req, res) => {
  const token = normalizeDeviceToken(req.body?.token, res);
  const platform = normalizePlatform(req.body?.platform, res);
  const now = new Date();

  const deviceToken = await DeviceToken.findOneAndUpdate(
    { token },
    {
      $set: { platform, lastSeenAt: now },
      $setOnInsert: { token, createdAt: now },
    },
    { new: true, upsert: true, runValidators: true, timestamps: false }
  ).lean();

  res.status(200).json(toDeviceTokenResponse(deviceToken));
});

const unregisterDevice = asyncHandler(async (req, res) => {
  const token = normalizeDeviceToken(req.params.token, res);

  await DeviceToken.deleteOne({ token });

  res.status(204).end();
});

module.exports = {
  registerDevice,
  unregisterDevice,
};
