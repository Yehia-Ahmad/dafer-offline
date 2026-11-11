const mongoose = require("mongoose");
const isBase64Image = require("../utils/isBase64Image");

const MAX_LOGO_BYTES = 500 * 1024;
const MAX_PHONES = 3;
// Stage 15: auto-lock choices in minutes (0 = off).
const AUTO_LOCK_MINUTES = [0, 5, 10, 15, 30, 60];
const DEFAULT_AUTO_LOCK_MINUTES = 10;

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
    // Stage 15: lock the screen after this many idle minutes, on every PC (0 = off).
    autoLockMinutes: {
      type: Number,
      enum: { values: AUTO_LOCK_MINUTES, message: "مدة القفل التلقائي غير صالحة" },
      default: DEFAULT_AUTO_LOCK_MINUTES,
    },
    // Stage 22: period closing settings (owner). Additive: absent from GET until saved.
    closing: {
      frequency: { type: String, enum: ["monthly", "yearly"], default: "monthly" },
      fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 1 },
    },
    // Stage 21: optional VAT. `startDate` is set each time VAT is turned on (documents dated before it are untouched).
    vat: {
      enabled: { type: Boolean, default: false },
      rate: { type: Number, min: [0, "نسبة الضريبة لا يمكن أن تكون سالبة"], max: [100, "نسبة الضريبة لا يمكن أن تزيد عن 100"], default: 14 },
      pricesIncludeVat: { type: Boolean, default: true },
      startDate: { type: Date },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShopProfile", shopProfileSchema);
module.exports.AUTO_LOCK_MINUTES = AUTO_LOCK_MINUTES;
module.exports.DEFAULT_AUTO_LOCK_MINUTES = DEFAULT_AUTO_LOCK_MINUTES;
