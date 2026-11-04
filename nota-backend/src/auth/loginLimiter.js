// Stage 13: login (and recover) lockout. After MAX_FAILURES failed attempts for one username from
// one IP address, that (username, IP) pair is locked for LOCK_MS. Another PC (another IP) can still
// sign in as that user, so nobody on the LAN can lock the owner out of every PC by guessing.
// Kept in memory: the backend runs on one main PC, so one process sees every attempt; a restart of
// the app clears the counters (documented in OFFLINE_PLAN.md).
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

const usernameKey = (username) => String(username || "").trim().toLowerCase();
const pairKey = (username, ip) => `${usernameKey(username)}\u0000${String(ip || "")}`;

function createLoginLimiter({ now = () => Date.now(), maxFailures = MAX_FAILURES, lockMs = LOCK_MS } = {}) {
  const entries = new Map(); // "username\0ip" → { failures, lockedUntil }

  return {
    /** Milliseconds left on the lock of this (username, IP), or 0 when it may try. */
    lockedFor(username, ip) {
      const key = pairKey(username, ip);
      const entry = entries.get(key);
      if (!entry || !entry.lockedUntil) return 0;
      const left = entry.lockedUntil - now();
      if (left > 0) return left;
      entries.delete(key); // lock expired: start over
      return 0;
    },
    /** Counts a failure for (username, IP). Returns true when this failure locked it. */
    fail(username, ip) {
      const key = pairKey(username, ip);
      const entry = entries.get(key) || { failures: 0, lockedUntil: 0 };
      entry.failures += 1;
      let locked = false;
      if (entry.failures >= maxFailures) {
        entry.lockedUntil = now() + lockMs;
        locked = true;
      }
      entries.set(key, entry);
      return locked;
    },
    /** A success clears the counter of this (username, IP). */
    succeed(username, ip) {
      entries.delete(pairKey(username, ip));
    },
    /** Clears every counter of a username, from any IP (after a successful recovery). */
    clearUsername(username) {
      const prefix = `${usernameKey(username)}\u0000`;
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    },
    reset() {
      entries.clear();
    },
  };
}

module.exports = { LOCK_MS, MAX_FAILURES, createLoginLimiter };
