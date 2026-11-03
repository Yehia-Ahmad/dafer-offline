const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");

const MAX_LOGO_BYTES = 500 * 1024;
const MAX_PHONES = 3;

// Decoded size of a base64 image (raw or data URI), without decoding it.
const getBase64DecodedBytes = (value) => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  const splitIndex = trimmed.indexOf(";base64,");
  const base64Part = (
    trimmed.startsWith("data:") && splitIndex !== -1
      ? trimmed.slice(splitIndex + ";base64,".length)
      : trimmed
  ).replace(/\s+/g, "");
  const padding = base64Part.endsWith("==") ? 2 : base64Part.endsWith("=") ? 1 : 0;
  return Math.floor((base64Part.length * 3) / 4) - padding;
};

// A single document (key "default") with the shop's own details, printed on invoices.
const shopProfileSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: [true, "اسم المتجر مطلوب"],
      trim: true,
      maxlength: [150, "يجب ألا يزيد اسم المتجر عن 150 حرف"],
    },
    address: {
      type: String,
      trim: true,
      maxlength: [500, "يجب ألا يزيد عنوان المتجر عن 500 حرف"],
    },
    phones: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: [30, "يجب ألا يزيد رقم هاتف المتجر عن 30 حرف"],
        },
      ],
      default: [],
      validate: {
        validator: (phones) => !Array.isArray(phones) || phones.length <= MAX_PHONES,
        message: `يمكن إضافة ${MAX_PHONES} أرقام هواتف للمتجر على الأكثر`,
      },
    },
    logo: {
      type: String,
      trim: true,
      validate: [
        {
          validator: isBase64Image,
          message: "يجب أن يكون شعار المتجر سلسلة base64 صالحة (خام أو بصيغة data URI)",
        },
        {
          validator: (logo) => getBase64DecodedBytes(logo) <= MAX_LOGO_BYTES,
          message: "يجب ألا يزيد حجم شعار المتجر عن 500 كيلوبايت",
        },
      ],
    },
    taxNumber: {
      type: String,
      trim: true,
      maxlength: [50, "يجب ألا يزيد الرقم الضريبي عن 50 حرف"],
    },
    commercialRegister: {
      type: String,
      trim: true,
      maxlength: [50, "يجب ألا يزيد رقم السجل التجاري عن 50 حرف"],
    },
    invoiceFooter: {
      type: String,
      trim: true,
      maxlength: [500, "يجب ألا يزيد نص تذييل الفاتورة عن 500 حرف"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShopProfile", shopProfileSchema);
