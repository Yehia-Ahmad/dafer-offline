'use strict';

// Stage 25 review fixes: (1) the diagnostics read the database through the REAL query with the collection names the backend's models really use (a real
// mongod, rows written through the backend's own models), (2) the health report summary, (3) the export from a failure screen works without the backend.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readDatabaseFacts, summarizeHealth } = require('../lib/diagnostics-db');
const { createDiagnosticsHandlers } = require('../lib/diagnostics-handlers');
const { createZip, readZip } = require('../lib/zip-writer');
const { BackupService } = require('../lib/backup-service');
const { MongodManager } = require('../lib/mongod-manager');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const modules = path.join(resources.backendDir, 'node_modules');
const canRun = process.platform === 'win32' && fs.existsSync(path.join(resources.mongodbBin, 'mongod.exe'));
const silentLog = { info() {}, warn() {}, error() {} };
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

test('the backend lists its collection names once, and each model really uses its name', () => {
  const collections = require(path.join(resources.backendDir, 'src', 'models', 'collections.js'));
  assert.deepEqual(collections, { META: 'metas', AUDIT_LOG: 'auditlogs', DEVICE: 'devices' });
  process.env.NODE_ENV = 'test';
  for (const [model, key] of [['meta.model.js', 'META'], ['auditLog.model.js', 'AUDIT_LOG'], ['device.model.js', 'DEVICE']]) {
    const Model = require(path.join(resources.backendDir, 'src', 'models', model));
    assert.equal(Model.collection.name, collections[key], model);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/collection\('meta'\)|collection\("meta"\)/.test(main), 'main.js has no hard-coded Meta collection name');
  assert.match(main, /readDatabaseFacts\(\{ withClient/);
  assert.match(main, /bundled\.collections/);
});

test('real mongod: readDatabaseFacts goes through the real query and finds the Meta, migration log and paired clients written by the backend models', { skip: !canRun, timeout: 300000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-diagdb-'));
  const port = await freePort();
  const mongodb = require(path.join(modules, 'mongodb'));
  const mongoose = require(path.join(modules, 'mongoose'));
  process.env.NODE_ENV = 'test';
  const mongod = new MongodManager({ mongodPath: path.join(resources.mongodbBin, 'mongod.exe'), dbPath: path.join(home, 'db'), logFile: path.join(home, 'm.log'), pidFile: path.join(home, 'm.pid'), port, mongodb, log: silentLog, cacheSizeGB: 0.25 });
  try {
    await mongod.start();
    await mongoose.connect(mongod.uri, { dbName: 'nota' });
    const models = (name) => require(path.join(resources.backendDir, 'src', 'models', name));
    await models('meta.model.js').create({ _id: 'schema', version: 12, appVersion: '1.0.0', appBuild: '20261114.2346' });
    await models('auditLog.model.js').create([
      { at: new Date('2026-11-01T10:00:00Z'), action: 'system.migration', details: { version: 11, name: 'drop old index' } },
      { at: new Date('2026-11-01T10:00:01Z'), action: 'system.migration', details: { version: 12, name: 'pair clients' } },
      { at: new Date('2026-11-02T10:00:00Z'), action: 'sale.created', details: { total: 5 } },
    ]);
    await models('device.model.js').create([
      { deviceId: 'main-1', role: 'main' },
      { deviceId: 'c-1', role: 'client', paired: true },
      { deviceId: 'c-2', role: 'client', paired: true },
      { deviceId: 'c-3', role: 'client', paired: false },
    ]);
    await mongoose.disconnect();

    const service = new BackupService({ mongodbBin: resources.mongodbBin, port, backupsDir: path.join(home, 'backups'), mongodb, bson: require(path.join(modules, 'bson')), log: silentLog });
    const facts = await readDatabaseFacts({ withClient: (callback) => service.withClient(callback), collections: require(path.join(resources.backendDir, 'src', 'models', 'collections.js')) });
    assert.equal(facts.schemaVersion, 12);
    assert.equal(facts.appVersion, '1.0.0');
    assert.equal(facts.appBuild, '20261114.2346');
    assert.deepEqual(facts.migrations.map((m) => [m.version, m.name]), [[11, 'drop old index'], [12, 'pair clients']]);
    assert.equal(facts.pairedClients, 2);
    assert.equal(facts.knownClients, 3);
  } finally {
    await mongoose.disconnect().catch(() => {});
    await mongod.stop().catch(() => {});
    if (mongod.child) { mongod.child.kill(); await mongod.exited; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('health summary: pass/fail and numbers only, no names or ids', () => {
  const raw = {
    trialBalance: { expected: 0, actual: 0, difference: 0 },
    inventory: { expected: 100, actual: 112.5, difference: 12.5, byProduct: [{ name: 'سر', id: 'x' }] },
    customers: { difference: 0, byCustomer: [{ name: 'محمود', difference: 0 }], unassigned: 0 },
    closing: { difference: 0, violations: [{ day: '2026-01-01' }] },
    opening: { ok: false, difference: 0 },
  };
  const summary = summarizeHealth(raw);
  assert.equal(summary.allPass, false);
  assert.equal(summary.failed, 3);
  assert.deepEqual(summary.checks.trialBalance, { pass: true, expected: 0, actual: 0, difference: 0 });
  assert.equal(summary.checks.inventory.pass, false);
  assert.equal(summary.checks.inventory.difference, 12.5);
  assert.equal(summary.checks.closing.violations, 1);
  assert.equal(summary.checks.opening.pass, false);
  assert.ok(!JSON.stringify(summary).includes('محمود') && !JSON.stringify(summary).includes('سر'));
  assert.deepEqual(summarizeHealth(null), { available: false, reason: 'no report' });
});

test('a failure screen exports the diagnostics without the backend: no token, no session check, only while the app is in a failed state, and the file opens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-diagfail-'));
  try {
    const target = path.join(dir, 'out.zip');
    let failed = true;
    const collected = [];
    const deps = {
      backend: () => { throw new Error('the backend must not be asked: it is not running'); },
      collect: async (options) => { collected.push(options); return { zip: createZip([{ name: 'info.json', data: '{}' }]), fileName: 'nota-diagnostics-unlicensed-2026-11-15.zip' }; },
      chooseSavePath: async () => target,
      canExportLocal: () => failed,
      log: silentLog,
    };
    const handlers = createDiagnosticsHandlers(deps);
    const done = await handlers['diagnostics:export-local']();
    assert.equal(done.ok, true);
    assert.equal(done.value.path, target);
    assert.deepEqual(collected, [{ token: null }], 'collected with no token');
    assert.equal(readZip(fs.readFileSync(target))[0].name, 'info.json');

    failed = false; // the app is running: this route is closed (the signed-in route checks shop.manage)
    fs.rmSync(target);
    const closed = await handlers['diagnostics:export-local']();
    assert.equal(closed.ok, false);
    assert.equal(closed.error.code, 'NOT_FAILED');
    assert.equal(fs.existsSync(target), false);
    assert.equal(collected.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /canExportLocal: \(\) => FAILURE_STATES\.has\(state\.status\.state\)/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'status.js'), 'utf8');
  assert.match(page, /\$\('diagnostics'\)\.hidden = !errorStates\.has\(status\.state\)/, 'the button shows on every failure state of the status page');
  assert.match(page, /desktop\.diagnostics\.exportLocal\(\)/);
});
