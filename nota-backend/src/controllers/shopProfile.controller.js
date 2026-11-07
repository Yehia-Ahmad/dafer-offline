const ShopProfile = require("../models/shopProfile.model");
const { AUTO_LOCK_MINUTES, DEFAULT_AUTO_LOCK_MINUTES } = ShopProfile;
const asyncHandler = require("../utils/asyncHandler");
const { readVatUpdate, DEFAULT_VAT } = require("../utils/vatSettings");

const SHOP_PROFILE_KEY = "default";

// What GET returns before anything is saved, and the base every response is merged onto.
const EMPTY_PROFILE = Object.freeze({
  name: "",
  address: "",
  phones: [],
  logo: null,
  taxNumber: "",
  commercialRegister: "",
  invoiceFooter: "",
  autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
});

const OPTIONAL_STRING_FIELDS = ["address", "logo", "taxNumber", "commercialRegister", "invoiceFooter"];

const toShopProfileResponse = (profile) =>
  // `vat` is only present once VAT settings were ever saved (absent = off, rate 14, prices include VAT).
  profile
    ? { ...EMPTY_PROFILE, ...profile, ...(profile.vat ? { vat: { ...DEFAULT_VAT, ...profile.vat } } : {}) }
    : { ...EMPTY_PROFILE, phones: [] };

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim());

const getShopProfile = asyncHandler(async (req, res) => {
  const profile = await ShopProfile.findOne({ key: SHOP_PROFILE_KEY }).lean();
  res.json(toShopProfileResponse(profile));
});

// PUT replaces the whole profile. Only the fields above are read from the body; a missing
// optional field is cleared. `name` is always set so the required validator runs on updates.
const updateShopProfile = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const $set = {
    name: body.name ?? "",
    phones: body.phones ?? [],
  };
  const $unset = {};

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (isBlank(body[field])) $unset[field] = 1;
    else $set[field] = body[field];
  }

  // Stage 15: additive. Not sent (an older screen) → the stored value is kept.
  if (body.autoLockMinutes !== undefined) {
    const minutes = Number(body.autoLockMinutes);
    if (body.autoLockMinutes === null || body.autoLockMinutes === "" || !AUTO_LOCK_MINUTES.includes(minutes)) {
      res.status(400);
      throw new Error("مدة القفل التلقائي غير صالحة");
    }
    $set.autoLockMinutes = minutes;
  }

  // Stage 21: additive. Only a request that carries `vat` reads the stored settings, so every other PUT is unchanged.
  if (body.vat !== undefined) {
    const existing = await ShopProfile.findOne({ key: SHOP_PROFILE_KEY }).lean();
    Object.assign($set, readVatUpdate(body.vat, existing?.vat, isBlank(body.taxNumber) ? "" : body.taxNumber));
  }

  const update = Object.keys($unset).length > 0 ? { $set, $unset } : { $set };
  const profile = await ShopProfile.findOneAndUpdate({ key: SHOP_PROFILE_KEY }, update, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
  }).lean();

  res.json(toShopProfileResponse(profile));
});

module.exports = {
  getShopProfile,
  updateShopProfile,
};
