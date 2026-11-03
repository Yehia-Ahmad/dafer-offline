const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");
const attachPublicCacheInvalidation = require("../utils/publicCacheInvalidation");

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_error) {
    return false;
  }
};

const storeLocationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم المتجر مطلوب"],
      trim: true,
      maxlength: [150, "يجب ألا يزيد اسم المتجر عن 150 حرف"],
    },
    detailedLocation: {
      type: String,
      required: [true, "العنوان التفصيلي للمتجر مطلوب"],
      trim: true,
      maxlength: [500, "يجب ألا يزيد العنوان التفصيلي عن 500 حرف"],
    },
    mapLink: {
      type: String,
      required: [true, "رابط موقع المتجر على الخريطة مطلوب"],
      trim: true,
      validate: {
        validator: isHttpUrl,
        message: "رابط موقع المتجر على الخريطة غير صالح",
      },
    },
  },
  { _id: true }
);

const socialMediaLinkSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم منصة التواصل الاجتماعي مطلوب"],
      trim: true,
      maxlength: [100, "يجب ألا يزيد اسم منصة التواصل الاجتماعي عن 100 حرف"],
    },
    link: {
      type: String,
      required: [true, "رابط منصة التواصل الاجتماعي مطلوب"],
      trim: true,
      validate: {
        validator: isHttpUrl,
        message: "رابط منصة التواصل الاجتماعي غير صالح",
      },
    },
  },
  { _id: true }
);

const generalSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      unique: true,
      immutable: true,
    },
    mainLogo: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator: (value) => value === null || value === "" || isBase64Image(value),
        message: "يجب أن يكون الشعار صورة base64 صالحة (خام أو بصيغة data URI)",
      },
    },
    mainColor: {
      type: String,
      default: "#000000",
      trim: true,
      validate: {
        validator: (value) => /^#[0-9a-f]{6}$/i.test(value),
        message: "يجب أن يكون اللون الرئيسي بصيغة hex مثل #1A73E8",
      },
    },
    storeLocations: {
      type: [storeLocationSchema],
      default: [],
    },
    socialMediaLinks: {
      type: [socialMediaLinkSchema],
      default: [],
    },
    walletPhone: {
      type: String,
      default: null,
      trim: true,
      maxlength: [30, "يجب ألا يزيد رقم المحفظة عن 30 حرف"],
    },
    instapayLink: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator: (value) => value === null || value === "" || isHttpUrl(value),
        message: "رابط انستاباي غير صالح",
      },
    },
    homePageCategoryIds: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Category",
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);
attachPublicCacheInvalidation(generalSettingSchema);

module.exports = mongoose.model("GeneralSetting", generalSettingSchema);
