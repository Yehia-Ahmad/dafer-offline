const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");
const attachPublicCacheInvalidation = require("../utils/publicCacheInvalidation");

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم الفئة مطلوب"],
      trim: true,
      unique: true,
      maxlength: [120, "يجب ألا يزيد اسم الفئة عن 120 حرف"],
    },
    image: {
      type: String,
      trim: true,
      validate: {
        validator: isBase64Image,
        message:
          "يجب أن تكون صورة الفئة سلسلة base64 صالحة (خام أو بصيغة data URI)",
      },
    },
    specifications: {
      type: [
        {
          type: mongoose.Schema.Types.Mixed,
        },
      ],
      default: [],
    },
    translations: {
      ar: {
        name: { type: String, trim: true, maxlength: 200 },
        description: { type: String, trim: true, maxlength: 5000 },
        shortDescription: { type: String, trim: true, maxlength: 500 },
        slug: { type: String, trim: true, maxlength: 200 },
        imageAlt: { type: String, trim: true, maxlength: 200 },
      },
      en: {
        name: { type: String, trim: true, maxlength: 200 },
        description: { type: String, trim: true, maxlength: 5000 },
        shortDescription: { type: String, trim: true, maxlength: 500 },
        slug: { type: String, trim: true, maxlength: 200 },
        imageAlt: { type: String, trim: true, maxlength: 200 },
      },
    },
    seo: {
      ar: {
        metaTitle: { type: String, trim: true, maxlength: 70 },
        metaDescription: { type: String, trim: true, maxlength: 170 },
        keywords: { type: [String], default: undefined },
        ogTitle: { type: String, trim: true, maxlength: 70 },
        ogDescription: { type: String, trim: true, maxlength: 170 },
        canonicalOverride: { type: String, trim: true, maxlength: 2000 },
      },
      en: {
        metaTitle: { type: String, trim: true, maxlength: 70 },
        metaDescription: { type: String, trim: true, maxlength: 170 },
        keywords: { type: [String], default: undefined },
        ogTitle: { type: String, trim: true, maxlength: 70 },
        ogDescription: { type: String, trim: true, maxlength: 170 },
        canonicalOverride: { type: String, trim: true, maxlength: 2000 },
      },
      ogImage: { type: String, trim: true },
      robotsIndex: { type: Boolean, default: true },
      robotsFollow: { type: Boolean, default: true },
      includeInSitemap: { type: Boolean, default: true },
      sitemapPriority: { type: Number, default: 0.7, min: 0, max: 1 },
      sitemapChangeFrequency: {
        type: String,
        default: "weekly",
        enum: ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"],
      },
    },
    slugAliases: {
      type: [
        {
          language: { type: String, enum: ["ar", "en"], required: true },
          slug: { type: String, required: true, trim: true },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

categorySchema.index(
  { "translations.ar.slug": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "translations.ar.slug": { $type: "string" } } }
);
categorySchema.index(
  { "translations.en.slug": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "translations.en.slug": { $type: "string" } } }
);
categorySchema.index({ "slugAliases.language": 1, "slugAliases.slug": 1 });
attachPublicCacheInvalidation(categorySchema);

module.exports = mongoose.model("Category", categorySchema);
