const Device = require("../models/device.model");
const { ensurePaired } = require("../license/clients");
const { isMainPc } = require("../auth/mainPc");

// Stage 19: which PC a request comes from.
//
// The desktop app adds X-Nota-Device-Id (the PC's config.instanceId) and X-Nota-Device-Name (its
// hostname, percent-encoded, at most 64 characters) to every backend request. The backend uses them for two
// things only: the default cash box of that PC, and the PC list shown in "add cash box".
//
// THIS IS NOT AN AUTHENTICATION FACTOR. Anyone with the LAN key can send any id. Permissions, shifts and
// audit stay tied to the signed-in user; a wrong or missing id can only change which box is pre-selected.

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const DEVICE_NAME_MAX = 64;
const THROTTLE_MS = 60 * 1000;

const MAX_REMEMBERED = 500;
// deviceId -> last write time, in insertion order: when it grows past the cap the least recently registered id is dropped.
const lastRegistered = new Map();
const rememberedCount = () => lastRegistered.size;

/** Tests: forget what was registered, so the next request writes again. */
const resetDeviceThrottle = () => lastRegistered.clear();

const validDeviceId = (value) => (typeof value === "string" && DEVICE_ID_PATTERN.test(value.trim()) ? value.trim() : null);

const decodeName = (value) => {
  if (typeof value !== "string") return "";
  let text = value;
  try { text = decodeURIComponent(value); } catch { /* keep the raw text */ }
  return text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DEVICE_NAME_MAX);
};

/**
 * Sets req.deviceId / req.deviceName (an invalid id is ignored) and, for a signed-in user, registers the PC:
 * an upsert of { deviceId, name, role, lastSeenAt } at most once a minute per device, outside any business transaction.
 * Mounted after requireAuth. A registry failure never fails the request.
 */
const deviceContext = ({ now = Date.now, maxEntries = MAX_REMEMBERED } = {}) => async (req, _res, next) => {
  const deviceId = validDeviceId(req.get("x-nota-device-id"));
  if (!deviceId) return next();
  req.deviceId = deviceId;
  req.deviceName = decodeName(req.get("x-nota-device-name"));
  // With users on, only a signed-in request registers a PC; with users off (NOTA_AUTH unset) there is no user to wait for.
  if (req.authEnabled && !req.user) return next();
  const at = now();
  const last = lastRegistered.get(deviceId);
  if (last !== undefined && at - last < THROTTLE_MS) return next();
  lastRegistered.delete(deviceId);
  lastRegistered.set(deviceId, at);
  while (lastRegistered.size > maxEntries) lastRegistered.delete(lastRegistered.keys().next().value);
  try {
    // Stage 24: the main PC is a loopback request that carries the main-PC token. Loopback alone, or an instance id, never makes one "the main PC".
    const set = { lastSeenAt: new Date(at), role: isMainPc(req) ? "main" : "client" };
    if (req.deviceName) set.name = req.deviceName;
    if (set.role === "client") await ensurePaired(deviceId, set);
    else await Device.updateOne({ deviceId }, { $set: set }, { upsert: true });
  } catch (error) {
    lastRegistered.delete(deviceId);
    // Stage 24: a client PC beyond the license's maxClients is refused (on every request, not once a minute).
    if (error && error.responseData && (error.responseData.code === "CLIENT_LIMIT" || error.responseData.code === "CLIENT_REVOKED")) return next(error);
    console.error(`device registry failed: ${error.message}`);
  }
  return next();
};

module.exports = { MAX_REMEMBERED, rememberedCount, DEVICE_ID_PATTERN, DEVICE_NAME_MAX, THROTTLE_MS, deviceContext, resetDeviceThrottle, validDeviceId, decodeName };
