const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const attachPublicCacheInvalidation = require("../utils/publicCacheInvalidation");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم المنتج مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم المنتج عن 200 حرف"],
    },
    code: {
      type: String,
      required: [true, "كود المنتج مطلوب"],
      trim: true,
      maxlength: [100, "يجب ألا يزيد كود المنتج عن 100 حرف"],
    },
    inventoryCount: {
      type: Number,
      required: [true, "عدد المنتج في المخزون مطلوب"],
      min: [0, "عدد المخزون لا يمكن أن يكون سالبًا"],
    },
    image: {
      type: String,
      trim: true,
      validate: {
        validator: isBase64Image,
        message:
          "يجب أن تكون صورة المنتج سلسلة base64 صالحة (خام أو بصيغة data URI)",
      },
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: [true, "معرّف الفئة مطلوب"],
    },
    wholesalePrice: {
      type: Number,
      required: [true, "سعر الجملة مطلوب"],
      min: [0, "سعر الجملة لا يمكن أن يكون سالبًا"],
    },
    purchasePrice: {
      type: Number,
      default: 0,
      min: [0, "سعر الشراء لا يمكن أن يكون سالبًا"],
      validate: {
        validator: function validatePurchasePrice(value) {
          const purchasePrice = Number(value);
          if (!Number.isFinite(purchasePrice)) return false;

          const wholesalePrice = Number(this.wholesalePrice);
          if (Number.isFinite(wholesalePrice) && purchasePrice > wholesalePrice) {
            return false;
          }

          const retailPrice = Number(this.retailPrice);
          if (Number.isFinite(retailPrice) && purchasePrice > retailPrice) {
            return false;
          }

          return true;
        },
        message: "سعر الشراء لا يمكن أن يكون أكبر من سعر الجملة أو التجزئة",
      },
    },
    retailPrice: {
      type: Number,
      required: [true, "سعر التجزئة مطلوب"],
      min: [0, "سعر التجزئة لا يمكن أن يكون سالبًا"],
      validate: {
        validator: function validateRetailPrice(value) {
          return value >= this.wholesalePrice;
        },
        message: "يجب أن يكون سعر التجزئة أكبر من أو يساوي سعر الجملة",
      },
    },
    discountPercentage: {
      type: Number,
      default: 0,
      min: [0, "نسبة الخصم لا يمكن أن تكون أقل من صفر"],
      max: [100, "نسبة الخصم لا يمكن أن تكون أكبر من 100"],
    },
    soldItemCount: {
      type: Number,
      default: 0,
      min: [0, "عدد العناصر المباعة لا يمكن أن يكون سالبًا"],
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
      sitemapPriority: { type: Number, default: 0.8, min: 0, max: 1 },
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

productSchema.index(
  { "translations.ar.slug": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "translations.ar.slug": { $type: "string" } } }
);
productSchema.index(
  { "translations.en.slug": 1 },
  { unique: true, sparse: true, partialFilterExpression: { "translations.en.slug": { $type: "string" } } }
);
productSchema.index({ category: 1, createdAt: -1 });
productSchema.index({ "slugAliases.language": 1, "slugAliases.slug": 1 });

productSchema.virtual("priceAfterDiscount").get(function getPriceAfterDiscount() {
  return calculatePriceAfterDiscount(this.retailPrice, this.discountPercentage);
});

productSchema.set("toJSON", {
  virtuals: true,
  transform: (_document, returnedObject) => {
    delete returnedObject.id;
    return returnedObject;
  },
});
attachPublicCacheInvalidation(productSchema);

module.exports = mongoose.model("Product", productSchema);
