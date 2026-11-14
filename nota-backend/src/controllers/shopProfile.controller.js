const ShopProfile = require("../models/shopProfile.model");
const { AUTO_LOCK_MINUTES, DEFAULT_AUTO_LOCK_MINUTES } = ShopProfile;
const asyncHandler = require("../utils/asyncHandler");
const { readVatUpdate, DEFAULT_VAT } = require("../utils/vatSettings");
const { DEFAULT_CLOSING } = require("../accounting/closing");
const { getLockedThrough } = require("../accounting/period");

const license = require("../license");

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

// Stage 24: the shop name (and English name) come from the license. It wins over whatever is stored.
const withLicenseName = (response) => {
  const p = license.payload();
  if (!p) return response;
  const out = { ...response, name: p.shopName, nameLocked: true };
  if (p.shopNameEn) out.nameEn = p.shopNameEn; else delete out.nameEn;
  return out;
};

const toShopProfileResponse = (profile) => withLicenseName(
  // `vat` is only present once VAT settings were ever saved (absent = off, rate 14, prices include VAT).
  profile
    ? { ...EMPTY_PROFILE, ...profile, ...(profile.vat ? { vat: { ...DEFAULT_VAT, ...profile.vat } } : {}), ...(profile.closing ? { closing: { ...DEFAULT_CLOSING, ...profile.closing } } : {}) }
    : { ...EMPTY_PROFILE, phones: [] });

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
  // Stage 24: the name is the license's. A request that tries to change it is refused; one that repeats it (or leaves it out) is fine.
  const licensed = license.payload();
  if (licensed) {
    const sameName = body.name === undefined || String(body.name).trim() === licensed.shopName;
    const sameNameEn = body.nameEn === undefined || String(body.nameEn).trim() === (licensed.shopNameEn || "");
    if (!sameName || !sameNameEn) {
      const error = new Error("اسم المحل مرتبط بالترخيص ومينفعش يتغيّر");
      error.statusCode = 400; error.responseData = { code: "SHOP_NAME_LOCKED" };
      throw error;
    }
  }
  const $set = {
    name: licensed ? licensed.shopName : (body.name ?? ""),
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

  // Stage 22: additive, owner only. The fiscal year start cannot move once a period was closed (the periods would stop lining up).
  if (body.closing !== undefined) {
    if (req.authEnabled && req.user?.role !== "owner") {
      res.status(403);
      throw new Error("إعدادات إقفال الفترات للمالك فقط");
    }
    const input = body.closing;
    const existing = await ShopProfile.findOne({ key: SHOP_PROFILE_KEY }).select("closing").lean();
    const stored = { ...DEFAULT_CLOSING, ...(existing?.closing || {}) };
    if (!input || typeof input !== "object" || Array.isArray(input)) { res.status(400); throw new Error("إعدادات الإقفال غير صالحة"); }
    const frequency = input.frequency === undefined ? stored.frequency : input.frequency;
    const month = input.fiscalYearStartMonth === undefined ? stored.fiscalYearStartMonth : input.fiscalYearStartMonth;
    if (frequency !== "monthly" && frequency !== "yearly") { res.status(400); throw new Error("نوع الإقفال غير صالح"); }
    if (!Number.isInteger(month) || month < 1 || month > 12) { res.status(400); throw new Error("شهر بداية السنة المالية غير صالح"); }
    if (month !== stored.fiscalYearStartMonth && await getLockedThrough()) {
      const error = new Error("مينفعش تغيّر بداية السنة المالية بعد ما فترة اتقفلت");
      error.statusCode = 409; error.responseData = { code: "CLOSING_SETTINGS_LOCKED" };
      throw error;
    }
    $set["closing.frequency"] = frequency; $set["closing.fiscalYearStartMonth"] = month;
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
