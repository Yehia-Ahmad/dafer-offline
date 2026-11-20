// Online Stage 7B: money from Meta. Meta sends spend as a decimal string ("12.34"). It is parsed from the string into integer
// minor units (piastres/cents) with no float step. The rest of Nota keeps 2-decimal floats (roundMoney); `toMoney` is the one
// boundary where minor units become that float.
const { roundMoney } = require("../../utils/invoicePricing");

/** "12.345" -> 1235 (half up on the string). Returns null for anything that is not a plain non-negative decimal. */
const parseMinor = (value) => {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!/^\d{1,15}(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const padded = `${fraction}000`;
  let minor = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) minor += 1;
  return Number.isSafeInteger(minor) ? minor : null;
};

/** Plain non-negative integer counts (impressions, reach, clicks). Missing or bad = 0. */
const parseCount = (value) => {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return /^\d{1,15}$/.test(text) ? Number(text) : 0;
};

const toMoney = (minor) => roundMoney(Number(minor || 0) / 100);

/** The rate in force on `day`: the latest rate with effectiveFrom <= day. `rates` need not be sorted. */
const rateOn = (rates, day) => {
  let best = null;
  for (const rate of rates || []) {
    if (rate.effectiveFrom <= day && (!best || rate.effectiveFrom > best.effectiveFrom)) best = rate;
  }
  return best;
};

/** Minor units of the account currency -> minor units of EGP with `rate` (EGP per 1 unit). Integer math on a 6-decimal rate. */
const convertMinor = (minor, rate) => Math.round((Number(minor) * Math.round(Number(rate) * 1e6)) / 1e6);

module.exports = { parseMinor, parseCount, toMoney, rateOn, convertMinor };
