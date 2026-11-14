// Stage 24: who a request comes from, for the client limit. Mounted on /api right after the license lock and BEFORE any route
// (login included).
//
//   * The main PC is a request over loopback (127.0.0.1 / ::1) that ALSO carries the per-start main-PC token (auth/mainPc.js), which only
//     Electron main knows and only its own windows send. A device id, including the main PC's own instance id (anyone with the LAN key
//     can read it from /api/lan/info), never makes a request "the main PC"; neither does loopback alone (a TCP forwarder on the main PC
//     relays LAN requests to 127.0.0.1): a loopback request without the token is handled as a client PC.
//   * Every other request must carry a valid X-Nota-Device-Id, else 400 DEVICE_ID_REQUIRED: a client PC cannot dodge being counted by
//     leaving the header out. Exception: /api/lan/* (the discovery probe a client makes before it has an identity).
//   * One device id seen from a different IP address within the last 2 minutes is refused for the new address (403 DEVICE_IN_USE): a paired
//     id copied to another PC does not work while the first PC is using it. This part runs only on AUTHENTICATED requests (deviceInUse,
//     mounted after the auth middleware): an unauthenticated or 401 request neither records an address nor blocks anyone, so nobody can lock
//     a client out by sending its id from elsewhere.
//
// Honest limit: the id is still just a header. Copy it to a second PC while the first one is OFF (or after 2 minutes of silence) and that PC
// takes over the same slot. This stops casual sharing; it is not a hard lock (docs/OFFLINE_PLAN.md).
const { isMainPc } = require("../auth/mainPc");
const { validDeviceId } = require("./device.middleware");

const SAME_ID_OTHER_IP_WINDOW_MS = 2 * 60 * 1000;
const MAX_REMEMBERED = 2000;

// deviceId -> { ip, at } of the last ACCEPTED request, in insertion order (the oldest is dropped past the cap).
const lastSeen = new Map();
const resetDeviceGate = () => lastSeen.clear();

const httpError = (statusCode, code, message, messageEn) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code, messageEn };
  return error;
};

// ::ffff:192.168.1.5 and 192.168.1.5 are the same PC.
const normalizeIp = (ip) => String(ip || "").replace(/^::ffff:/i, "");

const isDiscoveryPath = (path) => path === "/lan" || path.startsWith("/lan/");

const deviceGate = () => (req, _res, next) => {
  if (req.method === "OPTIONS" || isMainPc(req) || isDiscoveryPath(req.path)) return next();
  const deviceId = validDeviceId(req.get("x-nota-device-id"));
  if (!deviceId) {
    return next(httpError(400, "DEVICE_ID_REQUIRED",
      "الجهاز ده لازم يبعت رقم جهازه. حدّث البرنامج على الجهاز الفرعي.",
      "This PC must send its device id. Update the app on the client PC."));
  }
  return next();
};

/** Mounted AFTER the auth middleware: the 2-minute same-id-other-IP check and the last-seen address, for authenticated requests only. */
const inUseCheck = (req, { now = Date.now, windowMs = SAME_ID_OTHER_IP_WINDOW_MS } = {}) => {
  if (req.method === "OPTIONS" || isMainPc(req) || isDiscoveryPath(req.path)) return null;
  const deviceId = validDeviceId(req.get("x-nota-device-id"));
  if (!deviceId) return null;
  const ip = normalizeIp(req.ip);
  const at = now();
  const seen = lastSeen.get(deviceId);
  if (seen && seen.ip !== ip && at - seen.at < windowMs) {
    return httpError(403, "DEVICE_IN_USE",
      "رقم الجهاز ده بيستخدمه جهاز تاني دلوقتي. كل جهاز لازم يكون له رقمه الخاص.",
      "This device id is being used by another PC right now. Each PC needs its own id.");
  }
  lastSeen.delete(deviceId);
  lastSeen.set(deviceId, { ip, at });
  while (lastSeen.size > MAX_REMEMBERED) lastSeen.delete(lastSeen.keys().next().value);
  return null;
};

const deviceInUse = (options) => (req, _res, next) => {
  if (req.authEnabled && !req.user) return next(); // not signed in: records nothing, blocks nothing
  return next(inUseCheck(req, options) || undefined);
};

/** Login calls this AFTER the credentials were verified: a copied id is refused at sign-in (403 DEVICE_IN_USE), not one screen later. */
const assertDeviceNotInUse = (req, options) => {
  const error = inUseCheck(req, options);
  if (error) throw error;
};

module.exports = { SAME_ID_OTHER_IP_WINDOW_MS, deviceGate, deviceInUse, assertDeviceNotInUse, resetDeviceGate, normalizeIp };
