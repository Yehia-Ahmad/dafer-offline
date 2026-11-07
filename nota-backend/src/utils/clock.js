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

module.exports = { now, setClock, endOfLocalDay, localDayAsUtc, businessDay };
