const mongoose = require("mongoose");

const lineSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
  accountCode: { type: String, required: true },
  accountName: { type: String, required: true },
  accountNameAr: { type: String, required: true },
  accountNameEn: { type: String, required: true },
  debit: { type: Number, default: 0, min: 0 },
  credit: { type: Number, default: 0, min: 0 },
  partyType: { type: String, enum: ["customer", "supplier", null], default: null },
  partyId: { type: mongoose.Schema.Types.ObjectId, default: null },
  partyName: { type: String, default: null },
  description: { type: String, default: "" },
}, { _id: false });

const journalEntrySchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  date: { type: Date, required: true, index: true },
  type: { type: String, enum: ["auto", "reversal", "opening", "legacy_reversal", "manual", "closing"], required: true, index: true },
  source: {
    type: { type: String, required: true }, id: { type: mongoose.Schema.Types.ObjectId, required: true }, number: { type: String, default: null },
    // "edit": the reversal and the re-post of an invoice edit (box movements show them as one kind). Absent on every other entry.
    kind: { type: String, enum: ["edit"], default: undefined },
  },
  lines: { type: [lineSchema], required: true, validate: (lines) => lines.length >= 2 },
  totalDebit: { type: Number, required: true, min: 0 },
  totalCredit: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ["posted"], default: "posted" },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: null },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: null },
  memo: { type: String, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdByName: { type: String, default: null },
}, { timestamps: true });

journalEntrySchema.index({ "source.type": 1, "source.id": 1 });
journalEntrySchema.index({ "lines.accountId": 1, date: 1 });
journalEntrySchema.index({ "lines.partyId": 1, date: 1 });
journalEntrySchema.index({ date: -1, createdAt: -1 });
// At most one reversal per entry, even under concurrent requests.
journalEntrySchema.index({ reversalOf: 1 }, { unique: true, partialFilterExpression: { reversalOf: { $type: "objectId" } } });
module.exports = mongoose.model("JournalEntry", journalEntrySchema);
