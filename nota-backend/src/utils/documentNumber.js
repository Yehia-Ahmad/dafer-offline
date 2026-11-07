const Counter = require("../models/counter.model");

const PREFIXES = Object.freeze({
  CASH_INVOICE: "INV", CREDIT_INVOICE: "CR", RETURN: "RT", RECEIPT: "RC",
  PAYMENT_VOUCHER: "PV", PURCHASE_ORDER: "PO", JOURNAL: "JE", SHIFT: "SH",
  EXPENSE: "EX", OPENING_BALANCE: "OB",
  // Stage 19
  TRANSFER: "TR", OWNER_DRAWING: "DR", CUSTOMER_PAYOUT: "CP",
  // Stage 20 (PO and PV above): purchase return, supplier refund
  PURCHASE_RETURN: "PR", SUPPLIER_REFUND: "SR",
  // Stage 21: monthly VAT return, VAT payment
  VAT_RETURN: "VR", VAT_PAYMENT: "VP",
});

const formatDocumentNumber = (prefix, seq) => `${prefix}-${String(seq).padStart(6, "0")}`;

async function nextDocumentNumber(prefix, session) {
  const counter = await Counter.findOneAndUpdate(
    { _id: prefix },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return formatDocumentNumber(prefix, counter.seq);
}

const normalizeNumberSearch = (value, prefix) => {
  if (typeof value !== "string") return null;
  const match = new RegExp(`^${prefix}-(\\d+)$`, "i").exec(value.trim());
  return match ? formatDocumentNumber(prefix, Number(match[1])) : value.trim().toUpperCase();
};

module.exports = { PREFIXES, formatDocumentNumber, nextDocumentNumber, normalizeNumberSearch };
