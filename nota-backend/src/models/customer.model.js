const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم العميل مطلوب"],
      trim: true,
      maxlength: [200, "يجب ألا يزيد اسم العميل عن 200 حرف"],
    },
    phone: {
      type: String,
      required: [true, "رقم هاتف العميل مطلوب"],
      trim: true,
      unique: true,
      maxlength: [30, "يجب ألا يزيد رقم هاتف العميل عن 30 حرف"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", customerSchema);
