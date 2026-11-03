const crypto = require("crypto");

const NOTIFICATIONS_API_KEY_HEADER = "x-notifications-key";

const hashKey = (value) => crypto.createHash("sha256").update(String(value)).digest();

// Shared-secret guard for the device registration endpoints. The backend has no
// user auth, so this only keeps random callers from registering devices.
const requireNotificationsApiKey = (req, res, next) => {
  const expectedKey = (process.env.NOTIFICATIONS_API_KEY || "").trim();

  if (!expectedKey) {
    res.status(503);
    return next(new Error("خدمة الإشعارات غير مفعلة على الخادم"));
  }

  const providedKey = req.get(NOTIFICATIONS_API_KEY_HEADER);

  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  if (
    typeof providedKey !== "string" ||
    !crypto.timingSafeEqual(hashKey(providedKey.trim()), hashKey(expectedKey))
  ) {
    res.status(401);
    return next(new Error("مفتاح الإشعارات غير صالح"));
  }

  return next();
};

module.exports = {
  NOTIFICATIONS_API_KEY_HEADER,
  requireNotificationsApiKey,
};
