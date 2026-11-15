// Stage 26: the barcode uniqueness checks used by every product write path (create, update, restore,
// generate, Excel import). The unique partial index on Product is the real guard (it also settles two
// saves racing each other); the pre-check only gives the friendly message with the other product's name.

const Product = require("../models/product.model");

const takenError = (barcode, holder, { restoring = false } = {}) => {
  const name = holder?.name || "";
  const code = holder?.code || "";
  const where = name ? `المنتج «${name}»${code ? ` (كود ${code})` : ""}` : "منتج تاني";
  const message = restoring
    ? `مينفعش ترجّع المنتج: الباركود ${barcode} مستخدم دلوقتي في ${where}`
    : `الباركود ${barcode} مستخدم بالفعل في ${where}`;
  const error = new Error(message);
  error.statusCode = 409;
  error.responseData = {
    code: "BARCODE_TAKEN",
    barcode,
    product: holder ? { _id: holder._id, name, code } : null,
  };
  return error;
};

/** The non-archived product (other than `excludeId`) that holds one of `barcodes`, with the barcode it holds. */
async function findHolder(barcodes, { excludeId, session } = {}) {
  if (!Array.isArray(barcodes) || barcodes.length === 0) return null;
  const filter = { barcodes: { $in: barcodes }, isArchived: { $ne: true } };
  if (excludeId) filter._id = { $ne: excludeId };
  const holder = await Product.findOne(filter).select("name code barcodes").session(session || null).lean();
  if (!holder) return null;
  const barcode = barcodes.find((code) => (holder.barcodes || []).includes(code)) || barcodes[0];
  return { holder, barcode };
}

/** Throws 409 BARCODE_TAKEN when another non-archived product holds one of `barcodes`. */
async function assertBarcodesFree(barcodes, options = {}) {
  const found = await findHolder(barcodes, options);
  if (found) throw takenError(found.barcode, found.holder, options);
}

const isBarcodeDuplicateKey = (error) =>
  Number(error?.code) === 11000 &&
  (Boolean(error?.keyPattern?.barcodes) || /barcodes_unique_active/.test(String(error?.message || "")));

/**
 * Runs `fn` (usually a whole withTransaction). An E11000 on the barcode index (two saves racing, or a
 * write that skipped the pre-check) becomes 409 BARCODE_TAKEN naming the product that won.
 */
async function mapBarcodeConflict(fn, { barcodes, excludeId, restoring = false } = {}) {
  try {
    return await fn();
  } catch (error) {
    if (!isBarcodeDuplicateKey(error)) throw error;
    const duplicate = error?.keyValue?.barcodes;
    const candidates = duplicate ? [duplicate] : barcodes || [];
    const found = await findHolder(candidates, { excludeId });
    throw takenError(found?.barcode || duplicate || candidates[0] || "", found?.holder || null, { restoring });
  }
}

module.exports = { assertBarcodesFree, findHolder, isBarcodeDuplicateKey, mapBarcodeConflict, takenError };
