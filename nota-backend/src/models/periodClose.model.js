const mongoose = require("mongoose");

// Stage 22: one closed accounting period (a month, or a whole fiscal year with the yearly frequency). meta.closing.lockedThrough
// is the periodEnd of the latest "closed" one; a reopen marks it "reopened" (history stays).
// entryId is the year-end closing entry (type "closing", source { type: "period_close", id: this._id }), when the period ended on the
// fiscal year end and there was anything to close; reopening reverses it (reversalEntryId).
const periodCloseSchema = new mongoose.Schema({
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  label: { type: String, required: true },
  status: { type: String, enum: ["closed", "reopened"], default: "closed", index: true },
  yearEnd: { type: Boolean, default: false },
  closedAt: { type: Date, required: true },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  closedByName: { type: String, trim: true },
  entryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: undefined },
  entryNumber: { type: String, default: undefined },
  netProfit: { type: Number, default: undefined },
  warnings: { type: mongoose.Schema.Types.Mixed, default: undefined },
  reopenedAt: Date,
  reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  reopenedByName: { type: String, trim: true },
  reopenReason: { type: String, trim: true, maxlength: 500 },
  reversalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: undefined },
}, { timestamps: true });

// At most one live close per period end.
periodCloseSchema.index({ periodEnd: 1 }, { unique: true, partialFilterExpression: { status: "closed" } });
module.exports = mongoose.model("PeriodClose", periodCloseSchema);
