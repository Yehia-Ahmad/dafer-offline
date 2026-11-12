'use strict';

// Stage 15 (Electron main process): backup IPC handlers check the caller with the backend
// (a stub /api/auth/me + /api/auth/verify-password over real HTTP), the restore password is checked
// before anything is paused, the audit inbox, one main PC per shop (discovery filter, watcher,
// setup warning) and the backend environment after a restore.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BACKUP_MANAGE, IPC_RULES, SESSION, checkCaller, createBackendClient } = require('../lib/ipc-guard');
const { NOT_SERVER_COPY, createBackupHandlers } = require('../lib/backup-handlers');
const { appendAuditEntry } = require('../lib/audit-inbox');
const { otherMainPcs } = require('../lib/discovery');
const { MainPcWatcher } = require('../lib/main-pc-watcher');
const { SetupController } = require('../lib/setup-controller');
const { buildBackendEnv } = require('../lib/backend-manager');
const { readConfig, writeConfig } = require('../lib/config-store');
const { mainPcWarning } = require('../pages/setup-main-check');
const { LAN_KEY_HEADER } = require('../lib/lan-auth');

const silentLog = { info() {}, warn() {}, error() {} };
const LAN_SECRET = 'LAN-SECRET-1234';

// ---- a stub backend: tokens → users -----------------------------------------------------------

const TOKENS = {
  'owner-token-0123456789': { user: { _id: 'u1', name: 'صاحب المحل', role: 'owner' }, permissions: ['backup.manage', 'shop.manage'], password: 'owner-pass' },
  'cashier-token-0123456789': { user: { _id: 'u2', name: 'كاشير', role: 'cashier' }, permissions: ['sales.create'], password: 'cash-pass' },
};
const EXPIRED = 'expired-token-0123456789';

let server;
let apiOrigin;
const seen = { lanKeys: [], verify: 0, lockedAfter: 5 };
const failures = new Map();

test.before(async () => {
  server = http.createServer((req, res) => {
    seen.lanKeys.push(req.headers[LAN_KEY_HEADER.toLowerCase()]);
    const token = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
    const session = TOKENS[token];
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers[LAN_KEY_HEADER.toLowerCase()] !== LAN_SECRET) return send(401, { code: 'LAN_KEY' });
    if (!session) return send(401, { code: 'SESSION_EXPIRED' });
    if (req.method === 'GET' && req.url === '/api/auth/me') return send(200, { user: session.user, permissions: session.permissions });
    if (req.method === 'POST' && req.url === '/api/auth/verify-password') {
      seen.verify += 1;
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const { password } = JSON.parse(raw || '{}');
        const count = failures.get(token) || 0;
        if (count >= seen.lockedAfter) return send(429, { code: 'LOGIN_LOCKED', message: 'محاولات كثيرة', retryAfterSeconds: 300 });
        if (password === session.password) {
          failures.delete(token);
          res.writeHead(204);
          return res.end();
        }
        failures.set(token, count + 1);
        return send(count + 1 >= seen.lockedAfter ? 429 : 400, count + 1 >= seen.lockedAfter ? { code: 'LOGIN_LOCKED', message: 'محاولات كثيرة' } : { code: 'WRONG_PASSWORD', message: 'كلمة المرور غير صحيحة' });
      });
      return undefined;
    }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiOrigin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));
test.beforeEach(() => failures.clear());

const backendClient = () => createBackendClient({ apiOrigin, secret: LAN_SECRET });

// Fakes that record what ran.
function makeDeps(overrides = {}) {
  const calls = [];
  const record = (name, value) => (...args) => {
    calls.push(name);
    return typeof value === 'function' ? value(...args) : value;
  };
  const deps = {
    isServerCopy: () => true,
    serverRunning: () => true,
    isBusy: () => false,
    busyError: () => Object.assign(new Error('busy'), { code: 'BACKUP_BUSY' }),
    backend: backendClient,
    chooseSavePath: record('chooseSavePath', '/backups/nota-backup-x.archive.gz'),
    chooseOpenPath: record('chooseOpenPath', '/backups/nota-backup-old.archive.gz'),
    chooseFolder: record('chooseFolder', '/media/usb/nota'),
    confirmRestore: record('confirmRestore', true),
    defaultBackupPath: () => '/docs/nota-backup.archive.gz',
    createBackup: record('createBackup', async () => ({ path: '/backups/nota-backup-x.archive.gz', sizeMb: 1, collections: 3, documents: 9 })),
    recordManual: record('recordManual', async () => true),
    inspect: record('inspect', async (file) => ({ path: file, name: path.basename(file), collections: 3 })),
    restoreArchive: record('restoreArchive', async () => ({ restored: 9, collections: 3, safetyPath: '/backups/before.archive.gz' })),
    copyFolderInvalid: () => false,
    setCopyFolder: record('setCopyFolder'),
    copyNow: record('copyNow', async () => {}),
    summary: record('summary', { lastAuto: null }),
    showItemInFolder: record('showItemInFolder'),
    openBackupsFolder: record('openBackupsFolder', async () => ''),
    onProgress: () => {},
    onRestored: record('onRestored'),
    log: silentLog,
    ...overrides,
  };
  return { deps, calls };
}

const ARGS = {
  'backup:create': [],
  'backup:restore': ['owner-pass'],
  'backup:status': [],
  'backup:choose-copy-folder': [],
  'backup:clear-copy-folder': [],
  'backup:show-file': [__filename],
  'backup:open-folder': [],
};

// ---- the rule table ---------------------------------------------------------------------------

// Stage 23 added the print channels to the same table (tested in stage23.test.js): this file is about the backup handlers.
const BACKUP_RULES = Object.fromEntries(Object.entries(IPC_RULES).filter(([channel]) => channel.startsWith('backup:')));

test('IPC rule table: every backup handler is guarded; only status needs just a session', () => {
  assert.deepEqual(BACKUP_RULES, {
    'backup:create': BACKUP_MANAGE,
    'backup:restore': BACKUP_MANAGE,
    'backup:choose-copy-folder': BACKUP_MANAGE,
    'backup:clear-copy-folder': BACKUP_MANAGE,
    'backup:show-file': BACKUP_MANAGE,
    'backup:open-folder': BACKUP_MANAGE,
    'backup:status': SESSION,
  });
  const { deps } = makeDeps();
  assert.deepEqual(Object.keys(createBackupHandlers(deps)).sort(), Object.keys(BACKUP_RULES).sort());
});

// ---- each handler × no token / expired token / no backup.manage / owner -----------------------

for (const channel of Object.keys(BACKUP_RULES)) {
  test(`${channel}: no token, expired token, cashier token, owner token`, async () => {
    for (const [label, token, expected] of [
      ['no token', undefined, 'SESSION_EXPIRED'],
      ['not a string', { forged: true }, 'SESSION_EXPIRED'],
      ['expired', EXPIRED, 'SESSION_EXPIRED'],
      ['cashier (no backup.manage)', 'cashier-token-0123456789', IPC_RULES[channel] === SESSION ? 'OK' : 'FORBIDDEN'],
      ['owner', 'owner-token-0123456789', 'OK'],
    ]) {
      const { deps, calls } = makeDeps();
      const handlers = createBackupHandlers(deps);
      const result = await handlers[channel](token, ...ARGS[channel]);
      if (expected === 'OK') {
        assert.equal(result.ok, true, `${channel} ${label}: ${JSON.stringify(result)}`);
      } else {
        assert.equal(result.ok, false, `${channel} ${label}`);
        assert.equal(result.error.code, expected, `${channel} ${label}`);
        assert.deepEqual(calls, [], `${channel} ${label}: nothing ran`);
      }
    }
  });
}

test('handlers refuse on a copy that does not run the server, before asking the backend', async () => {
  const { deps, calls } = makeDeps({ isServerCopy: () => false, backend: () => assert.fail('backend asked') });
  const result = await createBackupHandlers(deps)['backup:create']('owner-token-0123456789');
  assert.equal(result.ok, false);
  assert.equal(result.error.message, NOT_SERVER_COPY);
  assert.deepEqual(calls, []);
});

test('the guard sends the LAN key and the bearer token; an unreachable backend is SERVER_BUSY', async () => {
  seen.lanKeys.length = 0;
  const caller = await checkCaller({ channel: 'backup:create', token: 'owner-token-0123456789', backend: backendClient() });
  assert.equal(caller.user.name, 'صاحب المحل');
  assert.deepEqual(seen.lanKeys, [LAN_SECRET]);

  const down = createBackendClient({ apiOrigin: 'http://127.0.0.1:1', secret: LAN_SECRET, timeoutMs: 500 });
  await assert.rejects(checkCaller({ channel: 'backup:create', token: 'owner-token-0123456789', backend: down }), { code: 'SERVER_BUSY' });
  await assert.rejects(checkCaller({ channel: 'nota:quit', token: 'owner-token-0123456789', backend: backendClient() }), /no IPC rule/);
});

// ---- restore -----------------------------------------------------------------------------------

test('restore: a wrong password stops before the file dialog, the pause and the restore', async () => {
  const { deps, calls } = makeDeps();
  const handlers = createBackupHandlers(deps);
  const result = await handlers['backup:restore']('owner-token-0123456789', 'wrong-pass');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WRONG_PASSWORD');
  assert.deepEqual(calls, [], 'no dialog, no inspect, no restore (so the server was never paused)');

  const empty = await handlers['backup:restore']('owner-token-0123456789');
  assert.equal(empty.error.code, 'WRONG_PASSWORD', 'no password at all');
});

test('restore: 5 wrong passwords → LOGIN_LOCKED; then even the right one is refused', async () => {
  const { deps, calls } = makeDeps();
  const handlers = createBackupHandlers(deps);
  let result;
  for (let i = 0; i < 5; i++) result = await handlers['backup:restore']('owner-token-0123456789', 'nope');
  assert.equal(result.error.code, 'LOGIN_LOCKED');
  result = await handlers['backup:restore']('owner-token-0123456789', 'owner-pass');
  assert.equal(result.error.code, 'LOGIN_LOCKED');
  assert.deepEqual(calls, []);
});

test('restore: the right password → dialog, inspect, confirm, restore, then every window is sent to sign in', async () => {
  const { deps, calls } = makeDeps();
  const result = await createBackupHandlers(deps)['backup:restore']('owner-token-0123456789', 'owner-pass');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls, ['chooseOpenPath', 'inspect', 'confirmRestore', 'restoreArchive', 'onRestored']);
});

test('restore: a cancelled dialog or confirmation restores nothing', async () => {
  let { deps, calls } = makeDeps({ chooseOpenPath: async () => null });
  let result = await createBackupHandlers(deps)['backup:restore']('owner-token-0123456789', 'owner-pass');
  assert.deepEqual(result, { ok: true, value: null });
  ({ deps, calls } = makeDeps({ confirmRestore: async () => false }));
  result = await createBackupHandlers(deps)['backup:restore']('owner-token-0123456789', 'owner-pass');
  assert.deepEqual(result, { ok: true, value: null });
  assert.ok(!calls.includes('restoreArchive'));
});

test('show-file only opens an existing .archive.gz file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-show-'));
  const backup = path.join(dir, 'nota-backup-x.archive.gz');
  fs.writeFileSync(backup, 'x');
  const { deps, calls } = makeDeps();
  const handlers = createBackupHandlers(deps);
  await handlers['backup:show-file']('owner-token-0123456789', path.join(dir, 'secret.txt'));
  await handlers['backup:show-file']('owner-token-0123456789', 'relative.archive.gz');
  assert.deepEqual(calls, []);
  await handlers['backup:show-file']('owner-token-0123456789', backup);
  assert.deepEqual(calls, ['showItemInFolder']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- audit inbox ---------------------------------------------------------------------------------

test('audit inbox: one JSON line per action, with the base name only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-inbox-'));
  const file = path.join(dir, 'run', 'audit-inbox.jsonl');
  const user = { _id: 'u1', name: 'صاحب المحل' };
  appendAuditEntry(file, { action: 'backup.created', user, backupFile: 'C:\\Users\\me\\Documents\\nota-backup-1.archive.gz', now: new Date('2026-11-05T10:00:00Z') });
  appendAuditEntry(file, { action: 'backup.restore_failed', user, backupFile: '/x/y/bad.archive.gz', code: 'RESTORE_FAILED', error: 'boom' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { action: 'backup.created', at: '2026-11-05T10:00:00.000Z', userId: 'u1', userName: 'صاحب المحل', file: process.platform === 'win32' ? 'nota-backup-1.archive.gz' : path.basename('C:\\Users\\me\\Documents\\nota-backup-1.archive.gz') });
  assert.equal(lines[1].file, 'bad.archive.gz');
  assert.equal(lines[1].code, 'RESTORE_FAILED');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- after a restore: the backend's environment ----------------------------------------------

test('backend env: the restore cut-off and the audit inbox are passed; the config keeps the cut-off', () => {
  const env = buildBackendEnv({
    port: 5055,
    mongoUri: 'mongodb://127.0.0.1:27217/nota',
    secret: 'S',
    appVersion: '1.0.0',
    instanceId: 'id',
    sessionsValidAfter: 1762336800000,
    auditInbox: 'H/run/audit-inbox.jsonl',
    sourceEnv: {},
  });
  assert.equal(env.NOTA_SESSIONS_VALID_AFTER, '1762336800000');
  assert.equal(env.NOTA_AUDIT_INBOX, 'H/run/audit-inbox.jsonl');
  const without = buildBackendEnv({ port: 5055, mongoUri: 'm', secret: 'S', appVersion: '1', instanceId: 'id', sourceEnv: {} });
  assert.equal(without.NOTA_SESSIONS_VALID_AFTER, undefined);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-config-'));
  const file = path.join(dir, 'config.json');
  writeConfig(file, { schemaVersion: 1, role: 'main', instanceId: 'id', lanSecretProtected: 'x', sessionsValidAfter: 1762336800000 });
  assert.equal(readConfig(file).sessionsValidAfter, 1762336800000);
  writeConfig(file, { schemaVersion: 1, role: 'main', instanceId: 'id', lanSecretProtected: 'x', sessionsValidAfter: 'soon' });
  assert.equal(readConfig(file).sessionsValidAfter, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- one main PC -------------------------------------------------------------------------------

const OWN = { instanceId: 'own-id', shopName: 'المحل', port: 5055, appVersion: '1', address: '127.0.0.1' };
const OTHER = { instanceId: 'other-id', shopName: 'محل تاني', port: 5055, appVersion: '1', address: '192.168.1.20' };

test("discovery: this PC's own answer (loopback or LAN) is not another main PC", () => {
  assert.deepEqual(otherMainPcs([OWN, { ...OWN, address: '192.168.1.10' }], { ownInstanceId: 'own-id' }), []);
  assert.deepEqual(otherMainPcs([OWN, OTHER], { ownInstanceId: 'own-id' }), [OTHER]);
  assert.deepEqual(otherMainPcs([OTHER], {}), [OTHER], 'during first setup there is no own id');
  assert.deepEqual(otherMainPcs([{ ...OTHER, instanceId: '' }], {}), []);
});

test('setup: findOtherMainPcs filters the own id; no other main PC → no warning', async () => {
  const controller = new SetupController({ paths: {}, resources: {}, log: silentLog, appVersion: '1' });
  assert.deepEqual(await controller.findOtherMainPcs('own-id', async () => [OWN]), []);
  assert.equal(mainPcWarning([]), null);
  assert.deepEqual(await controller.findOtherMainPcs(null, async () => [OTHER]), [OTHER]);
});

test('setup: another main PC → the warning names it and pre-fills the client form ("use as client")', () => {
  const warning = mainPcWarning([OTHER]);
  assert.match(warning.message, /فيه جهاز رئيسي تاني شغال على الشبكة \(محل تاني \/ 192\.168\.1\.20:5055\)/);
  assert.match(warning.message, /لازم يكون فيه جهاز رئيسي واحد بس في المحل، وإلا البيانات هتتقسم على جهازين\./);
  assert.deepEqual(warning.prefill, { host: '192.168.1.20', port: 5055, shopName: 'محل تاني' });
  const two = mainPcWarning([OTHER, { ...OTHER, instanceId: 'x', address: '192.168.1.30', shopName: '' }]);
  assert.equal(two.count, 2);
  assert.match(two.message, /192\.168\.1\.30:5055/);
});

test('setup page: the warning step, two buttons and a second confirmation exist', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'setup.html'), 'utf8');
  for (const id of ['step-main-warning', 'other-main-message', 'use-as-client', 'main-anyway', 'main-anyway-confirm', 'main-anyway-confirmed']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('استخدم الجهاز ده كجهاز فرعي'));
  assert.ok(html.includes('أنا متأكد، كمّل كجهاز رئيسي'));
  assert.ok(html.indexOf('setup-main-check.js') < html.indexOf('setup.js"'), 'loaded before setup.js');
});

test('runtime watcher: first check, then every interval; emits only on change; ignores itself; stop cancels', async () => {
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  let answers = [OWN];
  const watcher = new MainPcWatcher({ discover: async () => answers, ownInstanceId: 'own-id', log: silentLog, firstCheckDelayMs: 10, checkIntervalMs: 300000, timers });
  const changes = [];
  watcher.on('change', (others) => changes.push(others));
  const tick = async () => {
    const timer = pending.shift();
    timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return timer.ms;
  };

  watcher.start();
  assert.equal(await tick(), 10);
  assert.deepEqual(changes, [], 'only itself: nothing to report');
  answers = [OWN, OTHER];
  assert.equal(await tick(), 300000);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], [{ instanceId: 'other-id', shopName: 'محل تاني', address: '192.168.1.20', port: 5055 }]);
  await tick();
  assert.equal(changes.length, 1, 'same answer: no new event');
  answers = [OWN];
  await tick();
  assert.deepEqual(changes[1], [], 'gone again');
  watcher.stop();
  assert.equal(pending.length, 0);
});
