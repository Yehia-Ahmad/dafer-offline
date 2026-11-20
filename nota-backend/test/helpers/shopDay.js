// "Today" for backend tests = the SHOP's local business day (Africa/Cairo on its server), the same rule the code uses (utils/clock localDayAsUtc).
// A test that builds today with new Date().toISOString().slice(0, 10) gets the UTC day, which is yesterday between 00:00 and 02:00 in Cairo
// (03:00 in summer), so it breaks depending on the hour it runs. Use these instead; they honour setClock() like the code under test does.
const clock = require("../../src/utils/clock");

/** Today's business day as YYYY-MM-DD. */
const today = () => clock.localDayString(clock.now());

/** The business day `offset` days from today (negative = in the past), YYYY-MM-DD. Calendar arithmetic, so it never skips a day around DST. */
const dayString = (offset = 0) => {
  const now = clock.now();
  return clock.localDayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12, 0, 0));
};

/** A local-time Date (month is 1-12), for pinning the clock: setClock(() => atLocal(2026, 11, 16, 0, 30)). */
const atLocal = (year, month, day, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute, 0, 0);

/** The day of a STORED business date (a Date at UTC midnight of its day, as documents and journal entries hold it) as YYYY-MM-DD. */
const storedDay = (date) => new Date(date).toISOString().slice(0, 10);

/** The business day a stored date OR an instant belongs to (a journal entry posted "now" holds the instant; a picked date holds the UTC midnight of its day). */
const businessDayOf = (date) => storedDay(clock.businessDay(date));

module.exports = { today, dayString, atLocal, storedDay, businessDayOf };
