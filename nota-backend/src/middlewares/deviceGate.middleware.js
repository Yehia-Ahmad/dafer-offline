// Stage 24: who a request comes from, for the client limit. Mounted on /api right after the license lock and BEFORE any route
// (login included).
//
//   * The main PC is the one that talks over loopback (127.0.0.1 / ::1), and only that. A device id, including the main PC's own
//     instance id (anyone with the LAN key can read it from /api/lan/info), never makes a LAN request "the main PC".
//   * Every other request must carry a valid X-Nota-Device-Id, else 400 DEVICE_ID_REQUIRED: a client PC cannot dodge being counted by
//     leaving the header out. Exception: /api/lan/* (the discovery probe a client makes before it has an identity).
//   * One device id seen from a different IP address within the last 2 minutes is refused for the new address (403 DEVICE_IN_USE): a paired
//     id copied to another PC does not work while the first PC is using it.
//
// Honest limit: the id is still just a header. Copy it to a second PC while the first one is OFF (or after 2 minutes of silence) and that PC
// takes over the same slot. This stops casual sharing; it is not a hard lock (docs/OFFLINE_PLAN.md).
const { isLoopback } = require("../auth/middleware");
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

const deviceGate = ({ now = Date.now, windowMs = SAME_ID_OTHER_IP_WINDOW_MS } = {}) => (req, _res, next) => {
  if (req.method === "OPTIONS" || isLoopback(req) || isDiscoveryPath(req.path)) return next();
  const deviceId = validDeviceId(req.get("x-nota-device-id"));
  if (!deviceId) {
    return next(httpError(400, "DEVICE_ID_REQUIRED",
      "الجهاز ده لازم يبعت رقم جهازه. حدّث البرنامج على الجهاز الفرعي.",
      "This PC must send its device id. Update the app on the client PC."));
  }
  const ip = normalizeIp(req.ip);
  const at = now();
  const seen = lastSeen.get(deviceId);
  if (seen && seen.ip !== ip && at - seen.at < windowMs) {
    return next(httpError(403, "DEVICE_IN_USE",
      "رقم الجهاز ده بيستخدمه جهاز تاني دلوقتي. كل جهاز لازم يكون له رقمه الخاص.",
      "This device id is being used by another PC right now. Each PC needs its own id."));
  }
  lastSeen.delete(deviceId);
  lastSeen.set(deviceId, { ip, at });
  while (lastSeen.size > MAX_REMEMBERED) lastSeen.delete(lastSeen.keys().next().value);
  return next();
};

module.exports = { SAME_ID_OTHER_IP_WINDOW_MS, deviceGate, resetDeviceGate, normalizeIp };
