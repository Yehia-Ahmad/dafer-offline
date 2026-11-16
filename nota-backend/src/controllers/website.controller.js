// Online Stage 3: the admin side of the customer website (website.manage on every route): website settings, delivery
// zones, and the website fields of a product / category (so website staff need not hold products.manage).
const mongoose = require("mongoose");
const WebsiteSettings = require("../models/websiteSettings.model");
const DeliveryZone = require("../models/deliveryZone.model");
const WebOrder = require("../models/webOrder.model");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const CashBox = require("../models/cashBox.model");
const asyncHandler = require("../utils/asyncHandler");
const isBase64Image = require("../utils/isBase64Image");
const { httpError } = require("../auth/middleware");
const { normalizeStorePhone } = require("../utils/storePhone");

const { MAX_BANNERS, MAX_FEATURED, HIGHLIGHT_ICONS, BRAND_COLORS } = WebsiteSettings;
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
  // Online Stage 5A (the documented defaults: delivery on, pickup off, cash on delivery on, stock rules, "marked" mode)
  fulfillment: { delivery: true, pickup: false },
  payments: { cod: { enabled: true }, instapay: { enabled: false, address: "", boxId: null }, vodafoneCash: { enabled: false, number: "", boxId: null } },
  stock: { showOutOfStock: true, showRemaining: { enabled: true, threshold: 5 } },
  productVisibility: "marked", brandColor: null, websiteLogo: null, announcement: { enabled: false, text: "" },
  seoDescription: "", openingHours: "", sameDayCutoff: "", highlights: [], whatsappConfirmTemplate: "",
});

const getSettings = asyncHandler(async (_req, res) => {
  const settings = await WebsiteSettings.findOne({ key: SETTINGS_KEY }).lean();
  if (!settings) return res.json({ ...EMPTY_SETTINGS, banners: [], featuredCategoryIds: [] });
  const merged = { ...EMPTY_SETTINGS, ...settings, banners: settings.banners || [] };
  // The nested groups keep the default of every key the saved document does not have.
  merged.fulfillment = { ...EMPTY_SETTINGS.fulfillment, ...(settings.fulfillment || {}) };
  merged.payments = {
    cod: { ...EMPTY_SETTINGS.payments.cod, ...((settings.payments && settings.payments.cod) || {}) },
    instapay: { ...EMPTY_SETTINGS.payments.instapay, ...((settings.payments && settings.payments.instapay) || {}) },
    vodafoneCash: { ...EMPTY_SETTINGS.payments.vodafoneCash, ...((settings.payments && settings.payments.vodafoneCash) || {}) },
  };
  merged.stock = {
    showOutOfStock: settings.stock && settings.stock.showOutOfStock !== undefined ? settings.stock.showOutOfStock : true,
    showRemaining: { ...EMPTY_SETTINGS.stock.showRemaining, ...((settings.stock && settings.stock.showRemaining) || {}) },
  };
  merged.announcement = { ...EMPTY_SETTINGS.announcement, ...(settings.announcement || {}) };
  merged.highlights = settings.highlights || [];
  res.json(merged);
});

const TEXT_FIELDS = { closedMessage: 500, title: 150, about: 5000, orderNote: 1000, returnsPolicy: 5000, terms: 10000, seoDescription: 300, openingHours: 500, whatsappConfirmTemplate: 1000 };
const TEXT_LABELS = { closedMessage: "رسالة الإغلاق", title: "العنوان", about: "نص عن المتجر", orderNote: "ملاحظة الطلب", returnsPolicy: "سياسة الإرجاع", terms: "الشروط", seoDescription: "وصف الموقع لمحركات البحث", openingHours: "مواعيد العمل", whatsappConfirmTemplate: "رسالة تأكيد واتساب" };

const readObject = (value, field) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("INVALID_VALUE", `قيمة ${field} غير صالحة`);
  return value;
};

/** A wallet / bank box that can take the money of a transfer method: it must exist, be active, and be of type wallet or bank. */
const readWalletBox = async (value, field) => {
  if (!isId(value)) throw bad("INVALID_BOX", `اختار خزنة ${field}`);
  const box = await CashBox.findById(value).select("type isActive").lean();
  if (!box || !box.isActive || !["wallet", "bank"].includes(box.type)) throw bad("INVALID_BOX", `خزنة ${field} لازم تكون محفظة أو بنك شغّال`);
  return box._id;
};

/** Merges the posted `fulfillment` / `payments` / `stock` / `announcement` / `highlights` / look fields into the settings document. */
const applyStage5aSettings = async (settings, body) => {
  if (body.fulfillment !== undefined) {
    const input = readObject(body.fulfillment, "طريقة الاستلام");
    const current = settings.fulfillment || {};
    const next = {
      delivery: input.delivery !== undefined ? readBool(input.delivery, "التوصيل") : current.delivery !== false,
      pickup: input.pickup !== undefined ? readBool(input.pickup, "الاستلام من المحل") : current.pickup === true,
    };
    settings.set("fulfillment", next);
  }
  if (body.payments !== undefined) {
    const input = readObject(body.payments, "طرق الدفع");
    const current = settings.payments || {};
    if (input.cod !== undefined) settings.set("payments.cod", { enabled: readBool(readObject(input.cod, "الدفع عند الاستلام").enabled, "الدفع عند الاستلام") });
    if (input.instapay !== undefined) {
      const row = readObject(input.instapay, "إنستا باي");
      const old = current.instapay || {};
      const next = { enabled: row.enabled !== undefined ? readBool(row.enabled, "إنستا باي") : old.enabled === true, address: old.address, boxId: old.boxId };
      if (row.address !== undefined) {
        next.address = isBlank(row.address) ? undefined : readText(row.address, 100, "عنوان إنستا باي");
        if (next.address && /\s/.test(next.address)) throw bad("INVALID_IPA", "عنوان إنستا باي لازم يكون من غير مسافات");
      }
      if (row.boxId !== undefined) next.boxId = isBlank(row.boxId) ? undefined : await readWalletBox(row.boxId, "إنستا باي");
      if (next.enabled && !next.address) throw bad("INVALID_IPA", "عنوان إنستا باي مطلوب");
      if (next.enabled && !next.boxId) throw bad("INVALID_BOX", "اختار خزنة إنستا باي");
      if (next.enabled && !(await readWalletBox(String(next.boxId), "إنستا باي"))) throw bad("INVALID_BOX", "خزنة إنستا باي غير صالحة");
      settings.set("payments.instapay", next);
    }
    if (input.vodafoneCash !== undefined) {
      const row = readObject(input.vodafoneCash, "فودافون كاش");
      const old = current.vodafoneCash || {};
      const next = { enabled: row.enabled !== undefined ? readBool(row.enabled, "فودافون كاش") : old.enabled === true, number: old.number, boxId: old.boxId };
      if (row.number !== undefined) {
        if (isBlank(row.number)) next.number = undefined;
        else { next.number = normalizeStorePhone(readText(row.number, 30, "رقم فودافون كاش")); if (!next.number) throw bad("INVALID_NUMBER", "رقم فودافون كاش غير صالح"); }
      }
      if (row.boxId !== undefined) next.boxId = isBlank(row.boxId) ? undefined : await readWalletBox(row.boxId, "فودافون كاش");
      if (next.enabled && !next.number) throw bad("INVALID_NUMBER", "رقم فودافون كاش مطلوب");
      if (next.enabled && !next.boxId) throw bad("INVALID_BOX", "اختار خزنة فودافون كاش");
      if (next.enabled && !(await readWalletBox(String(next.boxId), "فودافون كاش"))) throw bad("INVALID_BOX", "خزنة فودافون كاش غير صالحة");
      settings.set("payments.vodafoneCash", next);
    }
  }
  const delivery = !(settings.fulfillment && settings.fulfillment.delivery === false);
  const pickup = Boolean(settings.fulfillment && settings.fulfillment.pickup === true);
  if (!delivery && !pickup) throw bad("FULFILLMENT_REQUIRED", "لازم تفعّل التوصيل أو الاستلام من المحل");
  const pay = settings.payments || {};
  if ((pay.cod && pay.cod.enabled === false) && !(pay.instapay && pay.instapay.enabled) && !(pay.vodafoneCash && pay.vodafoneCash.enabled)) throw bad("PAYMENT_REQUIRED", "لازم تفعّل طريقة دفع واحدة على الأقل");

  if (body.stock !== undefined) {
    const input = readObject(body.stock, "المخزون");
    const current = settings.stock || {};
    if (input.showOutOfStock !== undefined) settings.set("stock.showOutOfStock", readBool(input.showOutOfStock, "عرض الأصناف الخالصة"));
    if (input.showRemaining !== undefined) {
      const row = readObject(input.showRemaining, "عرض الكمية المتبقية");
      const old = current.showRemaining || {};
      const threshold = row.threshold !== undefined ? row.threshold : old.threshold;
      if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > 1000)) throw bad("INVALID_VALUE", "حد الكمية المتبقية من 1 إلى 1000");
      settings.set("stock.showRemaining", { enabled: row.enabled !== undefined ? readBool(row.enabled, "عرض الكمية المتبقية") : old.enabled !== false, ...(threshold !== undefined ? { threshold } : {}) });
    }
  }
  if (body.productVisibility !== undefined) {
    if (body.productVisibility !== "marked" && body.productVisibility !== "all") throw bad("INVALID_VALUE", "وضع ظهور المنتجات غير صالح");
    settings.productVisibility = body.productVisibility;
  }
  if (body.brandColor !== undefined) {
    if (isBlank(body.brandColor)) settings.brandColor = undefined;
    else {
      const color = readText(body.brandColor, 20, "لون الموقع").toUpperCase();
      if (!BRAND_COLORS.includes(color)) throw bad("INVALID_COLOR", "لون الموقع لازم يكون من الألوان الجاهزة");
      settings.brandColor = color;
    }
  }
  if (body.websiteLogo !== undefined) {
    if (isBlank(body.websiteLogo)) settings.websiteLogo = undefined;
    else if (typeof body.websiteLogo === "string" && isBase64Image(body.websiteLogo)) settings.websiteLogo = body.websiteLogo;
    else throw bad("INVALID_LOGO", "شعار الموقع لازم يكون صورة صالحة");
  }
  if (body.announcement !== undefined) {
    const input = readObject(body.announcement, "الإعلان");
    const old = settings.announcement || {};
    const text = input.text !== undefined ? readText(input.text ?? "", 160, "نص الإعلان") : old.text || "";
    const enabled = input.enabled !== undefined ? readBool(input.enabled, "الإعلان") : old.enabled === true;
    if (enabled && !text) throw bad("INVALID_VALUE", "اكتب نص الإعلان");
    settings.set("announcement", { enabled, text });
  }
  if (body.sameDayCutoff !== undefined) {
    if (isBlank(body.sameDayCutoff)) settings.sameDayCutoff = undefined;
    else {
      const cutoff = readText(body.sameDayCutoff, 5, "موعد التوصيل في نفس اليوم");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) throw bad("INVALID_VALUE", "الموعد لازم يكون بصيغة HH:mm");
      settings.sameDayCutoff = cutoff;
    }
  }
  if (body.highlights !== undefined) {
    if (!Array.isArray(body.highlights) || body.highlights.length > 3) throw bad("INVALID_VALUE", "الحد الأقصى 3 مميزات");
    settings.highlights = body.highlights.map((row) => {
      const item = readObject(row, "ميزة");
      if (!HIGHLIGHT_ICONS.includes(item.icon)) throw bad("INVALID_VALUE", "أيقونة غير معروفة");
      const title = readText(item.title ?? "", 60, "عنوان الميزة");
      if (!title) throw bad("INVALID_VALUE", "عنوان الميزة مطلوب");
      return { icon: item.icon, title, text: readText(item.text ?? "", 160, "نص الميزة") };
    });
  }
};

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
  await applyStage5aSettings(settings, body);
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
  res.json({ id: String(product._id), website: productWebsiteView(product) });
});

// Online Stage 5A: "show" | "hide" | null (unset). null removes the choice, so the website's mode decides.
const readVisibility = (value) => {
  if (value === null) return null;
  if (value === "show" || value === "hide") return value;
  throw bad("INVALID_VALUE", "قيمة الظهور على الموقع غير صالحة");
};
const rejectLegacyVisible = (body) => {
  if (body.visible !== undefined) throw bad("INVALID_VALUE", "الحقل visible اتشال. استخدم visibility (show / hide)");
};
const productWebsiteView = (product) => ({ visibility: (product.website && product.website.visibility) || null, description: (product.website && product.website.description) || "", images: (product.website && product.website.images) || [] });

const updateProductWebsite = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!isId(req.params.id)) throw httpError(404, "NOT_FOUND", "المنتج غير موجود");
  rejectLegacyVisible(body);
  const $set = {};
  const $unset = {};
  if (body.visibility !== undefined) {
    const visibility = readVisibility(body.visibility);
    if (visibility === null) $unset["website.visibility"] = ""; else $set["website.visibility"] = visibility;
  }
  if (body.description !== undefined) $set["website.description"] = readText(body.description ?? "", 2000, "وصف الموقع");
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > 4 || !body.images.every((image) => typeof image === "string" && isBase64Image(image))) {
      throw bad("INVALID_IMAGES", "حتى 4 صور base64 صالحة");
    }
    $set["website.images"] = body.images;
  }
  if (!Object.keys($set).length && !Object.keys($unset).length) throw bad("NOTHING_TO_UPDATE", "مفيش تعديل");
  const update = { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) };
  const product = await Product.findOneAndUpdate({ _id: req.params.id }, update, { new: true, runValidators: true }).select("website").lean();
  if (!product) throw httpError(404, "NOT_FOUND", "المنتج غير موجود");
  res.json({ id: String(product._id), website: productWebsiteView(product) });
});

const updateCategoryWebsite = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!isId(req.params.id)) throw httpError(404, "NOT_FOUND", "الفئة غير موجودة");
  rejectLegacyVisible(body);
  const $set = {};
  const $unset = {};
  if (body.visibility !== undefined) {
    const visibility = readVisibility(body.visibility);
    if (visibility === null) $unset["website.visibility"] = ""; else $set["website.visibility"] = visibility;
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isFinite(Number(body.sortOrder)) || body.sortOrder === "" || body.sortOrder === null) throw bad("INVALID_VALUE", "ترتيب غير صالح");
    $set["website.sortOrder"] = Number(body.sortOrder);
  }
  if (!Object.keys($set).length && !Object.keys($unset).length) throw bad("NOTHING_TO_UPDATE", "مفيش تعديل");
  const update = { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) };
  const category = await Category.findOneAndUpdate({ _id: req.params.id }, update, { new: true, runValidators: true }).select("website").lean();
  if (!category) throw httpError(404, "NOT_FOUND", "الفئة غير موجودة");
  res.json({ id: String(category._id), website: { visibility: (category.website && category.website.visibility) || null, sortOrder: (category.website && category.website.sortOrder) || 0 } });
});

module.exports = {
  createZone, deleteZone, getProductWebsite, getSettings, listZones, updateCategoryWebsite, updateProductWebsite, updateSettings, updateZone,
};
