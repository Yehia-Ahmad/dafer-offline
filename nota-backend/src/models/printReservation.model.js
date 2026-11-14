const mongoose = require("mongoose");

// Stage 23: one row per reserved copy number of a printed document (see print.controller.js).
//   reserved -> printed (confirm) | released (release). A reservation that stays "reserved" (the app crashed) is
//   never cleaned up: its number stays counted: a crash over-counts (the next print may be marked as a copy), which is the safe side.
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
// autoIndex is off for this model on purpose: its indexes are built by ensureIndexes() on startup, AFTER the migrations
// (migration 11 drops the old non-unique key_1_copyNo_1 index that an earlier build created, which would otherwise clash).
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false });
// Safety net: two LIVE (reserved or printed) reservations can never hold the same copy number of a counter.
printReservationSchema.index({ key: 1, copyNo: 1 }, { name: "print_reservation_live_unique", unique: true, partialFilterExpression: { status: { $in: ["reserved", "printed"] } } });

module.exports = mongoose.model("PrintReservation", printReservationSchema);
