'use strict';

// Stage 25, step B/F: the rollback of an upgrade, on a THROWAWAY copy (a temp folder with its own mongod on its own port; never C:\ProgramData\Nota).
// It is what docs/release/UPGRADE_AR.md tells the person doing the upgrade:
//   1. close Nota, copy the data folder (the "safety copy");  2. install the new version, which migrates the data;
//   3. if something is wrong: close Nota, put the safety copy back (or restore the before-upgrade backup the new version took by itself).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackupService } = require('../lib/backup-service');
const { DATABASE_NAME, MongodManager } = require('../lib/mongod-manager');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const bin = (name) => path.join(resources.mongodbBin, name);
const backendModules = path.join(resources.backendDir, 'node_modules');
const canRun = process.platform === 'win32' && ['mongod.exe', 'mongodump.exe', 'mongorestore.exe'].every((name) => fs.existsSync(bin(name)));
const silentLog = { info() {}, warn() {}, error() {} };
const PORT = 27336;

test('rollback on a throwaway copy: the safety copy of the data folder, and the before-upgrade backup, each bring the old data back after a real upgrade (migrations)', { skip: !canRun, timeout: 400000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-rollback-'));
  const dbPath = path.join(home, 'data', 'db');
  const mongodb = require(path.join(backendModules, 'mongodb'));
  const mongoose = require(path.join(backendModules, 'mongoose'));
  const manager = () => new MongodManager({ mongodPath: bin('mongod.exe'), dbPath, logFile: path.join(home, 'mongod.log'), pidFile: path.join(home, 'mongod.pid'), port: PORT, mongodb, log: silentLog });
  const stopManager = async (mongod) => {
    await mongod.stop().catch(() => {});
    if (mongod.child) { mongod.child.kill(); await mongod.exited; }
  };
  const readSchema = async (db) => db.collection('metas').findOne({ _id: 'schema' });

  let mongod = manager();
  try {
    // ---- the shop's data as the OLD version left it: schema 4, some products
    await mongod.start();
    let client = new mongodb.MongoClient(mongod.uri, { directConnection: true });
    let db = client.db(DATABASE_NAME);
    await db.collection('metas').insertOne({ _id: 'schema', version: 4, appVersion: '0.9.0' });
    await db.collection('products').insertMany([{ name: 'مفتاح كهرباء', quantity: 10, price: 25 }, { name: 'لمبة', quantity: 4, price: 35 }]);
    await client.close();
    await stopManager(mongod);

    // ---- step 1: Nota is closed (mongod stopped): copy the data folder
    const safetyCopy = path.join(home, 'safety-copy');
    fs.cpSync(path.join(home, 'data'), safetyCopy, { recursive: true });
    assert.ok(fs.existsSync(path.join(safetyCopy, 'db')));

    // ---- step 2: the NEW version starts: backup first (what main.js does through BackendManager), then the real migrations
    mongod = manager();
    await mongod.start();
    const service = new BackupService({ mongodbBin: resources.mongodbBin, port: PORT, backupsDir: path.join(home, 'backups'), mongodb, bson: require(path.join(backendModules, 'bson')), log: silentLog });
    process.env.NODE_ENV = 'test';
    await mongoose.connect(mongod.uri, { dbName: DATABASE_NAME });
    const { runMigrations, highestVersion } = require(path.join(resources.backendDir, 'src', 'migrations'));
    let backup = null;
    const version = await runMigrations({ beforeMigrate: async ({ fromApp }) => { backup = await service.createUpgradeBackup({ from: fromApp || 'schema4', to: '1.0.0' }); } });
    assert.equal(version, highestVersion());
    assert.ok(backup && fs.existsSync(backup.path), 'the before-upgrade backup exists before the data changed');
    assert.match(path.basename(backup.path), /^before-upgrade-0\.9\.0-1\.0\.0-/);
    await mongoose.disconnect();

    client = new mongodb.MongoClient(mongod.uri, { directConnection: true });
    db = client.db(DATABASE_NAME);
    assert.equal((await readSchema(db)).version, highestVersion(), 'the upgrade changed the data version');
    assert.ok((await db.collection('accounts').countDocuments()) > 0, 'the upgrade created the chart of accounts');

    // ---- step 3a: rollback with the before-upgrade backup (the app is running, the owner restores it from the backup page)
    const restored = await service.restore(await service.inspect(backup.path), { safety: true });
    assert.ok(restored.restored >= 3);
    assert.equal((await readSchema(db)).version, 4, 'back to the old data version');
    assert.equal(await db.collection('accounts').countDocuments(), 0, 'what the upgrade created is gone');
    assert.deepEqual((await db.collection('products').find().toArray()).map((product) => product.name).sort(), ['لمبة', 'مفتاح كهرباء']);
    assert.ok(fs.readdirSync(path.join(home, 'backups')).some((name) => name.startsWith('before-restore-')), 'the restore kept its own safety backup too');
    await client.close();
    await stopManager(mongod);

    // ---- step 3b: rollback by putting the safety copy of the data folder back (Nota closed)
    // first migrate again so there is something to roll back
    mongod = manager();
    await mongod.start();
    await mongoose.connect(mongod.uri, { dbName: DATABASE_NAME });
    const { runMigrations: again } = require(path.join(resources.backendDir, 'src', 'migrations'));
    assert.equal(await again(), highestVersion());
    await mongoose.disconnect();
    await stopManager(mongod);

    fs.rmSync(path.join(home, 'data'), { recursive: true, force: true });
    fs.cpSync(safetyCopy, path.join(home, 'data'), { recursive: true });

    mongod = manager();
    await mongod.start();
    client = new mongodb.MongoClient(mongod.uri, { directConnection: true });
    db = client.db(DATABASE_NAME);
    assert.equal((await readSchema(db)).version, 4, 'the safety copy brought the old data version back');
    assert.equal((await readSchema(db)).appVersion, '0.9.0');
    assert.equal(await db.collection('accounts').countDocuments(), 0);
    assert.equal(await db.collection('products').countDocuments(), 2);
    await client.close();
  } finally {
    await mongoose.disconnect().catch(() => {});
    await stopManager(mongod);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
