const mongoose = require("mongoose");

// Stage 23: one row per reserved copy number of a printed document (see print.controller.js).
//   reserved -> printed (confirm) | released (release). A reservation that stays "reserved" (the app crashed) is
//   never cleaned up: its number stays counted, so the counters over-count and never under-count.
const printReservationSchema = new mongoose.Schema({
  key: { type: String, required: true, index: true }, // the counter: "<number>|receipt" or "<number>|page"
  number: { type: String, required: true },
  paperClass: { type: String, enum: ["receipt", "page"], required: true },
  copyNo: { type: Number, required: true, min: 1 },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  deviceId: { type: String, default: null },
  status: { type: String, enum: ["reserved", "printed", "released"], default: "reserved" },
  gaveBack: { type: Boolean, default: false },
  resolvedAt: Date,
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
printReservationSchema.index({ key: 1, copyNo: 1 });

module.exports = mongoose.model("PrintReservation", printReservationSchema);
