// Stage 26: product barcodes. One place for the rules shared by the model, the controller, the
// generator and the Excel import:
//   * a barcode is trimmed, 4-48 characters of Code 128-safe ASCII: digits, Latin letters, - . / +
//   * all digits with 8, 12 or 13 digits → EAN-8 / UPC-A / EAN-13: the check digit must be right
//   * 0-5 per product, no repeats inside one product
// Arabic-Indic / Persian digits and invisible characters (RLM, LRM, zero-width ...) are cleaned before
// the rules run, so a code typed or scanned on an Arabic Windows keeps working.

const MAX_BARCODES = 5;
const MIN_LENGTH = 4;
const MAX_LENGTH = 48;
const ALLOWED = /^[0-9A-Za-z\-./+]+$/;
// RLM/LRM/ALM, zero-width space/joiners, bidi embeddings and isolates, BOM, soft hyphen.
const INVISIBLE = /[​-‏‪-‮⁦-⁩؜﻿­]/g;

const toAsciiDigits = (value) =>
  value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));

/** Trimmed, invisible characters removed, Arabic-Indic/Persian digits → ASCII. Not a string → "". */
const normalizeBarcode = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return toAsciiDigits(String(value).replace(INVISIBLE, "")).trim();
};

/** The GS1 mod-10 check digit of `body` (all digits, the check digit not included). */
const gs1CheckDigit = (body) => {
  let sum = 0;
  const digits = String(body);
  for (let index = 0; index < digits.length; index += 1) {
    // Weights 3,1,3,1... from the rightmost digit of the body.
    const weight = (digits.length - index) % 2 === 1 ? 3 : 1;
    sum += Number(digits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10;
};

const ean13CheckDigit = (twelveDigits) => gs1CheckDigit(twelveDigits);

const NUMERIC_TYPES = { 8: "EAN-8", 12: "UPC-A", 13: "EAN-13" };

/** "EAN-13" | "EAN-8" | "UPC-A" (a valid one of those) | "Code 128". */
const barcodeType = (code) => {
  const value = String(code || "");
  const numericType = /^\d+$/.test(value) ? NUMERIC_TYPES[value.length] : undefined;
  if (numericType && gs1CheckDigit(value.slice(0, -1)) === Number(value.slice(-1))) return numericType;
  return "Code 128";
};

/** null when valid, else an Arabic reason. `code` must already be normalized. */
const barcodeProblem = (code) => {
  if (typeof code !== "string" || !code) return "الباركود فاضي";
  if (code.length < MIN_LENGTH || code.length > MAX_LENGTH) return `الباركود لازم يكون من ${MIN_LENGTH} لـ ${MAX_LENGTH} حرف`;
  if (!ALLOWED.test(code)) return "الباركود يقبل أرقام وحروف إنجليزي و - . / + بس";
  const numericType = /^\d+$/.test(code) ? NUMERIC_TYPES[code.length] : undefined;
  if (numericType && gs1CheckDigit(code.slice(0, -1)) !== Number(code.slice(-1))) {
    return `رقم التحقق (آخر رقم) في باركود ${numericType} غلط`;
  }
  return null;
};

const invalidBarcodeError = (barcode, reason) => {
  const error = new Error(`باركود غير صالح «${barcode}»: ${reason}`);
  error.statusCode = 400;
  error.responseData = { code: "INVALID_BARCODE", barcode, reason };
  return error;
};

/**
 * The request's `barcodes` as a clean list, or throws 400 INVALID_BARCODE.
 * undefined → undefined (not sent: keep the stored list); null → [].
 */
const parseBarcodeList = (input) => {
  if (input === undefined) return undefined;
  if (input === null) return [];
  if (!Array.isArray(input)) throw invalidBarcodeError("", "لازم تكون قائمة");
  if (input.length > MAX_BARCODES) throw invalidBarcodeError("", `أقصى عدد ${MAX_BARCODES} باركود للمنتج`);
  const seen = new Set();
  const list = [];
  for (const raw of input) {
    const code = normalizeBarcode(raw);
    const problem = barcodeProblem(code);
    if (problem) throw invalidBarcodeError(code || String(raw ?? ""), problem);
    if (seen.has(code)) throw invalidBarcodeError(code, "الباركود متكرر في نفس المنتج");
    seen.add(code);
    list.push(code);
  }
  return list;
};

/** Mongoose validator for the whole array (the controller already checked; this guards direct saves). */
const validateBarcodeArray = (list) => {
  if (list === undefined || list === null) return true;
  if (!Array.isArray(list) || list.length > MAX_BARCODES) return false;
  if (new Set(list).size !== list.length) return false;
  return list.every((code) => barcodeProblem(code) === null);
};

const sameList = (left, right) => {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

module.exports = {
  MAX_BARCODES,
  MIN_LENGTH,
  MAX_LENGTH,
  barcodeProblem,
  barcodeType,
  ean13CheckDigit,
  gs1CheckDigit,
  invalidBarcodeError,
  normalizeBarcode,
  parseBarcodeList,
  sameBarcodeList: sameList,
  validateBarcodeArray,
};
