const mongoose = require("mongoose");

const metaSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  version: { type: Number, required: true, min: 0, default: 0 },
  migrationProgress: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Stage 24: a copy of the license text (the file in the license folder is the source of truth).
  licenseText: { type: String, default: undefined },
  ledgerStartAt: { type: Date, default: undefined },
  // Stage 22: period closing. lockedThrough = the last closed business day (a UTC-midnight date); nothing may post on or before it.
  // touchedAt is written by back-dated postings so a concurrent close conflicts with them and one retries.
  closing: {
    type: new mongoose.Schema({
      lockedThrough: { type: Date, default: undefined },
      touchedAt: { type: Date, default: undefined },
    }, { _id: false }),
    default: undefined,
  },
  // Stage 18: the opening-balance wizard. Absent = still "setup" (nothing saved yet).
  opening: {
    type: new mongoose.Schema({
      status: { type: String, enum: ["setup", "finalized"], default: "setup" },
      entryId: { type: mongoose.Schema.Types.ObjectId, default: null },
      savedAt: { type: Date, default: undefined },
      finalizedAt: { type: Date, default: undefined },
      finalizedBy: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      finalizedByName: { type: String, default: undefined },
      // Setup mode ends with a write: the first sale/credit sale/return/receipt sets setupEndedAt;
      // every setup-mode stock posting touches lastSetupPostingAt (so the two conflict and one retries).
      setupEndedAt: { type: Date, default: undefined },
      lastSetupPostingAt: { type: Date, default: undefined },
      // What the current opening entry was built from (the health "opening" check compares against it).
      data: {
        type: new mongoose.Schema({
          cash: { type: Number, default: 0 },
          fixedAssets: { type: Number, default: 0 },
          inventory: { type: Number, default: 0 },
          inventoryMode: { type: String, enum: ["live", "carried"], default: "live" },
          banks: { type: [new mongoose.Schema({ accountId: mongoose.Schema.Types.ObjectId, amount: Number }, { _id: false })], default: [] },
          // Customer balances that came from invoices before the ledger start (Stage 17 migration); carried forward as they are.
          carriedCustomers: { type: [new mongoose.Schema({ customerId: mongoose.Schema.Types.ObjectId, amount: Number }, { _id: false })], default: [] },
        }, { _id: false }),
        default: undefined,
      },
    }, { _id: false }),
    default: undefined,
  },
}, { versionKey: false });

module.exports = mongoose.model("Meta", metaSchema);
