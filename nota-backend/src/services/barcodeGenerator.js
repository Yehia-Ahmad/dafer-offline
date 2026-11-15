// Stage 26: in-store EAN-13 barcodes: "2" + 11 digits from an atomic counter + the check digit.
// Prefix 2 is the GS1 range reserved for in-store use, so a generated number never collides with a
// factory barcode. A number already held by ANY product (archived ones too, so a later unarchive cannot
// clash) is skipped and the next one is taken.

const Counter = require("../models/counter.model");
const Product = require("../models/product.model");
const { ean13CheckDigit } = require("../utils/barcode");

const COUNTER_ID = "barcode_ean13";
const MAX_SEQ = 99999999999; // 11 digits

const ean13FromSeq = (seq) => {
  const body = `2${String(seq).padStart(11, "0")}`;
  return `${body}${ean13CheckDigit(body)}`;
};

/** Reserves `count` consecutive sequence numbers; returns the first one. */
async function reserveSeq(count, session) {
  const counter = await Counter.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: count } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  const first = counter.seq - count + 1;
  if (counter.seq > MAX_SEQ) {
    const error = new Error("خلصت أرقام الباركود الداخلية");
    error.statusCode = 409;
    error.responseData = { code: "BARCODE_RANGE_EXHAUSTED" };
    throw error;
  }
  return first;
}

/**
 * `count` new in-store EAN-13 barcodes that no product holds. Reserves numbers in one $inc, then
 * reserves more if some of them are taken. `exclude` = codes already handed out in this request.
 */
async function generateBarcodes(count, { session, exclude = new Set() } = {}) {
  const result = [];
  let guard = 0;
  while (result.length < count) {
    guard += 1;
    if (guard > 50) throw new Error("تعذر توليد باركود جديد");
    const need = count - result.length;
    const first = await reserveSeq(need, session);
    const candidates = Array.from({ length: need }, (_, index) => ean13FromSeq(first + index));
    const taken = await Product.find({ barcodes: { $in: candidates } }).select("barcodes").session(session || null).lean();
    const takenSet = new Set(taken.flatMap((product) => product.barcodes || []));
    for (const code of candidates) {
      if (!takenSet.has(code) && !exclude.has(code)) result.push(code);
    }
  }
  return result;
}

module.exports = { COUNTER_ID, ean13FromSeq, generateBarcodes };
