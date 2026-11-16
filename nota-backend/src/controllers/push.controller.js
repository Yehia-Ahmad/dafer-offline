const PushSubscription = require("../models/pushSubscription.model");
const asyncHandler = require("../utils/asyncHandler");
const { httpError } = require("../auth/middleware");
const pushService = require("../push/pushService");

// Online Stage 6A: a signed-in user manages only their own push subscriptions.

const text = (value, max) => (typeof value === "string" ? value.trim() : "").slice(0, max);

const readSubscription = (body) => {
  const endpoint = text(body && body.endpoint, 2048);
  const keys = (body && body.keys) || {};
  const p256dh = text(keys.p256dh, 512);
  const auth = text(keys.auth, 512);
  let url = null;
  try { url = new URL(endpoint); } catch { /* invalid */ }
  if (!url || url.protocol !== "https:") throw httpError(400, "INVALID_SUBSCRIPTION", "اشتراك الإشعارات غير صالح");
  if (!p256dh || !auth) throw httpError(400, "INVALID_SUBSCRIPTION", "اشتراك الإشعارات غير صالح");
  return { endpoint, keys: { p256dh, auth } };
};

// GET /api/push/public-key
const getPublicKey = (_req, res) => {
  res.set("Cache-Control", "no-store");
  const key = pushService.publicKey();
  res.json(key ? { enabled: true, publicKey: key } : { enabled: false });
};

// POST /api/push/subscribe
const subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys } = readSubscription(req.body);
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { $set: { user: req.user._id, keys, deviceId: req.deviceId || "", userAgent: text(req.get("user-agent"), 300) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json({ ok: true });
});

// DELETE /api/push/subscribe (body: { endpoint }). Own subscriptions only; without an endpoint, this device's.
const unsubscribe = asyncHandler(async (req, res) => {
  const endpoint = text(req.body && req.body.endpoint, 2048);
  const filter = { user: req.user._id };
  if (endpoint) filter.endpoint = endpoint;
  else if (req.deviceId) filter.deviceId = req.deviceId;
  else throw httpError(400, "INVALID_SUBSCRIPTION", "اشتراك الإشعارات غير صالح");
  const result = await PushSubscription.deleteMany(filter);
  res.json({ ok: true, removed: result.deletedCount });
});

module.exports = { getPublicKey, subscribe, unsubscribe };
