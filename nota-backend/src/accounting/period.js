// Stage 22: the period lock. meta.closing.lockedThrough is the last closed business day (a UTC-midnight date).
// Nothing may post with a business date on or before it: assertOpenDate is called by every posting path (early, in the
// controllers, for a clean 409 before any side effect) and by postEntry itself (the safety net no path can bypass; only the
// closing entry of a close/reopen and migrations pass allowLocked). Returns, cancels and payments on an old document stay allowed
// because their entries are dated by the request (today by default), so they land in the open period.
const Meta = require("../models/meta.model");
const { businessDay, localDayAsUtc, now } = require("../utils/clock");

const pad = (value) => String(value).padStart(2, "0");
/** dd/mm/yyyy of a business date (a UTC-midnight date). */
const formatDay = (date) => `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
/** yyyy-mm-dd of a business date. */
const isoDay = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const periodLockedError = (lockedThrough) => {
  const error = new Error(`الفترة دي مقفولة لحد ${formatDay(lockedThrough)}`);
  error.statusCode = 409;
  error.responseData = { code: "PERIOD_LOCKED", lockedThrough: isoDay(lockedThrough) };
  return error;
};

/** meta.closing.lockedThrough as a Date, or null when no period was ever closed (or the last close was reopened). */
const getLockedThrough = async (session = null) => {
  const meta = await Meta.findById("schema").select("closing").session(session).lean();
  return meta?.closing?.lockedThrough ? new Date(meta.closing.lockedThrough) : null;
};

/**
 * Throws 409 PERIOD_LOCKED when the business day of `date` is on or before lockedThrough.
 * With a session, a date before the current month also touches the meta document, so a close running at the same time conflicts
 * with this posting and one of the two retries (a month cannot be closed before it ends, so a posting dated in the current month
 * never needs it).
 */
const assertOpenDate = async (date, { session = null } = {}) => {
  if (date === undefined || date === null) return;
  const day = businessDay(date);
  const locked = await getLockedThrough(session);
  if (locked && day.getTime() <= locked.getTime()) throw periodLockedError(locked);
  if (session) {
    const today = localDayAsUtc(now());
    if (day.getTime() < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)) {
      await Meta.collection.updateOne({ _id: "schema" }, { $currentDate: { "closing.touchedAt": true } }, { session });
    }
  }
};

/** The first and last instant of a business day (a UTC-midnight date) in the server's LOCAL time, as the reports and ledgers cut periods. */
const localStartOf = (day) => new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, 0, 0);
const localEndOf = (day) => new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59, 999);

module.exports = { assertOpenDate, getLockedThrough, periodLockedError, formatDay, isoDay, localStartOf, localEndOf };
