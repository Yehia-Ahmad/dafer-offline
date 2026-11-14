// Stage 24: the client limit. maxClients = how many client PCs may be paired to this main at once (0 = main PC only).
// A client PC pairs the first time it signs in or registers (deviceContext) and keeps its slot until the owner unpairs it. An unpaired PC is
// REVOKED: it cannot pair itself again; the owner re-allows it. The main PC is the one talking over loopback (middlewares/deviceGate.js); an
// instance id never makes a request "the main PC". The device header is not an authentication factor: this limits how many PCs the shop can
// use with one license, it does not identify a person.
const Device = require("../models/device.model");
const license = require("./index");

const limitError = (maxClients) => {
  const error = new Error("وصلت لأقصى عدد أجهزة فرعية في الترخيص — اطلب من المالك يشيل جهاز");
  error.statusCode = 403;
  error.responseData = { code: "CLIENT_LIMIT", maxClients, messageEn: "This license's limit of client PCs is reached. Ask the owner to remove one." };
  return error;
};

const revokedError = () => {
  const error = new Error("المالك فصل الجهاز ده. اطلب من المالك يسمح له تاني من شاشة الترخيص.");
  error.statusCode = 403;
  error.responseData = { code: "CLIENT_REVOKED", messageEn: "The owner removed this PC. Ask the owner to allow it again in the license card." };
  return error;
};

// One pairing at a time inside this backend, so two new PCs cannot both take the last slot.
let queue = Promise.resolve();
const serialize = (task) => {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
};

/**
 * Makes sure a client PC holds a slot. Returns { paired:true } for a PC that already has one or was just paired,
 * and throws CLIENT_LIMIT when it is new/unpaired and every slot is taken.
 */
const ensurePaired = (deviceId, set) => serialize(async () => {
  const existing = await Device.findOne({ deviceId }).select("paired revoked").lean();
  if (existing && existing.revoked) throw revokedError();
  if (existing && existing.paired) {
    await Device.updateOne({ deviceId }, { $set: set });
    return { paired: true, fresh: false };
  }
  const payload = license.payload();
  const maxClients = payload ? payload.maxClients : 0;
  const used = await Device.countDocuments({ role: "client", paired: true });
  if (used >= maxClients) throw limitError(maxClients);
  await Device.updateOne({ deviceId }, { $set: { ...set, paired: true, pairedAt: new Date() } }, { upsert: true });
  return { paired: true, fresh: true };
});

/**
 * Login on a client PC: the PC pairs here (or must already hold a slot). Refused with 403 CLIENT_LIMIT when every slot is taken and
 * 403 CLIENT_REVOKED when the owner removed it. The main PC is the one over loopback and needs no slot; any other request must carry a
 * device id (deviceGate answers 400 DEVICE_ID_REQUIRED before it gets here).
 */
const requireClientSlotAtLogin = async (req) => {
  const { validDeviceId, decodeName } = require("../middlewares/device.middleware");
  const { isLoopback } = require("../auth/middleware");
  if (isLoopback(req)) return;
  const deviceId = validDeviceId(req.get("x-nota-device-id"));
  if (!deviceId) {
    const error = new Error("الجهاز ده لازم يبعت رقم جهازه.");
    error.statusCode = 400;
    error.responseData = { code: "DEVICE_ID_REQUIRED", messageEn: "This PC must send its device id." };
    throw error;
  }
  const set = { lastSeenAt: new Date(), role: "client" };
  const name = decodeName(req.get("x-nota-device-name"));
  if (name) set.name = name;
  await ensurePaired(deviceId, set);
};

/** The owner's view: limit, slots used and the paired client PCs. */
const clientSlots = async (maxClients) => {
  const clients = await Device.find({ role: "client", paired: true }).sort({ pairedAt: 1 }).select("deviceId name lastSeenAt pairedAt").lean();
  const revoked = await Device.find({ role: "client", revoked: true }).sort({ revokedAt: 1 }).select("deviceId name revokedAt").lean();
  return {
    revoked: revoked.map((c) => ({ deviceId: c.deviceId, name: c.name || "", revokedAt: c.revokedAt || null })),
    clientsUsed: clients.length,
    clients: clients.map((c) => ({ deviceId: c.deviceId, name: c.name || "", lastSeenAt: c.lastSeenAt, pairedAt: c.pairedAt || null })),
    maxClients,
  };
};

/** Frees the slot of one client PC and REVOKES it: it cannot pair itself again until the owner allows it. False = nothing to unpair. */
const unpair = async (deviceId) => {
  const result = await Device.updateOne({ deviceId, role: "client", paired: true }, { $set: { paired: false, revoked: true, revokedAt: new Date() }, $unset: { pairedAt: 1 } });
  return result.modifiedCount > 0;
};

/** The owner lets a revoked PC pair again (it still needs a free slot, and pairs itself when it next signs in). False = it was not revoked. */
const allow = async (deviceId) => {
  const result = await Device.updateOne({ deviceId, role: "client", revoked: true }, { $set: { revoked: false }, $unset: { revokedAt: 1 } });
  return result.modifiedCount > 0;
};

module.exports = { requireClientSlotAtLogin, ensurePaired, clientSlots, unpair, allow, limitError, revokedError };
