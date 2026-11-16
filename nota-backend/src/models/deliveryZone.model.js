const mongoose = require("mongoose");

const deliveryZoneSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "اسم المنطقة مطلوب"], trim: true, maxlength: [120, "اسم المنطقة طويل"] },
    fee: { type: Number, required: [true, "رسوم التوصيل مطلوبة"], min: [0, "رسوم التوصيل لا يمكن أن تكون سالبة"] },
    estimatedTime: { type: String, trim: true, maxlength: [120, "وقت التوصيل المتوقع طويل"] },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeliveryZone", deliveryZoneSchema);
