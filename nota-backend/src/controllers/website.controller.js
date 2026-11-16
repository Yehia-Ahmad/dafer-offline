// Online Stage 3: the admin side of the customer website (website.manage on every route): website settings, delivery
// zones, and the website fields of a product / category (so website staff need not hold products.manage).
const mongoose = require("mongoose");
const WebsiteSettings = require("../models/websiteSettings.model");
const DeliveryZone = require("../models/deliveryZone.model");
const WebOrder = require("../models/webOrder.model");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const asyncHandler = require("../utils/asyncHandler");
const isBase64Image = require("../utils/isBase64Image");
const { httpError } = require("../auth/middleware");
const { normalizeStorePhone } = require("../utils/storePhone");

const { MAX_BANNERS, MAX_FEATURED } = WebsiteSettings;
const bad = (code, message) => httpError(400, code, message);
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && !value.trim());
const isId = (value) => typeof value === "string" && mongoose.Types.ObjectId.isValid(value);
const round2 = (value) => Number(Number(value).toFixed(2));

const readBool = (value, field) => {
  if (typeof value !== "boolean") throw bad("INVALID_VALUE", `قيمة ${field} غير صالحة`);
  return value;
};
const readText = (value, max, field) => {
  if (typeof value !== "string") throw bad("INVALID_VALUE", `قيمة ${field} غير صالحة`);
  const text = value.trim();
  if (text.length > max) throw bad("INVALID_VALUE", `${field} طويل (حتى ${max} حرف)`);
  return text;
};
const readMoney = (value, field) => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1e9) throw bad("INVALID_AMOUNT", `${field} لازم يكون رقم صفر أو أكبر`);
  return round2(number);
};
const readUrl = (value, field) => {
  const text = readText(value, 300, field);
  let url;
  try { url = new URL(text); } catch { throw bad("INVALID_URL", `رابط ${field} غير صالح`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("INVALID_URL", `رابط ${field} غير صالح`);
  return text;
};
// WhatsApp: an Egyptian mobile number, an international number (8-15 digits), or a wa.me link.
const readWhatsapp = (value) => {
  const text = readText(value, 100, "واتساب");
  if (/^https?:\/\//i.test(text)) {
    const url = readUrl(text, "واتساب");
    if (!/^https?:\/\/(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\//i.test(url)) throw bad("INVALID_URL", "رابط واتساب غير صالح");
    return url;
  }
  const phone = normalizeStorePhone(text);
  if (phone) return phone;
  const digits = text.replace(/[\s\-()]/g, "");
  if (/^\+?\d{8,15}$/.test(digits)) return digits;
  throw bad("INVALID_WHATSAPP", "رقم واتساب غير صالح");
};

const SETTINGS_KEY = "default";
const EMPTY_SETTINGS = Object.freeze({
  enabled: false, orderingEnabled: true, closedMessage: "", title: "", about: "", banners: [], featuredCategoryIds: [],
  whatsapp: "", facebook: "", instagram: "", tiktok: "", minOrderAmount: null, freeDeliveryFrom: null, orderNote: "", returnsPolicy: "", terms: "",
});

const getSettings = asyncHandler(async (_req, res) => {
  const settings = await WebsiteSettings.findOne({ key: SETTINGS_KEY }).lean();
  res.json(settings ? { ...EMPTY_SETTINGS, ...settings, banners: settings.banners || [] } : { ...EMPTY_SETTINGS, banners: [], featuredCategoryIds: [] });
});

const TEXT_FIELDS = { closedMessage: 500, title: 150, about: 5000, orderNote: 1000, returnsPolicy: 5000, terms: 10000 };
const TEXT_LABELS = { closedMessage: "رسالة الإغلاق", title: "العنوان", about: "نص عن المتجر", orderNote: "ملاحظة الطلب", returnsPolicy: "سياسة الإرجاع", terms: "الشروط" };

const readBanners = async (value, existing) => {
  if (!Array.isArray(value) || value.length > MAX_BANNERS) throw bad("INVALID_BANNERS", `الحد الأقصى ${MAX_BANNERS} بانرات`);
  const old = new Map((existing || []).map((banner) => [String(banner._id), banner]));
  const out = [];
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== "object") throw bad("INVALID_BANNERS", "بانر غير صالح");
    const previous = isId(row.id) ? old.get(row.id) : null;
    const image = typeof row.image === "string" && row.image ? row.image : previous && previous.image;
    if (!image || !isBase64Image(image)) throw bad("INVALID_BANNERS", "صورة البانر مطلوبة");
    const linkType = row.linkType === "category" || row.linkType === "product" ? row.linkType : "none";
    let linkId;
    if (linkType !== "none") {
      if (!isId(row.linkId)) throw bad("INVALID_BANNERS", "رابط البانر غير صالح");
      const exists = linkType === "category" ? await Category.exists({ _id: row.linkId }) : await Product.exists({ _id: row.linkId });
      if (!exists) throw bad("INVALID_BANNERS", "رابط البانر غير موجود");
      linkId = row.linkId;
    }
    const banner = { image, linkType, ...(linkId ? { linkId } : {}), sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : index };
    if (previous) banner._id = previous._id;
    out.push(banner);
  }
  return out;
};

const updateSettings = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const settings = (await WebsiteSettings.findOne({ key: SETTINGS_KEY })) || new WebsiteSettings({ key: SETTINGS_KEY });

  if (body.enabled !== undefined) settings.enabled = readBool(body.enabled, "حالة الموقع");
  if (body.orderingEnabled !== undefined) settings.orderingEnabled = readBool(body.orderingEnabled, "استقبال الطلبات");
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (body[field] === undefined) continue;
    settings[field] = isBlank(body[field]) ? undefined : readText(body[field], max, TEXT_LABELS[field]);
  }
  if (body.whatsapp !== undefined) settings.whatsapp = isBlank(body.whatsapp) ? undefined : readWhatsapp(body.whatsapp);
  for (const [field, label] of [["facebook", "فيسبوك"], ["instagram", "إنستجرام"], ["tiktok", "تيك توك"]]) {
    if (body[field] !== undefined) settings[field] = isBlank(body[field]) ? undefined : readUrl(body[field], label);
  }
  if (body.minOrderAmount !== undefined) settings.minOrderAmount = isBlank(body.minOrderAmount) ? undefined : readMoney(body.minOrderAmount, "الحد الأدنى للطلب");
  if (body.freeDeliveryFrom !== undefined) settings.freeDeliveryFrom = isBlank(body.freeDeliveryFrom) ? undefined : readMoney(body.freeDeliveryFrom, "التوصيل المجاني من");
  if (body.banners !== undefined) settings.banners = await readBanners(body.banners, settings.banners);
  if (body.featuredCategoryIds !== undefined) {
    const ids = body.featuredCategoryIds;
    if (!Array.isArray(ids) || ids.length > MAX_FEATURED || !ids.every(isId) || new Set(ids).size !== ids.length) throw bad("INVALID_FEATURED", `الحد الأقصى ${MAX_FEATURED} فئات مميزة`);
    if ((await Category.countDocuments({ _id: { $in: ids } })) !== ids.length) throw bad("INVALID_FEATURED", "فئة غير موجودة");
    settings.featuredCategoryIds = ids;
  }
  await settings.save();
  res.json(settings.toObject());
});

// ---- delivery zones ------------------------------------------------------------------------------------------------

const readZone = (body, { partial }) => {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = readText(input.name ?? "", 120, "اسم المنطقة");
    if (!out.name) throw bad("INVALID_NAME", "اسم المنطقة مطلوب");
  }
  if (!partial || input.fee !== undefined) {
    if (isBlank(input.fee)) throw bad("INVALID_AMOUNT", "رسوم التوصيل مطلوبة");
    out.fee = readMoney(input.fee, "رسوم التوصيل");
  }
  if (input.estimatedTime !== undefined) out.estimatedTime = readText(input.estimatedTime ?? "", 120, "وقت التوصيل");
  if (input.isActive !== undefined) out.isActive = readBool(input.isActive, "حالة المنطقة");
  if (input.sortOrder !== undefined) {
    if (!Number.isFinite(Number(input.sortOrder))) throw bad("INVALID_VALUE", "ترتيب غير صالح");
    out.sortOrder = Number(input.sortOrder);
  }
  return out;
};

const zoneJson = (zone, used) => ({
  id: String(zone._id), name: zone.name, fee: zone.fee, estimatedTime: zone.estimatedTime || "", isActive: zone.isActive, sortOrder: zone.sortOrder || 0, ...(used !== undefined ? { used } : {}),
});

const listZones = asyncHandler(async (_req, res) => {
  const zones = await DeliveryZone.find().sort({ sortOrder: 1, name: 1 }).lean();
  const usedRows = await WebOrder.aggregate([{ $group: { _id: "$zone.id" } }]);
  const used = new Set(usedRows.map((row) => String(row._id)));
  res.json({ data: zones.map((zone) => zoneJson(zone, used.has(String(zone._id)))) });
});

const createZone = asyncHandler(async (req, res) => {
  const zone = await DeliveryZone.create(readZone(req.body, { partial: false }));
  res.status(201).json(zoneJson(zone.toObject(), false));
});

const findZone = async (id) => {
  const zone = isId(id) ? await DeliveryZone.findById(id) : null;
  if (!zone) throw httpError(404, "NOT_FOUND", "المنطقة غير موجودة");
  return zone;
};

const updateZone = asyncHandler(async (req, res) => {
  const zone = await findZone(req.params.id);
  zone.set(readZone(req.body, { partial: true }));
  await zone.save();
  res.json(zoneJson(zone.toObject(), Boolean(await WebOrder.exists({ "zone.id": zone._id }))));
});

const deleteZone = asyncHandler(async (req, res) => {
  const zone = await findZone(req.params.id);
  if (await WebOrder.exists({ "zone.id": zone._id })) throw httpError(409, "ZONE_IN_USE", "المنطقة مستخدمة في طلبات. تقدر توقفها بس");
  await zone.deleteOne();
  res.status(204).end();
});

// ---- website fields of a product / category -------------------------------------------------------------------------

// The one staff endpoint that returns a product's website images (the product form's website section reads it).
const getProductWebsite = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw httpError(404, "NOT_FOUND", "المنتج غير موجود");
  const product = await Product.findById(req.params.id).select("website").lean();
  if (!product) throw httpError(404, "NOT_FOUND", "المنتج غير موجود");
  res.json({ id: String(product._id), website: { visible: Boolean(product.website && product.website.visible), description: (product.website && product.website.description) || "", images: (product.website && product.website.images) || [] } });
});

const updateProductWebsite = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!isId(req.params.id)) throw httpError(404, "NOT_FOUND", "المنتج غير موجود");
  const $set = {};
  if (body.visible !== undefined) $set["website.visible"] = readBool(body.visible, "الظهور على الموقع");
  if (body.description !== undefined) $set["website.description"] = readText(body.description ?? "", 2000, "وصف الموقع");
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > 4 || !body.images.every((image) => typeof image === "string" && isBase64Image(image))) {
      throw bad("INVALID_IMAGES", "حتى 4 صور base64 صالحة");
    }
    $set["website.images"] = body.images;
  }
  if (!Object.keys($set).length) throw bad("NOTHING_TO_UPDATE", "مفيش تعديل");
  const product = await Product.findOneAndUpdate({ _id: req.params.id }, { $set }, { new: true, runValidators: true }).select("website").lean();
  if (!product) throw httpError(404, "NOT_FOUND", "المنتج غير موجود");
  res.json({ id: String(product._id), website: { visible: Boolean(product.website && product.website.visible), description: (product.website && product.website.description) || "", images: (product.website && product.website.images) || [] } });
});

const updateCategoryWebsite = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!isId(req.params.id)) throw httpError(404, "NOT_FOUND", "الفئة غير موجودة");
  const $set = {};
  if (body.visible !== undefined) $set["website.visible"] = readBool(body.visible, "الظهور على الموقع");
  if (body.sortOrder !== undefined) {
    if (!Number.isFinite(Number(body.sortOrder)) || body.sortOrder === "" || body.sortOrder === null) throw bad("INVALID_VALUE", "ترتيب غير صالح");
    $set["website.sortOrder"] = Number(body.sortOrder);
  }
  if (!Object.keys($set).length) throw bad("NOTHING_TO_UPDATE", "مفيش تعديل");
  const category = await Category.findOneAndUpdate({ _id: req.params.id }, { $set }, { new: true, runValidators: true }).select("website").lean();
  if (!category) throw httpError(404, "NOT_FOUND", "الفئة غير موجودة");
  res.json({ id: String(category._id), website: { visible: Boolean(category.website && category.website.visible), sortOrder: (category.website && category.website.sortOrder) || 0 } });
});

module.exports = {
  createZone, deleteZone, getProductWebsite, getSettings, listZones, updateCategoryWebsite, updateProductWebsite, updateSettings, updateZone,
};
