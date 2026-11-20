// Online Stage 7A: the «التسويق» settings (pixels, consent, attribution window, "عرفتنا منين؟") and the catalog feed links.
// Own endpoint so marketing.manage (not website.manage) guards it.
const asyncHandler = require("../utils/asyncHandler");
const WebsiteSettings = require("../models/websiteSettings.model");
const { httpError } = require("../auth/middleware");
const { effectiveSettings } = require("../store/catalog");

const SETTINGS_KEY = "default";
const bad = (message) => httpError(400, "INVALID_VALUE", message);

const originOf = (req) => (process.env.NOTA_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

const viewOf = (settings, req) => {
  const rules = effectiveSettings(settings).marketing;
  const origin = originOf(req);
  return { ...rules, feeds: { meta: `${origin}/feeds/catalog.csv`, tiktok: `${origin}/feeds/tiktok.csv` } };
};

// GET /api/website/marketing-settings (marketing.view)
const get = asyncHandler(async (req, res) => {
  res.json(viewOf(await WebsiteSettings.findOne({ key: SETTINGS_KEY }).lean(), req));
});

// PUT /api/website/marketing-settings (marketing.manage): only the keys sent are changed.
const update = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const settings = (await WebsiteSettings.findOne({ key: SETTINGS_KEY })) || new WebsiteSettings({ key: SETTINGS_KEY });
  const marketing = settings.marketing || {};

  if (body.metaPixelId !== undefined) {
    const id = typeof body.metaPixelId === "string" ? body.metaPixelId.trim() : null;
    if (id === null || (id && !/^\d{15,16}$/.test(id))) throw bad("رقم بكسل ميتا لازم يكون 15 أو 16 رقم");
    marketing.metaPixelId = id || undefined;
  }
  if (body.tiktokPixelId !== undefined) {
    const id = typeof body.tiktokPixelId === "string" ? body.tiktokPixelId.trim() : null;
    if (id === null || (id && !/^[A-Za-z0-9]{8,32}$/.test(id))) throw bad("رقم بكسل تيك توك حروف إنجليزي وأرقام فقط");
    marketing.tiktokPixelId = id || undefined;
  }
  for (const [key, label] of [["requireConsent", "طلب موافقة الكوكيز"], ["askHeardFrom", "سؤال عرفتنا منين"]]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") throw bad(`قيمة ${label} غير صالحة`);
      marketing[key] = body[key];
    }
  }
  if (body.attributionDays !== undefined) {
    if (!Number.isInteger(body.attributionDays) || body.attributionDays < 1 || body.attributionDays > 90) throw bad("مدة الحساب من 1 إلى 90 يوم");
    marketing.attributionDays = body.attributionDays;
  }
  if (body.heardFromOptions !== undefined) {
    if (!Array.isArray(body.heardFromOptions) || body.heardFromOptions.length > 12) throw bad("الخيارات حتى 12 خيار");
    const options = [];
    for (const option of body.heardFromOptions) {
      if (typeof option !== "string") throw bad("الخيار لازم يكون نص");
      const text = option.trim();
      if (!text) continue;
      if (text.length > 40) throw bad("الخيار طويل (حتى 40 حرف)");
      if (!options.includes(text)) options.push(text);
    }
    marketing.heardFromOptions = options;
  }
  settings.marketing = marketing;
  settings.markModified("marketing");
  await settings.save();
  res.json(viewOf(settings.toObject(), req));
});

module.exports = { get, update };
