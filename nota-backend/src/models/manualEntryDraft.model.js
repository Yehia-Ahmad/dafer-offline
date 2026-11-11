const mongoose = require("mongoose");
const auditFieldsPlugin = require("../auth/auditFields.plugin");

// Stage 22: a manual journal entry. It is NOT a JournalEntry while it is a draft (never in reports or health). Posting validates it and
// creates the JournalEntry (type "manual", source { type: "manual", id: this._id }) in one transaction, then marks the draft posted.
// A posted draft is never edited. It keeps what the statements need (party lines, the allocation of a customer credit, the reversal),
// so the customer/supplier statements are computed from documents, independent of the ledger, like every other statement line.
const lineSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
  description: { type: String, trim: true, maxlength: 200, default: "" },
  debit: { type: Number, default: 0, min: 0 },
  credit: { type: Number, default: 0, min: 0 },
  partyType: { type: String, enum: ["customer", "supplier", null], default: null },
  partyId: { type: mongoose.Schema.Types.ObjectId, default: null },
  partyName: { type: String, default: null },
}, { _id: false });

// A customer credit is set against the customer's open items, oldest first (Stage 19 apply-credit mechanism, source "manual_entry").
const allocationSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["invoice", "opening"], required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  number: { type: String, default: null },
  amount: { type: Number, required: true },
}, { _id: false });

const manualEntryDraftSchema = new mongoose.Schema({
  status: { type: String, enum: ["draft", "posted"], default: "draft", index: true },
  date: { type: Date, required: true, index: true },
  memo: { type: String, trim: true, maxlength: 500, default: "" },
  lines: { type: [lineSchema], default: [] },
  // Set when posted.
  number: { type: String, default: undefined },
  entryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: undefined },
  postedAt: Date,
  postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  postedByName: { type: String, trim: true },
  allocations: { type: [allocationSchema], default: [] },
  reversal: {
    type: new mongoose.Schema({
      entryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
      number: String,
      date: Date,
      reason: { type: String, trim: true },
      at: Date,
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      byName: { type: String, trim: true },
    }, { _id: false }),
    default: undefined,
  },
}, { timestamps: true });

manualEntryDraftSchema.index({ "lines.partyId": 1, status: 1 });
manualEntryDraftSchema.plugin(auditFieldsPlugin);
module.exports = mongoose.model("ManualEntryDraft", manualEntryDraftSchema);
