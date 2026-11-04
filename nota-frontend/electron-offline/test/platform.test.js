'use strict';

// Small modules: paths, logger, port lock, backend environment, secret store.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { layout, resolveHome } = require('../lib/paths');
const { createLogger } = require('../lib/logger');
const { holdPortLock, isPortFree, requestQuit } = require('../lib/net-utils');
const { buildBackendEnv } = require('../lib/backend-manager');
const { protectSecret, unprotectSecret } = require('../lib/secret-store');

test('home folder: override, then ProgramData when installed, then the dev folder', () => {
  assert.equal(resolveHome({ isPackaged: true, env: { NOTA_OFFLINE_HOME: 'C:\\x' } }), path.resolve('C:\\x'));
  assert.equal(
    resolveHome({ isPackaged: true, env: { ProgramData: 'C:\\ProgramData' } }),
    path.join('C:\\ProgramData', 'Nota')
  );
  assert.match(resolveHome({ isPackaged: false, env: {} }), /offline-dev-home$/);
  assert.equal(layout('H').dbPath, path.join('H', 'data', 'db'));
});

test('logger writes lines and rotates large files', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nota-log-')), 'app.log');
  const logger = createLogger(file, { maxBytes: 2000, keep: 3 });
  const log = logger('test');
  for (let i = 0; i < 200; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
  assert.ok(fs.existsSync(`${file}.1`), 'rotated file exists');
  assert.ok(fs.statSync(file).size < 4000);
  assert.match(fs.readFileSync(file, 'utf8'), /\[info\] \[test\] line 199/);
});

test('the server lock is held by one holder at a time and released on close', async () => {
  const port = 27318;
  const first = await holdPortLock(port);
  assert.ok(first);
  assert.equal(await holdPortLock(port), null);
  assert.equal(await isPortFree(port), false);
  await new Promise((resolve) => first.close(resolve));
  const again = await holdPortLock(port);
  assert.ok(again);
  await new Promise((resolve) => again.close(resolve));
});

test('isPortFree: a listener on 0.0.0.0 or [::] of the port counts as taken', async () => {
  const net = require('node:net');
  const listen = (host, port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.destroy());
      server.once('error', reject);
      server.listen({ host, port }, () => resolve(server));
    });
  const close = (server) => new Promise((resolve) => server.close(resolve));

  assert.equal(await isPortFree(27342), true, 'nothing listens yet');
  const wildcard = await listen('0.0.0.0', 27342);
  assert.equal(await isPortFree(27342), false, 'IPv4 wildcard listener');
  await close(wildcard);
  assert.equal(await isPortFree(27342), true, 'free again after close');

  let dualStack = null;
  try {
    dualStack = await listen('::', 27343);
  } catch {
    // No IPv6 on this machine: nothing more to check.
  }
  if (dualStack) {
    assert.equal(await isPortFree(27343), false, 'IPv6 dual-stack listener');
    await close(dualStack);
  }
});

test('the copy holding the server lock stops when asked through the lock port', async () => {
  const port = 27319;
  assert.equal(await requestQuit(port), false, 'nobody holds the lock');

  let quits = 0;
  const lock = await holdPortLock(port, { onQuit: () => (quits += 1) });
  assert.equal(await requestQuit(port), true);
  assert.equal(quits, 1);

  // Anything else that connects is dropped without effect.
  const net = require('node:net');
  await new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => socket.write('GET / HTTP/1.1\r\n\r\n'));
    socket.on('close', resolve);
    socket.on('error', resolve);
  });
  assert.equal(quits, 1);
  await new Promise((resolve) => lock.close(resolve));
});

test('a lock without a quit handler ignores the quit request', async () => {
  const port = 27320;
  const lock = await holdPortLock(port);
  assert.equal(await requestQuit(port), false);
  await new Promise((resolve) => lock.close(resolve));
});

test('the backend gets only the variables it needs', () => {
  const env = buildBackendEnv({
    port: 5055,
    mongoUri: 'mongodb://127.0.0.1:27217/nota',
    secret: 'S3CRET-VALUE',
    appVersion: '1.0.0',
    instanceId: 'id',
    sourceEnv: { SystemRoot: 'C:\\Windows', FIREBASE_SERVICE_ACCOUNT: 'C:/keys/x.json', NOTIFICATIONS_API_KEY: 'k', TEMP: 'T' },
  });
  assert.equal(env.FIREBASE_SERVICE_ACCOUNT, undefined);
  assert.equal(env.NOTIFICATIONS_API_KEY, undefined);
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.NOTA_LAN_MODE, '1');
  assert.equal(env.NOTA_LISTEN_HOST, '0.0.0.0');
  assert.equal(env.PORT, '5055');
  assert.equal('NOTA_JWT_SECRET' in env, false, 'no session-token secret given, none passed');
  assert.equal('NOTA_AUTH' in env, false);
});

test('the main PC passes its session-token secret, but does not turn auth on yet (Stage 14)', () => {
  const env = buildBackendEnv({
    port: 5055,
    mongoUri: 'mongodb://127.0.0.1:27217/nota',
    secret: 'S3CRET-VALUE',
    jwtSecret: 'a'.repeat(64),
    appVersion: '1.0.0',
    instanceId: 'id',
    sourceEnv: { NOTA_AUTH: '1', NOTA_JWT_SECRET: 'from-the-user-environment' },
  });
  assert.equal(env.NOTA_JWT_SECRET, 'a'.repeat(64));
  assert.equal('NOTA_AUTH' in env, false, 'never taken from the user environment either');
});

test('secret store: the session-token secret round-trips with its own entropy', { skip: process.platform !== 'win32' }, () => {
  const secret = require('node:crypto').randomBytes(32).toString('hex');
  const stored = protectSecret(secret, { purpose: 'jwt' });
  assert.equal(unprotectSecret(stored, { purpose: 'jwt' }), secret);
  assert.throws(() => unprotectSecret(stored), /DPAPI unprotect failed/, 'cannot be read back as the LAN secret');
  assert.throws(() => protectSecret(secret, { purpose: 'other' }), /unknown secret purpose/);
});

test('secret store round-trips through machine-scope DPAPI', { skip: process.platform !== 'win32' }, () => {
  const secret = 'كلمة-سر-7KQ4-MZ8P';
  const stored = protectSecret(secret);
  assert.notEqual(stored, secret);
  assert.ok(!stored.includes('7KQ4'));
  assert.equal(unprotectSecret(stored), secret);
  assert.throws(() => unprotectSecret(Buffer.from('not dpapi data').toString('base64')), /DPAPI unprotect failed/);
});
