const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");

const MAX_BANNERS = 5;
const MAX_FEATURED = 8;
const MAX_BANNER_BYTES = 1024 * 1024;
const HIGHLIGHT_ICONS = ["delivery", "cash", "exchange", "shield", "clock", "star"];
// The design's six brand presets, in the design's order: أخضر نوتة, بني, رمادي غامق, أخضر زرعي, نبيتي, بنفسجي. The default is the first.
const BRAND_COLORS = ["#0E4D45", "#7C2D12", "#3F3F46", "#14532D", "#831843", "#4C1D95"];
const DEFAULT_BRAND_COLOR = BRAND_COLORS[0];

const decodedBytes = (value) => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  const index = trimmed.indexOf(";base64,");
  const part = (trimmed.startsWith("data:") && index !== -1 ? trimmed.slice(index + 8) : trimmed).replace(/\s+/g, "");
  const padding = part.endsWith("==") ? 2 : part.endsWith("=") ? 1 : 0;
  return Math.floor((part.length * 3) / 4) - padding;
};

const bannerSchema = new mongoose.Schema(
  {
    image: {
      type: String,
      required: [true, "صورة البانر مطلوبة"],
      trim: true,
      validate: [
        { validator: isBase64Image, message: "يجب أن تكون صورة البانر سلسلة base64 صالحة" },
        { validator: (value) => decodedBytes(value) <= MAX_BANNER_BYTES, message: "يجب ألا يزيد حجم صورة البانر عن 1 ميجابايت" },
      ],
    },
    linkType: { type: String, enum: { values: ["none", "category", "product"], message: "نوع رابط البانر غير صالح" }, default: "none" },
    linkId: { type: mongoose.Schema.Types.ObjectId },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: true }
);

// A single document (key "default"), like ShopProfile: everything the shop controls about its website.
const websiteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true, trim: true },
    enabled: { type: Boolean, default: false },
    orderingEnabled: { type: Boolean, default: true },
    closedMessage: { type: String, trim: true, maxlength: [500, "رسالة الإغلاق طويلة"] },
    title: { type: String, trim: true, maxlength: [150, "عنوان الموقع طويل"] },
    about: { type: String, trim: true, maxlength: [5000, "نص عن المتجر طويل"] },
    banners: {
      type: [bannerSchema],
      default: [],
      validate: { validator: (list) => !Array.isArray(list) || list.length <= MAX_BANNERS, message: `الحد الأقصى ${MAX_BANNERS} بانرات` },
    },
    featuredCategoryIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
      default: [],
      validate: { validator: (list) => !Array.isArray(list) || list.length <= MAX_FEATURED, message: `الحد الأقصى ${MAX_FEATURED} فئات مميزة` },
    },
    whatsapp: { type: String, trim: true, maxlength: 100 },
    facebook: { type: String, trim: true, maxlength: 300 },
    instagram: { type: String, trim: true, maxlength: 300 },
    tiktok: { type: String, trim: true, maxlength: 300 },
    minOrderAmount: { type: Number, min: [0, "الحد الأدنى للطلب لا يمكن أن يكون سالبًا"] },
    freeDeliveryFrom: { type: Number, min: [0, "حد التوصيل المجاني لا يمكن أن يكون سالبًا"] },
    orderNote: { type: String, trim: true, maxlength: 1000 },
    returnsPolicy: { type: String, trim: true, maxlength: 5000 },
    terms: { type: String, trim: true, maxlength: 10000 },

    // ---- Online Stage 5A. No schema defaults: a missing value means the documented default (see store/catalog.js `withDefaults`).
    // How the customer gets the order. At least one on (checked when saving).
    fulfillment: { delivery: { type: Boolean }, pickup: { type: Boolean } },
    // Payment methods. boxId = an active wallet/bank box (never leaves the server).
    payments: {
      cod: { enabled: { type: Boolean } },
      instapay: { enabled: { type: Boolean }, address: { type: String, trim: true, maxlength: 100 }, boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox" } },
      vodafoneCash: { enabled: { type: Boolean }, number: { type: String, trim: true, maxlength: 30 }, boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox" } },
    },
    // Stock display.
    stock: {
      showOutOfStock: { type: Boolean },
      showRemaining: { enabled: { type: Boolean }, threshold: { type: Number, min: 1, max: 1000 } },
    },
    // "marked": only products/categories marked "show". "all": everything except those marked "hide".
    productVisibility: { type: String, enum: ["marked", "all"] },
    // Look.
    brandColor: { type: String, trim: true, maxlength: 20 },
    websiteLogo: {
      type: String,
      trim: true,
      validate: [
        { validator: (value) => value === undefined || value === null || value === "" || isBase64Image(value), message: "يجب أن يكون شعار الموقع سلسلة base64 صالحة" },
        { validator: (value) => decodedBytes(value) <= MAX_BANNER_BYTES, message: "يجب ألا يزيد حجم شعار الموقع عن 1 ميجابايت" },
      ],
    },
    announcement: { enabled: { type: Boolean }, text: { type: String, trim: true, maxlength: 160 } },
    // General.
    seoDescription: { type: String, trim: true, maxlength: 300 },
    openingHours: { type: String, trim: true, maxlength: 500 },
    // Delivery: information only ("HH:mm").
    sameDayCutoff: { type: String, trim: true, maxlength: 5 },
    // Home highlights (up to 3). Empty = the website builds three from the settings.
    highlights: {
      type: [new mongoose.Schema({ icon: { type: String, enum: HIGHLIGHT_ICONS }, title: { type: String, trim: true, maxlength: 60 }, text: { type: String, trim: true, maxlength: 160 } }, { _id: false })],
      default: undefined,
      validate: { validator: (list) => !Array.isArray(list) || list.length <= 3, message: "الحد الأقصى 3 مميزات" },
    },
    // Orders: the WhatsApp confirmation message ({الاسم} {رقم الطلب} {الإجمالي} {مدة التوصيل}).
    whatsappConfirmTemplate: { type: String, trim: true, maxlength: 1000 },
    // Online Stage 7A: pixels, consent, attribution window and "عرفتنا منين؟". No defaults here: catalog.effectiveSettings applies them.
    marketing: {
      metaPixelId: { type: String, trim: true, match: /^\d{15,16}$/ },
      tiktokPixelId: { type: String, trim: true, match: /^[A-Za-z0-9]{8,32}$/ },
      requireConsent: { type: Boolean },
      attributionDays: { type: Number, min: 1, max: 90 },
      askHeardFrom: { type: Boolean },
      heardFromOptions: { type: [{ type: String, trim: true, maxlength: 40 }], default: undefined },
      // Online Stage 7C: «أقصى ميزانية» for ads created from Nota, in EGP (marketing.publish edits them).
      maxDailyBudgetEgp: { type: Number, min: 1, max: 10000000 },
      maxTotalBudgetEgp: { type: Number, min: 1, max: 100000000 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WebsiteSettings", websiteSettingsSchema);
module.exports.MAX_BANNERS = MAX_BANNERS;
module.exports.MAX_FEATURED = MAX_FEATURED;
module.exports.HIGHLIGHT_ICONS = HIGHLIGHT_ICONS;
module.exports.BRAND_COLORS = BRAND_COLORS;
module.exports.DEFAULT_BRAND_COLOR = DEFAULT_BRAND_COLOR;
