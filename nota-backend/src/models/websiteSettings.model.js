const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");

const MAX_BANNERS = 5;
const MAX_FEATURED = 8;
const MAX_BANNER_BYTES = 1024 * 1024;

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
  },
  { timestamps: true }
);

module.exports = mongoose.model("WebsiteSettings", websiteSettingsSchema);
module.exports.MAX_BANNERS = MAX_BANNERS;
module.exports.MAX_FEATURED = MAX_FEATURED;
