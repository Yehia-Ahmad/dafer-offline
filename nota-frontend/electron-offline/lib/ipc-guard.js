'use strict';

// Stage 15: who may call the dangerous IPC handlers, checked in the main process.
//
// The Angular app only hides the backup page from users without backup.manage; that is not
// protection, because any page code (or DevTools) can call window.notaDesktop.backup.*. So every
// backup handler receives the caller's session token as its first argument, and the main process
// asks the local backend who that is (GET /api/auth/me over loopback, with the LAN key) before
// anything runs. The backend is the single source of truth for sessions and permissions.
//
// Results are structured errors the page can show: SESSION_EXPIRED (no, bad, expired or outdated
// token), FORBIDDEN (no permission), WRONG_PASSWORD / LOGIN_LOCKED (restore password check),
// SERVER_BUSY (the backend did not answer).

const { LAN_KEY_HEADER } = require('./lan-auth');

const SESSION = 'session'; // any signed-in user
const BACKUP_MANAGE = 'backup.manage';
const SHOP_MANAGE = 'shop.manage';

// channel → rule. Handlers not listed here are not guarded by a session (see OFFLINE_PLAN.md).
const IPC_RULES = Object.freeze({
  'backup:create': BACKUP_MANAGE,
  'backup:restore': BACKUP_MANAGE, // + the user's password again (verifyPassword)
  'backup:choose-copy-folder': BACKUP_MANAGE,
  'backup:clear-copy-folder': BACKUP_MANAGE,
  'backup:show-file': BACKUP_MANAGE,
  'backup:open-folder': BACKUP_MANAGE,
  'backup:status': SESSION,
  // Stage 23: printing. The print settings and test pages need shop.manage; the rest any signed-in user.
  'print:printers': SESSION,
  'print:settings-get': SESSION,
  'print:settings-set': SHOP_MANAGE,
  'print:test-page': SHOP_MANAGE,
  'print:print': SESSION,
  'print:pdf': SESSION,
});

const ME_TIMEOUT_MS = 5000;

class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sessionExpired = () => new GuardError('SESSION_EXPIRED', 'انتهت الجلسة. سجّل الدخول مرة أخرى.');
const forbidden = () => new GuardError('FORBIDDEN', 'ليست لديك صلاحية للقيام بهذه العملية.');
const serverBusy = () => new GuardError('SERVER_BUSY', 'الخادم غير جاهز الآن. حاول مرة أخرى بعد قليل.');

const validToken = (token) => typeof token === 'string' && token.length > 10 && token.length < 4096 && !/\s/.test(token);

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Talks to the local backend for the guard. apiOrigin: http://127.0.0.1:<port>; secret: LAN key.
 * fetchImpl is injectable for tests.
 */
function createBackendClient({ apiOrigin, secret, fetchImpl = fetch, timeoutMs = ME_TIMEOUT_MS }) {
  const headers = (token, json) => ({
    [LAN_KEY_HEADER]: secret,
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  return {
    /** { user, permissions } for this token; throws SESSION_EXPIRED or SERVER_BUSY. */
    async me(token) {
      let response;
      try {
        response = await fetchImpl(`${apiOrigin}/api/auth/me`, { headers: headers(token), signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw serverBusy();
      }
      if (response.status === 401) throw sessionExpired();
      if (!response.ok) throw serverBusy();
      const body = await readJson(response);
      if (!body || !body.user) throw serverBusy();
      return { user: body.user, permissions: Array.isArray(body.permissions) ? body.permissions : body.user.permissions || [] };
    },

    /** Resolves when the password is right; throws WRONG_PASSWORD, LOGIN_LOCKED, SESSION_EXPIRED or SERVER_BUSY. */
    async verifyPassword(token, password) {
      let response;
      try {
        response = await fetchImpl(`${apiOrigin}/api/auth/verify-password`, {
          method: 'POST',
          headers: headers(token, true),
          body: JSON.stringify({ password: typeof password === 'string' ? password : '' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw serverBusy();
      }
      if (response.status === 204) return;
      const body = await readJson(response);
      if (response.status === 401) throw sessionExpired();
      if (response.status === 400) throw new GuardError('WRONG_PASSWORD', (body && body.message) || 'كلمة المرور غير صحيحة');
      if (response.status === 429) {
        const error = new GuardError('LOGIN_LOCKED', (body && body.message) || 'محاولات كثيرة غير صحيحة. حاول مرة أخرى بعد قليل');
        error.detail = body && body.retryAfterSeconds ? String(body.retryAfterSeconds) : undefined;
        throw error;
      }
      throw serverBusy();
    },
  };
}

/**
 * Checks the caller of `channel` and returns { user, permissions }. Throws a GuardError (nothing
 * must run then). A channel without a rule is a programming error.
 */
async function checkCaller({ channel, token, backend }) {
  const rule = IPC_RULES[channel];
  if (!rule) throw new Error(`no IPC rule for ${channel}`);
  if (!validToken(token)) throw sessionExpired();
  const caller = await backend.me(token);
  if (rule !== SESSION && !caller.permissions.includes(rule)) throw forbidden();
  return caller;
}

module.exports = { BACKUP_MANAGE, GuardError, IPC_RULES, SESSION, checkCaller, createBackendClient };
