// Stage 24: what activation does to the database. Never deletes or changes business data.
const Meta = require("../models/meta.model");
const ShopProfile = require("../models/shopProfile.model");
const AuditLog = require("../models/auditLog.model");
const license = require("./index");

/** Keeps a copy of the license text in the database (client PCs read the info through the backend). */
const storeCopy = async (text) => {
  await Meta.updateOne({ _id: "license" }, { $set: { licenseText: text } }, { upsert: true });
};

/**
 * The license name wins. If the stored shop name differs, it is replaced and the old one goes to the audit log.
 * Creates the profile when none exists yet (first run), so login and prints show the licensed name straight away.
 */
const syncShopName = async (payload, user) => {
  const existing = await ShopProfile.findOne({ key: "default" }).lean();
  const $set = { name: payload.shopName };
  const $unset = {};
  if (payload.shopNameEn) $set.nameEn = payload.shopNameEn; else $unset.nameEn = 1;
  const update = Object.keys($unset).length ? { $set, $unset } : { $set };
  await ShopProfile.findOneAndUpdate({ key: "default" }, update, { upsert: true, setDefaultsOnInsert: true, runValidators: true });
  if (existing && existing.name && existing.name !== payload.shopName) {
    await AuditLog.create({
      at: new Date(), userId: user ? user._id : undefined, userName: user ? user.name : undefined,
      action: "shop.nameLocked", entity: "ShopProfile", entityId: "default",
      details: { oldName: existing.name, oldNameEn: existing.nameEn || undefined, newName: payload.shopName, licenseId: payload.licenseId },
    });
  }
};

/** Verifies, installs and applies the license. Returns { ok, code?, payload? }. */
const activate = async (text, user) => {
  const result = license.install(text);
  if (!result.ok) return result;
  await storeCopy(String(text).trim());
  await syncShopName(result.payload, user);
  return result;
};

/** Start-up: re-verify the file, then make sure the database copy and the shop name match it. */
const applyAtStart = async () => {
  const state = license.reload();
  if (!state.ok) return state;
  await storeCopy(state.text);
  await syncShopName(state.payload, null);
  return state;
};

module.exports = { activate, applyAtStart, storeCopy, syncShopName };
