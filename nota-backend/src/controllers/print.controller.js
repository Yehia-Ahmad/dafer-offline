const PrintCount = require("../models/printCount.model");
const JournalEntry = require("../models/journalEntry.model");
const Selling = require("../models/selling.model");
const CreditSale = require("../models/creditSale.model");
const Receipt = require("../models/receipt.model");
const ReturnLog = require("../models/returnLog.model");
const Shift = require("../models/shift.model");
const Purchase = require("../models/purchase.model");
const PurchaseReturn = require("../models/purchaseReturn.model");
const SupplierPayment = require("../models/supplierPayment.model");
const SupplierRefund = require("../models/supplierRefund.model");
const Expense = require("../models/expense.model");
const OwnerDrawing = require("../models/ownerDrawing.model");
const CustomerPayout = require("../models/customerPayout.model");
const VatPayment = require("../models/vatPayment.model");
const { audit } = require("../auth/audit");
const { hasPermission, forbidden } = require("../auth/middleware");

// Stage 23: print copy numbers.
//
//   GET  /api/print/next-copy?number=INV-000125&paper=A4   the copy number the NEXT print will carry (nothing is counted)
//   POST /api/print/log { number, paper }                  records ONE successful print / PDF save, returns its real copy number
//
// The page asks for the next number first (to render the "نسخة" mark), prints, and logs only AFTER the print or
// the PDF save succeeded: a cancelled dialog logs nothing. Copy 0 = the first print (no mark); 1 and up = "نسخة n".
// There are two counters per document: "receipt" (80mm) and "page" (A4/A5, a PDF counts in the class of its paper),
// so an A4 print of an invoice does not turn the next 80mm receipt into a "copy".
// The commit is an atomic $inc that returns the real number and the `document.printed` audit entry records THAT
// number. If two PCs print the same document at the same moment they both read the same "next" number, so the mark
// printed on one of them may be one lower than the audited number; the audit entry is the truth.
//
// The document type is the number's prefix; the caller needs the permission of that document's screen, and the
// document must exist (404 DOCUMENT_NOT_FOUND), so nobody can fill the counters with invented numbers.
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

// The collection that holds each prefix's documents (all keep the document number in `number`).
const PREFIX_MODELS = Object.freeze({
  INV: Selling, CR: CreditSale, RC: Receipt, RT: ReturnLog, SH: Shift, PO: Purchase, PR: PurchaseReturn,
  PV: SupplierPayment, SR: SupplierRefund, EX: Expense, DR: OwnerDrawing, CP: CustomerPayout, VP: VatPayment, JE: JournalEntry,
});

const NUMBER_PATTERN = /^([A-Z]{2,3})-\d{6,9}$/;
const PAPERS = new Set(["80mm", "A4", "A5"]);
const paperClassOf = (paper) => (paper === "80mm" ? "receipt" : "page");
const counterId = (number, paperClass) => `${number}|${paperClass}`;

/** Validates the request, checks the permission, then that the document exists. */
async function resolveDocument(req, res, source) {
  const number = typeof source?.number === "string" ? source.number.trim().toUpperCase() : "";
  const match = NUMBER_PATTERN.exec(number);
  const permissions = match ? PREFIX_PERMISSIONS[match[1]] : null;
  if (!permissions) {
    res.status(400);
    throw new Error("رقم المستند غير صحيح");
  }
  if (req.authEnabled && !permissions.some((key) => hasPermission(req.user, key))) throw forbidden();
  if (!(await PREFIX_MODELS[match[1]].exists({ number }))) {
    const error = new Error("المستند غير موجود");
    error.statusCode = 404;
    error.responseData = { code: "DOCUMENT_NOT_FOUND" };
    throw error;
  }
  const paper = PAPERS.has(source?.paper) ? source.paper : undefined;
  return { number, prefix: match[1], paper, paperClass: paperClassOf(paper) };
}

const getNextCopy = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { number, paperClass } = await resolveDocument(req, res, req.query);
  const counter = await PrintCount.findById(counterId(number, paperClass)).select("count").lean();
  res.json({ number, paperClass, copy: counter ? counter.count : 0 });
};

const logPrint = async (req, res) => {
  const { number, prefix, paper, paperClass } = await resolveDocument(req, res, req.body);
  const counter = await PrintCount.findOneAndUpdate(
    { _id: counterId(number, paperClass) },
    { $inc: { count: 1 }, $setOnInsert: { number, paperClass } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const copy = counter.count - 1;
  await audit(req, { action: "document.printed", entity: "document", entityId: number, details: { number, type: prefix, paper, paperClass, copy } });
  res.json({ number, copy, paperClass, printedAt: new Date().toISOString() });
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

module.exports = { PREFIX_MODELS, PREFIX_PERMISSIONS, getJournalRef, getNextCopy, logPrint };
