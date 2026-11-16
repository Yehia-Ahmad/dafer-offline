const mongoose = require("mongoose");

// Online Stage 4: a delivery courier. Created together (one transaction) with a cash box (type cash, not main, no shifts)
// and a customer account (Customer.isCourier). The courier owes the order total from dispatch until the cash is collected.
const courierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    isActive: { type: Boolean, default: true },
    boxId: { type: mongoose.Schema.Types.ObjectId, ref: "CashBox", required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Courier", courierSchema);
