const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");
const { endsSetupModePlugin } = require("../accounting/setupState");

// Stage 20: a purchase invoice (PO-000001). The goods enter stock when it is saved.
// unitCost = lineCost / qty, where lineCost is the line value after the allocated discount and other costs.
const itemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  name: { type: String, trim: true },
  code: { type: String, trim: true },
  qty: { type: Number, required: true, min: 0.0001 },
  unitPrice: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  // The line's share of the invoice: lineTotal - allocated discount + allocated other costs. Σ lineCost = total.
  lineCost: { type: Number, required: true, min: 0 },
  unitCost: { type: Number, required: true, min: 0 },
  // The product's average cost after this line (a hint, and the trail of the average).
  newAverageCost: { type: Number, min: 0 },
  returnedQty: { type: Number, default: 0, min: 0 },
  returnedValue: { type: Number, default: 0, min: 0 },
}, { _id: true });

const purchaseSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
  supplierName: { type: String, trim: true },
  supplierInvoiceNo: { type: String, trim: true, maxlength: 60 },
  date: { type: Date, required: true, index: true },
  items: { type: [itemSchema], validate: [(rows) => rows.length > 0, "items required"] },
  subtotal: { type: Number, required: true, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  otherCosts: { type: Number, default: 0, min: 0 },
  // What we owe the supplier. With VAT: netTotal (= Σ lineCost, the stock value) + vatAmount. Without VAT: the net.
  total: { type: Number, required: true, min: 0.01 },
  // Stage 21 (absent with VAT off): VAT stored when the purchase was saved. Inventory never includes recoverable VAT.
  netTotal: { type: Number, min: 0.01 },
  vatAmount: { type: Number, min: 0 },
  vatRate: { type: Number, min: 0, max: 100 },
  vatRegistered: { type: Boolean },
  vatPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
  // Σ VAT already given back by purchase returns (the final return takes vatAmount - this).
  vatReturnedAmount: { type: Number, min: 0 },
  paidAmount: { type: Number, default: 0, min: 0 },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox" },
  pvId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierPayment" },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledByName: { type: String, trim: true },
  notes: { type: String, trim: true, maxlength: 1000 },
}, { timestamps: true });

purchaseSchema.plugin(auditFieldsPlugin);
purchaseSchema.plugin(endsSetupModePlugin);
module.exports = mongoose.model("Purchase", purchaseSchema);
