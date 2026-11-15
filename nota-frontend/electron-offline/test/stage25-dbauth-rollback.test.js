'use strict';

// Stage 25: rollback method A (docs/release/UPGRADE_AR.md) on a REAL mongod, in a temp folder on a free loopback port (never C:\ProgramData\Nota, the installed
// Nota or port 27017/27217): old data -> the auth upgrade -> the old data folder is put back (it has no database users) -> start again.
// db-auth.json still says "complete", but the users are gone from the data folder: DbAuth must create them again with the SAME stored credentials.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MongodManager } = require('../lib/mongod-manager');
const { DbAuth } = require('../lib/db-auth');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const mongodPath = path.join(resources.mongodbBin, 'mongod.exe');
const driverPath = path.join(resources.backendDir, 'node_modules', 'mongodb');
const canRun = fs.existsSync(mongodPath) && fs.existsSync(driverPath);
const mongodb = canRun ? require(driverPath) : null;
const logs = [];
const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const makeVault = () => {
  const key = crypto.randomBytes(32);
  return {
    encrypt(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decrypt(buffer) { const d = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); d.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([d.update(buffer.subarray(28)), d.final()]).toString('utf8'); },
  };
};

test('rollback method A: the old data folder is put back after the auth upgrade: the users are created again with the same credentials, the data is intact', { skip: !canRun, timeout: 400000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-dbauth-rollback-'));
  const dbPath = path.join(home, 'data', 'db');
  for (const dir of ['data/db', 'logs', 'run', 'security']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const port = await freePort();
  const vault = makeVault();
  const managers = [];
  const options = () => ({ mongodPath, dbPath, logFile: path.join(home, 'logs', 'mongod.log'), pidFile: path.join(home, 'run', 'mongod.pid'), port, mongodb, log, cacheSizeGB: 0.25 });
  const track = (m) => { managers.push(m); return m; };
  const stop = async (m) => { await m.stop().catch(() => {}); if (m.child) { m.child.kill(); await m.exited; } };
  const newAuth = () => new DbAuth({ securityDir: path.join(home, 'security'), mongodPath, dbPath, logDir: path.join(home, 'logs'), port, mongodb, vault, log });
  const productsAsApp = async (creds, manager) => {
    const client = new mongodb.MongoClient(manager.appUri(creds.app), { serverSelectionTimeoutMS: 10000 });
    try { return await client.db('nota').collection('products').countDocuments(); } finally { await client.close(); }
  };

  try {
    // the OLD shop: a replica set with no passwords and data
    const legacy = track(new MongodManager(options()));
    await legacy.start();
    let client = new mongodb.MongoClient(legacy.uri, { directConnection: true });
    await client.db('nota').collection('products').insertMany(Array.from({ length: 30 }, (_, i) => ({ code: `P-${i}`, name: `منتج ${i}` })));
    await client.close();
    await stop(legacy);
    const oldFolder = path.join(home, 'old-data-copy');
    fs.cpSync(path.join(home, 'data'), oldFolder, { recursive: true }); // what the shop copied before the upgrade (Nota closed)

    // the auth upgrade (first start of the new version)
    const first = await newAuth().ensure();
    const upgraded = track(new MongodManager({ ...options(), auth: { keyFile: first.keyFile, admin: first.admin } }));
    await upgraded.start();
    assert.equal(await productsAsApp(first, upgraded), 30);
    await stop(upgraded);
    const state = JSON.parse(fs.readFileSync(path.join(home, 'security', 'db-auth.json'), 'utf8'));
    assert.equal(state.phase, 'complete');
    assert.match(state.authId, /^[0-9a-f]{32}$/);
    assert.equal(fs.readFileSync(path.join(dbPath, 'nota-auth.id'), 'utf8').trim(), state.authId, 'the marker is inside the data folder');

    // a normal restart does NOT re-run the upgrade
    logs.length = 0;
    const again = await newAuth().ensure();
    assert.deepEqual(again.app, first.app);
    assert.equal(logs.some(([, m]) => /creating them again/.test(m)), false, 'no repair on a healthy data folder');

    // ROLLBACK A: the old data folder is put back; security\ (credentials, keyFile, db-auth.json "complete") stays as it was
    fs.rmSync(path.join(home, 'data'), { recursive: true, force: true });
    fs.cpSync(oldFolder, path.join(home, 'data'), { recursive: true });
    assert.equal(fs.existsSync(path.join(dbPath, 'nota-auth.id')), false, 'the old folder carries no marker');

    logs.length = 0;
    const repaired = await newAuth().ensure();
    assert.deepEqual(repaired.admin, first.admin, 'the SAME admin credentials');
    assert.deepEqual(repaired.app, first.app, 'the SAME app credentials');
    assert.ok(logs.some(([level, m]) => level === 'warn' && /creating them again/.test(m)));
    const restarted = track(new MongodManager({ ...options(), auth: { keyFile: repaired.keyFile, admin: repaired.admin } }));
    await restarted.start();
    assert.equal(await productsAsApp(repaired, restarted), 30, 'the old data is intact and the app user signs in');
    await stop(restarted);

    // and the state is complete again, so the next start is quiet
    logs.length = 0;
    await newAuth().ensure();
    assert.equal(logs.some(([, m]) => /creating them again/.test(m)), false);

    // method A with the runbook's extra step (security\db-auth.json deleted): the same result
    fs.rmSync(path.join(home, 'data'), { recursive: true, force: true });
    fs.cpSync(oldFolder, path.join(home, 'data'), { recursive: true });
    fs.rmSync(path.join(home, 'security', 'db-auth.json'), { force: true });
    const viaDelete = await newAuth().ensure();
    assert.deepEqual(viaDelete.app, first.app);
    const last = track(new MongodManager({ ...options(), auth: { keyFile: viaDelete.keyFile, admin: viaDelete.admin } }));
    await last.start();
    assert.equal(await productsAsApp(viaDelete, last), 30);
    await stop(last);
  } finally {
    for (const m of managers) await stop(m);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
