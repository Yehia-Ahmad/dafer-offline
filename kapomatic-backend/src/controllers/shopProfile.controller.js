const ShopProfile = require("../models/shopProfile.model");
const asyncHandler = require("../utils/asyncHandler");

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
});

const OPTIONAL_STRING_FIELDS = ["address", "logo", "taxNumber", "commercialRegister", "invoiceFooter"];

const toShopProfileResponse = (profile) =>
  profile ? { ...EMPTY_PROFILE, ...profile } : { ...EMPTY_PROFILE, phones: [] };

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
