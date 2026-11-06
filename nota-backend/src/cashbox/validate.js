const { httpError } = require("./boxes");
const { roundMoney } = require("../utils/invoicePricing");

// Stage 19: request validation shared by the cash-box, shift, expense, drawing and payout endpoints.

/** A positive amount with at most 2 decimals. */
const positiveAmount = (value, label = "المبلغ") => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) throw httpError(400, "INVALID_AMOUNT", `${label} يجب أن يكون رقمًا أكبر من صفر`);
  if (Math.abs(roundMoney(number) - number) > 1e-9) throw httpError(400, "INVALID_AMOUNT", `${label} لا يزيد عن خانتين عشريتين`);
  return roundMoney(number);
};

/** A non-negative amount with at most 2 decimals. */
const nonNegativeAmount = (value, label = "المبلغ") => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw httpError(400, "INVALID_AMOUNT", `${label} يجب أن يكون رقمًا صفرًا أو أكبر`);
  if (Math.abs(roundMoney(number) - number) > 1e-9) throw httpError(400, "INVALID_AMOUNT", `${label} لا يزيد عن خانتين عشريتين`);
  return roundMoney(number);
};

/** A date (YYYY-MM-DD or ISO). Missing: now. */
const optionalDate = (value, label = "التاريخ") => {
  if (value === undefined || value === null || value === "") return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, "INVALID_DATE", `${label} غير صالح`);
  return date;
};

const optionalText = (value, max, label = "الملاحظة") => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw httpError(400, "INVALID_TEXT", `${label} غير صالحة`);
  const text = value.trim();
  if (text.length > max) throw httpError(400, "INVALID_TEXT", `${label} لا تزيد عن ${max} حرف`);
  return text || undefined;
};

/** The reason of a cancellation: 3 to 500 characters. */
const requiredReason = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 3 || text.length > 500) throw httpError(400, "REASON_REQUIRED", "سبب الإلغاء مطلوب ويجب أن يكون بين 3 و500 حرف");
  return text;
};

const requiredName = (value, label = "الاسم") => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 120) throw httpError(400, "INVALID_NAME", `${label} مطلوب ولا يزيد عن 120 حرف`);
  return text;
};

module.exports = { positiveAmount, nonNegativeAmount, optionalDate, optionalText, requiredReason, requiredName };
