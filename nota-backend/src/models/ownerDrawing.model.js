const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

const ownerDrawingSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  date: { type: Date, required: true },
  note: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ["posted", "cancelled"], default: "posted", index: true },
  cancelReason: { type: String, trim: true, maxlength: 500 },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  cancelledByName: { type: String, trim: true },
}, { timestamps: true });

ownerDrawingSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("OwnerDrawing", ownerDrawingSchema);
