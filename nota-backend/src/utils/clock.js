// One place for "now" in business-date comparisons, so a test can run with a fake clock.
let override = null;

const now = () => (override ? override() : new Date());

/** Tests only: pass a function returning a Date (or null to go back to the real clock). */
const setClock = (fn) => { override = fn; };

/**
 * The default cut-off for "as of now": the end of the current LOCAL day (the server's timezone, Africa/Cairo on a shop PC).
 * Business dates are stored as the UTC midnight of the day the user picked, so a plain `new Date()` cut-off would
 * hide a sale dated today for the first hours of the local day (00:00-02:00 in Cairo). A date-only asOf is the same value.
 */
const endOfLocalDay = (date = now()) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

/** The LOCAL calendar day of an instant, as the UTC midnight of that day (the way business dates are stored). */
const localDayAsUtc = (date = now()) => new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

/**
 * The business day of a stored date: a date-only value is already the UTC midnight of its day and stays as it is; a real
 * instant (a cancel at 00:30 local is still the previous day in UTC) becomes the UTC midnight of its LOCAL day.
 */
const businessDay = (value) => {
  const date = new Date(value);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0 ? date : localDayAsUtc(date);
};

/** The LOCAL calendar day of an instant as YYYY-MM-DD (the shop's day: Africa/Cairo on its server). toISOString() would give the UTC day, which is yesterday between 00:00 and 02:00 in Cairo. */
const localDayString = (date = now()) => localDayAsUtc(date).toISOString().slice(0, 10);

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * A list filter boundary. A date-only value ("2026-11-16") is a LOCAL business day: its first (or, with endOfDay, last) instant, so a
 * document stamped at an instant (a web order at 00:30 Cairo is 22:30 UTC of the day before) falls in the day the shop calls it, and a
 * business date stored as the UTC midnight of its day (02:00/03:00 local) falls in it too. Anything else is parsed as given.
 * Returns an Invalid Date for an invalid value (the caller checks).
 */
const filterBoundary = (value, endOfDay = false) => {
  const text = String(value).trim();
  const match = DATE_ONLY.exec(text);
  if (!match) return new Date(text);
  const year = Number(match[1]); const month = Number(match[2]) - 1; const day = Number(match[3]);
  const date = endOfDay ? new Date(year, month, day, 23, 59, 59, 999) : new Date(year, month, day, 0, 0, 0, 0);
  return date.getMonth() === month && date.getDate() === day ? date : new Date(NaN);
};

module.exports = { now, setClock, endOfLocalDay, localDayAsUtc, localDayString, filterBoundary, businessDay };
