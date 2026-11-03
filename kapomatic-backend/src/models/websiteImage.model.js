const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");
const attachPublicCacheInvalidation = require("../utils/publicCacheInvalidation");

const websiteImageSpecificationFilterSchema = new mongoose.Schema(
  {
    specificationName: {
      type: String,
      required: [true, "اسم الخاصية مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم الخاصية عن 200 حرف"],
    },
    values: {
      type: [mongoose.Schema.Types.Mixed],
      required: [true, "قيم الخاصية مطلوبة"],
      default: [],
    },
  },
  { _id: false }
);

const websiteImageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      maxlength: [200, "يجب ألا يزيد عنوان صورة الموقع عن 200 حرف"],
      default: "",
    },
    imageBase64: {
      type: String,
      required: [true, "صورة الموقع مطلوبة"],
      trim: true,
      validate: {
        validator: isBase64Image,
        message: "يجب أن تكون صورة الموقع سلسلة base64 صالحة (خام أو بصيغة data URI)",
      },
    },
    viewOnly: {
      type: Boolean,
      default: false,
    },
    targetType: {
      type: String,
      required: [
        function requireTargetType() {
          return !this.viewOnly;
        },
        "نوع استهداف صورة الموقع مطلوب",
      ],
      enum: {
        values: ["category", "product", "both", "price", "specification"],
        message: "نوع الاستهداف يجب أن يكون category أو product أو both أو price أو specification",
      },
    },
    categoryIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Category",
        },
      ],
      default: [],
    },
    productIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
        },
      ],
      default: [],
    },
    maxPrice: {
      type: Number,
      min: [0, "الحد الأقصى للسعر لا يمكن أن يكون سالبًا"],
      default: null,
    },
    specificationFilters: {
      type: [websiteImageSpecificationFilterSchema],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

websiteImageSchema.index({ isActive: 1, createdAt: -1 });
attachPublicCacheInvalidation(websiteImageSchema);

module.exports = mongoose.model("WebsiteImage", websiteImageSchema);
