// Stage 21 review: a unit price (sale, purchase, product) has at most 2 decimals. A price like 10.005 would make the line
// total, the refund of one unit and the VAT disagree by a piaster, so it is refused up front with PRICE_PRECISION.
const hasMoneyPrecision = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return true; // other validators report a non-number
  return Number.isInteger(Number((number * 100).toFixed(6)));
};

const pricePrecisionError = (label = "السعر") => {
  const error = new Error(`${label} لا يزيد عن خانتين عشريتين`);
  error.statusCode = 400;
  error.responseData = { code: "PRICE_PRECISION" };
  return error;
};

/** Throws PRICE_PRECISION when `value` (a number or numeric string) has more than 2 decimals; undefined/null/"" pass. */
const assertPricePrecision = (value, label) => {
  if (value === undefined || value === null || value === "") return;
  if (!hasMoneyPrecision(value)) throw pricePrecisionError(label);
};

module.exports = { hasMoneyPrecision, pricePrecisionError, assertPricePrecision };
