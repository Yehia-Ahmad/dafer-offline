const mongoose = require("mongoose");
const PrintCount = require("../models/printCount.model");
const PrintReservation = require("../models/printReservation.model");
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

// Stage 23: print copy numbers by RESERVE / CONFIRM / RELEASE.
//
//   POST /api/print/reserve  { number, paperClass, prefix? }  takes the next copy number of that document and class
//   POST /api/print/confirm  { reservationId }               the print / PDF save went out: writes the document.printed audit
//   POST /api/print/release  { reservationId }               the dialog was cancelled or the print failed: gives the number back
//
// copyNo 1 is THE original (exactly one across all PCs: the reserve is an atomic $inc, two PCs can never both get 1);
// 2 and up are reprints ("نسخة"). There are two counters per document: "receipt" (80mm) and "page" (A4/A5, a PDF counts
// in the class of its paper), so an A4 print of an invoice does not turn its next 80mm receipt into a copy.
// Counter key: "<number>|receipt" or "<number>|page"; every reserve also stores a PrintReservation.
//   * confirm: only the user who reserved. Status reserved -> printed and ONE document.printed audit entry (number, type,
//     paper class, user, copy number). A retry is idempotent (no second audit). Confirming a released reservation is 409.
//   * release: only the same user and only while the status is "reserved" (a printed one is 409). It does ONE conditional
//     decrement, findOneAndUpdate({ _id: counterKey, count: copyNo }, { $inc: { count: -1 } }): if nobody reserved after
//     it, the number is given back. Otherwise the gap stays and a document.print_cancelled audit entry explains it. There is
//     no cascade over older released rows. Example (accepted over-count): reserve A (1), reserve B (2), release A (gap),
//     release B (back to 1): the next print is copy 2 although nothing was printed.
//   * A reservation that is never confirmed nor released (the app crashed mid-print) stays counted too: a gap that stays is
//     an over-count (the next print may be marked as a copy), which is the safe side. A unique partial index on
//     (key, copyNo) for status reserved / printed is a safety net: two live reservations can never hold the same number.
// The document type is the number's prefix; the caller needs the permission of that document's screen and the document must
// exist (404 DOCUMENT_NOT_FOUND), so nobody can fill the counters with invented numbers.
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
const PAPER_CLASSES = new Set(["receipt", "page"]);
const counterId = (number, paperClass) => `${number}|${paperClass}`;
const httpError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code };
  return error;
};
const actorId = (req) => (req.authEnabled && req.user ? String(req.user._id) : null);
const sameActor = (req, reservation) => (reservation.userId ? String(reservation.userId) : null) === actorId(req);

/** Validates the request, checks the permission, then that the document exists. */
async function resolveDocument(req, res, source) {
  const number = typeof source?.number === "string" ? source.number.trim().toUpperCase() : "";
  const match = NUMBER_PATTERN.exec(number);
  const permissions = match ? PREFIX_PERMISSIONS[match[1]] : null;
  if (!permissions || (source.prefix !== undefined && String(source.prefix).toUpperCase() !== match[1])) {
    res.status(400);
    throw new Error("رقم المستند غير صحيح");
  }
  if (!PAPER_CLASSES.has(source.paperClass)) {
    res.status(400);
    throw new Error("نوع الورق غير صحيح");
  }
  if (req.authEnabled && !permissions.some((key) => hasPermission(req.user, key))) throw forbidden();
  if (!(await PREFIX_MODELS[match[1]].exists({ number }))) throw httpError(404, "DOCUMENT_NOT_FOUND", "المستند غير موجود");
  return { number, prefix: match[1], paperClass: source.paperClass };
}

const loadReservation = async (req) => {
  const id = req.body?.reservationId;
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) throw httpError(400, "INVALID_RESERVATION", "رقم الحجز غير صحيح");
  const reservation = await PrintReservation.findById(id).lean();
  if (!reservation) throw httpError(404, "RESERVATION_NOT_FOUND", "الحجز غير موجود");
  if (!sameActor(req, reservation)) throw forbidden();
  return reservation;
};

const reservePrint = async (req, res) => {
  const { number, paperClass } = await resolveDocument(req, res, req.body);
  const key = counterId(number, paperClass);
  const counter = await PrintCount.findOneAndUpdate(
    { _id: key },
    { $inc: { count: 1 }, $setOnInsert: { number, paperClass } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const copyNo = counter.count;
  const reservation = await PrintReservation.create({ key, number, paperClass, copyNo, userId: actorId(req), deviceId: req.deviceId || null, status: "reserved" });
  res.status(201).json({ reservationId: String(reservation._id), number, paperClass, copyNo });
};

const confirmPrint = async (req, res) => {
  const reservation = await loadReservation(req);
  if (reservation.status === "released") throw httpError(409, "RESERVATION_RELEASED", "تم إلغاء هذا الحجز");
  const won = await PrintReservation.findOneAndUpdate({ _id: reservation._id, status: "reserved" }, { $set: { status: "printed", resolvedAt: new Date() } }, { new: true });
  if (won) {
    const [prefix] = reservation.number.split("-");
    await audit(req, { action: "document.printed", entity: "document", entityId: reservation.number, details: { number: reservation.number, type: prefix, paperClass: reservation.paperClass, copy: reservation.copyNo, reservationId: String(reservation._id) } });
  }
  // already printed (a retry): the same answer, no second audit entry
  res.json({ number: reservation.number, paperClass: reservation.paperClass, copyNo: reservation.copyNo, printedAt: new Date().toISOString(), alreadyConfirmed: !won });
};

const releasePrint = async (req, res) => {
  const reservation = await loadReservation(req);
  if (reservation.status === "printed") throw httpError(409, "RESERVATION_PRINTED", "تمت الطباعة بالفعل، لا يمكن إلغاء الحجز");
  if (reservation.status === "released") return res.json({ number: reservation.number, copyNo: reservation.copyNo, status: "released", gaveBack: Boolean(reservation.gaveBack), alreadyReleased: true });
  const flipped = await PrintReservation.findOneAndUpdate({ _id: reservation._id, status: "reserved" }, { $set: { status: "released", resolvedAt: new Date() } }, { new: true });
  if (!flipped) throw httpError(409, "RESERVATION_PRINTED", "تمت الطباعة بالفعل، لا يمكن إلغاء الحجز");
  // Give the number back only if nobody reserved after it: ONE conditional decrement, nothing more. If it does not match
  // the gap stays (an over-count, safe) and the print_cancelled audit entry below explains it. Older released rows are
  // never stepped over: their numbers may have been issued again since.
  const updated = await PrintCount.findOneAndUpdate({ _id: reservation.key, count: reservation.copyNo }, { $inc: { count: -1 } }, { new: true });
  const gaveBack = Boolean(updated);
  if (gaveBack) {
    await PrintReservation.updateOne({ _id: reservation._id }, { $set: { gaveBack: true } });
  } else {
    const [prefix] = reservation.number.split("-");
    await audit(req, { action: "document.print_cancelled", entity: "document", entityId: reservation.number, details: { number: reservation.number, type: prefix, paperClass: reservation.paperClass, copy: reservation.copyNo, reservationId: String(reservation._id) } });
  }
  res.json({ number: reservation.number, copyNo: reservation.copyNo, status: "released", gaveBack });
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

module.exports = { PREFIX_MODELS, PREFIX_PERMISSIONS, confirmPrint, getJournalRef, releasePrint, reservePrint };
