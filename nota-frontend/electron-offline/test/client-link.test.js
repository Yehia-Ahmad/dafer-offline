'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ConnectionMonitor, isValidHost, probeServer } = require('../lib/client-link');

const silentLog = { info() {}, warn() {}, error() {} };
const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('host validation accepts IPv4 addresses and computer names', () => {
  for (const host of ['192.168.1.10', '10.0.0.1', 'SHOP-PC', 'shop-pc.local']) assert.ok(isValidHost(host), host);
  for (const host of ['', '300.1.1.1', 'http://192.168.1.10', '192.168.1.10:5055', 'a b', '-pc']) {
    assert.ok(!isValidHost(host), host);
  }
});

test('probe results: ok, wrong secret, not ours, unreachable', async () => {
  const target = { host: '192.168.1.10', port: 5055, secret: 'SECRET-1234' };
  let seen;
  const ok = await probeServer({
    ...target,
    fetchImpl: async (url, options) => {
      seen = { url, header: options.headers['X-Nota-Lan-Key'] };
      return jsonResponse(200, { app: 'nota-backend', lanMode: true, appVersion: '1.0.0', instanceId: 'm' });
    },
  });
  assert.equal(ok.status, 'ok');
  assert.equal(seen.url, 'http://192.168.1.10:5055/api/lan/info');
  assert.equal(seen.header, 'SECRET-1234');

  const wrong = await probeServer({ ...target, fetchImpl: async () => jsonResponse(401, { code: 'LAN_KEY_INVALID' }) });
  assert.equal(wrong.status, 'unauthorized');

  const online = await probeServer({ ...target, fetchImpl: async () => jsonResponse(404, { message: 'not found' }) });
  assert.equal(online.status, 'not-nota', 'an online-mode backend has no LAN route');

  const other = await probeServer({ ...target, fetchImpl: async () => ({ status: 200, ok: true, json: async () => { throw new Error('html'); } }) });
  assert.equal(other.status, 'not-nota');

  const down = await probeServer({ ...target, fetchImpl: async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; } });
  assert.deepEqual(down, { status: 'unreachable', detail: 'ECONNREFUSED' });
});

test('the monitor reports a lost connection once, then its return', async () => {
  const realFetch = global.fetch;
  let up = true;
  global.fetch = async () => {
    if (!up) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return jsonResponse(200, { app: 'nota-backend', lanMode: true });
  };
  try {
    const timers = { setTimeout: () => 1, clearTimeout: () => {} };
    const monitor = new ConnectionMonitor({
      getTarget: () => ({ host: '127.0.0.1', port: 5055, secret: 's', instanceId: 'main-1' }),
      log: silentLog,
      timers,
      discover: async () => [],
    });
    const changes = [];
    monitor.on('change', (change) => changes.push(change));

    await monitor.check();
    up = false;
    await monitor.check();
    await monitor.check();
    up = true;
    await monitor.check();

    assert.deepEqual(changes, [{ connected: false, reason: 'unreachable' }, { connected: true }]);
  } finally {
    global.fetch = realFetch;
  }
});

test('after repeated failures the monitor finds the same main PC at a new address', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
  };
  try {
    const monitor = new ConnectionMonitor({
      getTarget: () => ({ host: '192.168.1.10', port: 5055, secret: 's', instanceId: 'main-1' }),
      log: silentLog,
      timers: { setTimeout: () => 1, clearTimeout: () => {} },
      discover: async () => [
        { instanceId: 'other-shop', address: '192.168.1.99', port: 5055 },
        { instanceId: 'main-1', address: '192.168.1.23', port: 5055 },
      ],
    });
    const moves = [];
    monitor.on('moved', (move) => moves.push(move));
    for (let i = 0; i < 3; i++) await monitor.check();
    assert.deepEqual(moves, [{ host: '192.168.1.23', port: 5055 }], 'only the same instance counts, after 3 failures');
  } finally {
    global.fetch = realFetch;
  }
});
