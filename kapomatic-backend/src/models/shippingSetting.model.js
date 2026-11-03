const mongoose = require("mongoose");

const governmentShippingFeeSchema = new mongoose.Schema(
  {
    government: {
      type: String,
      required: [true, "اسم المحافظة مطلوب"],
      trim: true,
      maxlength: [120, "يجب ألا يزيد اسم المحافظة عن 120 حرف"],
    },
    shippingFees: {
      type: Number,
      required: [true, "قيمة الشحن مطلوبة"],
      min: [0, "قيمة الشحن لا يمكن أن تكون سالبة"],
    },
  },
  { _id: true }
);

const shippingSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      unique: true,
      immutable: true,
    },
    governmentFees: {
      type: [governmentShippingFeeSchema],
      default: [],
    },
    freeShippingMinimumAmount: {
      type: Number,
      default: 0,
      min: [0, "الحد الأدنى للشحن المجاني لا يمكن أن يكون سالبًا"],
    },
    currency: {
      type: String,
      default: "EGP",
      uppercase: true,
      trim: true,
      match: [/^[A-Z]{3}$/, "يجب أن تكون العملة رمز ISO 4217 مكونًا من 3 أحرف"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShippingSetting", shippingSettingSchema);
