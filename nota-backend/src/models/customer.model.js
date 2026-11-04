const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

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

// Stage 13: createdBy / updatedBy from the signed-in user (nothing when auth is off).
customerSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("Customer", customerSchema);
