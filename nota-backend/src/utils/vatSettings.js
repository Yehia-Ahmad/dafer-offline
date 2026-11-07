// Stage 21: the shop's VAT settings (ShopProfile.vat) and their validation. The money rules live in utils/vat.js.
const { localDayAsUtc, now } = require("./clock");

const DEFAULT_VAT = Object.freeze({ enabled: false, rate: 14, pricesIncludeVat: true, startDate: null });

const vatError = (status, code, message, extra = {}) => {
  const error = new Error(message);
  error.statusCode = status;
  error.responseData = { code, ...extra };
  return error;
};

/**
 * PUT body `vat` -> the `$set` fields. Not sent -> {} (the stored settings are kept, like an older screen).
 * Turning VAT on needs the shop's tax number (400 TAX_NUMBER_REQUIRED) and (re)sets startDate to today's local business
 * day: documents dated before it are untouched. Turning it off keeps rate/mode (posted documents keep their own copy).
 */
const readVatUpdate = (input, current, taxNumber) => {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw vatError(400, "INVALID_VAT", "إعدادات الضريبة غير صالحة");
  const stored = { ...DEFAULT_VAT, ...(current || {}) };
  const next = { enabled: Boolean(stored.enabled), rate: stored.rate, pricesIncludeVat: stored.pricesIncludeVat !== false };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw vatError(400, "INVALID_VAT", "حالة الضريبة غير صالحة");
    next.enabled = input.enabled;
  }
  if (input.rate !== undefined) {
    const rate = Number(input.rate);
    if (input.rate === null || input.rate === "" || !Number.isFinite(rate) || rate < 0 || rate > 100 || Math.round(rate * 100) / 100 !== rate) {
      throw vatError(400, "INVALID_VAT_RATE", "نسبة الضريبة يجب أن تكون بين 0 و100 (حتى خانتين عشريتين)");
    }
    next.rate = rate;
  }
  if (input.pricesIncludeVat !== undefined) {
    if (typeof input.pricesIncludeVat !== "boolean") throw vatError(400, "INVALID_VAT", "طريقة التسعير غير صالحة");
    next.pricesIncludeVat = input.pricesIncludeVat;
  }
  if (next.enabled && !String(taxNumber || "").trim()) {
    throw vatError(400, "TAX_NUMBER_REQUIRED", "لازم تسجّل الرقم الضريبي للمحل قبل تفعيل الضريبة");
  }
  const $set = { "vat.enabled": next.enabled, "vat.rate": next.rate, "vat.pricesIncludeVat": next.pricesIncludeVat };
  if (next.enabled && !stored.enabled) $set["vat.startDate"] = localDayAsUtc(now());
  return $set;
};

module.exports = { DEFAULT_VAT, vatError, readVatUpdate };
