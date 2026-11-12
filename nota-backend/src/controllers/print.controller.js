const PrintCount = require("../models/printCount.model");
const JournalEntry = require("../models/journalEntry.model");
const { audit } = require("../auth/audit");
const { hasPermission, forbidden } = require("../auth/middleware");

// Stage 23: POST /api/print-log { number, paper? } (signed-in user).
//
// Every print of an 80mm receipt or an A4/A5 invoice/voucher is recorded here BEFORE it prints:
// the server returns the copy number (0 = the first print of that document, whenever it happens;
// 1 and up = reprints, marked "نسخة") and writes the `document.printed` audit entry (number, type,
// user, copy). The counter is atomic ($inc), so the answer is the same on every PC.
//
// The document type is the number's prefix; the caller needs the permission of that document's screen.
const PREFIX_PERMISSIONS = Object.freeze({
  INV: ["sales.view", "sales.create"],
  CR: ["credit.view", "credit.create"],
  RC: ["credit.collect", "credit.view", "customers.view"],
  RT: ["returns.view", "returns.create"],
  SH: ["shift.operate", "shift.manage"],
  PO: ["purchases.view"],
  PR: ["purchases.view"],
  PV: ["suppliers.view", "suppliers.pay"],
  SR: ["suppliers.view", "suppliers.pay"],
  EX: ["expenses.create", "expenses.manage"],
  DR: ["owner.drawings"],
  CP: ["credit.collect"],
  VP: ["vat.file", "accounting.view"],
  JE: ["accounting.view"],
});

const NUMBER_PATTERN = /^([A-Z]{2,3})-\d{6,9}$/;
const PAPERS = new Set(["80mm", "A4", "A5"]);

const logPrint = async (req, res) => {
  const number = typeof req.body?.number === "string" ? req.body.number.trim().toUpperCase() : "";
  const match = NUMBER_PATTERN.exec(number);
  const permissions = match ? PREFIX_PERMISSIONS[match[1]] : null;
  if (!permissions) {
    res.status(400);
    throw new Error("رقم المستند غير صحيح");
  }
  const paper = PAPERS.has(req.body?.paper) ? req.body.paper : undefined;
  if (req.authEnabled && !permissions.some((key) => hasPermission(req.user, key))) throw forbidden();
  const counter = await PrintCount.findOneAndUpdate({ _id: number }, { $inc: { count: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  const copy = counter.count - 1;
  await audit(req, { action: "document.printed", entity: "document", entityId: number, details: { number, type: match[1], paper, copy } });
  res.json({ number, copy, printedAt: new Date().toISOString() });
};

// GET /api/print/journal-ref/:number: the journal entry number a voucher prints in its footer ("قيد رقم JE-000415").
// Same permission as the document itself (its number prefix); only the number is returned, never the lines.
const getJournalRef = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const number = String(req.params.number || "").trim().toUpperCase();
  const match = NUMBER_PATTERN.exec(number);
  const permissions = match ? PREFIX_PERMISSIONS[match[1]] : null;
  if (!permissions) {
    res.status(400);
    throw new Error("رقم المستند غير صحيح");
  }
  if (req.authEnabled && !permissions.some((key) => hasPermission(req.user, key))) throw forbidden();
  const entry = await JournalEntry.findOne({ "source.number": number, type: "auto" }).sort({ createdAt: 1 }).select("number").lean();
  res.json({ number, journalNumber: entry ? entry.number : null });
};

module.exports = { PREFIX_PERMISSIONS, getJournalRef, logPrint };
