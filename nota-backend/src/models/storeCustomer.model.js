const mongoose = require("mongoose");

const MAX_ADDRESSES = 5;
const BCRYPT_COST = 10;

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 60 },
    zone: { type: mongoose.Schema.Types.ObjectId, ref: "DeliveryZone" },
    address: { type: String, required: [true, "العنوان مطلوب"], trim: true, maxlength: [500, "العنوان طويل"] },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: true }
);

// A customer of the website. NOT the shop's Customer (credit sales): the two are never linked in this stage.
const storeCustomerSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "الاسم مطلوب"], trim: true, maxlength: [120, "الاسم طويل"] },
    phone: { type: String, required: [true, "رقم الهاتف مطلوب"], trim: true, unique: true },
    passwordHash: { type: String, required: true },
    addresses: {
      type: [addressSchema],
      default: [],
      validate: { validator: (list) => !Array.isArray(list) || list.length <= MAX_ADDRESSES, message: `الحد الأقصى ${MAX_ADDRESSES} عناوين` },
    },
    isActive: { type: Boolean, default: true },
    // Raised on a password change: ends every older token of this customer.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StoreCustomer", storeCustomerSchema);
module.exports.MAX_ADDRESSES = MAX_ADDRESSES;
module.exports.BCRYPT_COST = BCRYPT_COST;
