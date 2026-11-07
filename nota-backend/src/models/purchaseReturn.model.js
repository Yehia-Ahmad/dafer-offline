const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 20: goods returned to a supplier (PR-000001), for items of one purchase invoice.
const purchaseReturnSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", required: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
  date: { type: Date, required: true, index: true },
  items: [{
    _id: false,
    itemId: { type: mongoose.Schema.Types.ObjectId },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, trim: true },
    qty: { type: Number, required: true, min: 0.0001 },
    unitCost: { type: Number, required: true, min: 0 },
    value: { type: Number, required: true, min: 0 },
  }],
  total: { type: Number, required: true, min: 0.01 },
  reason: { type: String, trim: true, maxlength: 500 },
  refundId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierRefund" },
}, { timestamps: true });

purchaseReturnSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("PurchaseReturn", purchaseReturnSchema);
