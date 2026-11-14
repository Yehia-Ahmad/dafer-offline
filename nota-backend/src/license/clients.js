// Stage 24: the client limit. maxClients = how many client PCs may be paired to this main at once (0 = main PC only).
// A client PC pairs the first time it registers (deviceContext) and keeps its slot until the owner unpairs it.
// The main PC (its instance id) never needs a slot. The device header is not an authentication factor: this limits
// how many PCs the shop can use with one license, it does not identify a person.
const Device = require("../models/device.model");
const license = require("./index");

const limitError = (maxClients) => {
  const error = new Error("وصلت لأقصى عدد أجهزة فرعية في الترخيص — اطلب من المالك يشيل جهاز");
  error.statusCode = 403;
  error.responseData = { code: "CLIENT_LIMIT", maxClients, messageEn: "This license's limit of client PCs is reached. Ask the owner to remove one." };
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
  const existing = await Device.findOne({ deviceId }).select("paired").lean();
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
 * Login on a client PC: the PC pairs here (or must already hold a slot). Refused with 403 CLIENT_LIMIT when every slot is taken.
 * No valid device header, or the main PC itself: nothing to do (the header is not an authentication factor).
 */
const requireClientSlotAtLogin = async (req) => {
  const { validDeviceId, decodeName } = require("../middlewares/device.middleware");
  const deviceId = validDeviceId(req.get("x-nota-device-id"));
  if (!deviceId || deviceId === process.env.NOTA_INSTANCE_ID) return;
  const set = { lastSeenAt: new Date(), role: "client" };
  const name = decodeName(req.get("x-nota-device-name"));
  if (name) set.name = name;
  await ensurePaired(deviceId, set);
};

/** The owner's view: limit, slots used and the paired client PCs. */
const clientSlots = async (maxClients) => {
  const clients = await Device.find({ role: "client", paired: true }).sort({ pairedAt: 1 }).select("deviceId name lastSeenAt pairedAt").lean();
  return {
    clientsUsed: clients.length,
    clients: clients.map((c) => ({ deviceId: c.deviceId, name: c.name || "", lastSeenAt: c.lastSeenAt, pairedAt: c.pairedAt || null })),
    maxClients,
  };
};

/** Frees the slot of one client PC. Returns false when there was nothing to unpair. */
const unpair = async (deviceId) => {
  const result = await Device.updateOne({ deviceId, role: "client", paired: true }, { $set: { paired: false }, $unset: { pairedAt: 1 } });
  return result.modifiedCount > 0;
};

module.exports = { requireClientSlotAtLogin, ensurePaired, clientSlots, unpair, limitError };
