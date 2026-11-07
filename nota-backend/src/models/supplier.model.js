const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 18: minimal supplier. Stage 20 adds purchases, payments and the supplier statement on top of it.
const supplierSchema = new mongoose.Schema({
  name: { type: String, required: [true, "اسم المورد مطلوب"], trim: true, maxlength: [200, "يجب ألا يزيد اسم المورد عن 200 حرف"] },
  phones: { type: [{ type: String, trim: true, maxlength: 30 }], default: [] },
  contactPerson: { type: String, trim: true, maxlength: 120 },
  address: { type: String, trim: true, maxlength: 300 },
  supplies: { type: String, trim: true, maxlength: 300 },
  taxNumber: { type: String, trim: true, maxlength: 50 },
  // Stage 21: the default of "المورد مسجل ضريبيًا" on a new purchase.
  vatRegistered: { type: Boolean },
  // 0 = cash; 30, 60 or any custom number of days.
  paymentTermsDays: { type: Number, min: 0, max: 3650, default: undefined },
  notes: { type: String, trim: true, maxlength: 1000 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

supplierSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("Supplier", supplierSchema);
