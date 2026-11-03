'use strict';

// Setup validation, the backup archive reader, and a real restore of a VPS-style dump
// (database kapoInventory) into kapomatic_warehouse with the bundled MongoDB tools.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SetupController, SetupError, generateSecret } = require('../lib/setup-controller');
const { chooseSourceDatabase, readArchiveSummary } = require('../lib/backup-archive');
const { buildRestoreArgs, parseRestoreOutput, runRestore } = require('../lib/restore');
const { DATABASE_NAME, MongodManager } = require('../lib/mongod-manager');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const bin = (name) => path.join(resources.mongodbBin, name);
const driverPath = path.join(resources.backendDir, 'node_modules', 'mongodb');
const bsonPath = path.join(resources.backendDir, 'node_modules', 'bson');
const canRun =
  process.platform === 'win32' && ['mongod.exe', 'mongodump.exe', 'mongorestore.exe'].every((n) => fs.existsSync(bin(n)));
const silentLog = { info() {}, warn() {}, error() {} };

test('generated secrets are readable and unambiguous', () => {
  for (let i = 0; i < 50; i++) {
    const secret = generateSecret();
    assert.match(secret, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  }
  assert.notEqual(generateSecret(), generateSecret());
});

test('setup rejects bad input with a field to highlight', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kapomatic-setup-'));
  const controller = new SetupController({
    paths: { dbPath: path.join(home, 'db'), config: path.join(home, 'config.json') },
    resources,
    log: silentLog,
    appVersion: '1.0.0',
    getServerLock: async () => ({}),
  });
  const base = { shopName: 'Shop', secret: 'ABCD-EFGH-JKLM', port: 5055, dataChoice: 'empty' };
  const fieldOf = async (input) => {
    try {
      await controller.completeMain(input, () => {});
    } catch (error) {
      assert.ok(error instanceof SetupError, error.message);
      return error.field;
    }
    return 'accepted';
  };
  assert.equal(await fieldOf({ ...base, secret: 'short' }), 'secret');
  assert.equal(await fieldOf({ ...base, port: 5061 }), 'port');
  assert.equal(await fieldOf({ ...base, port: 'abc' }), 'port');
  assert.equal(await fieldOf({ ...base, dataChoice: 'other' }), 'dataChoice');
  assert.equal(await fieldOf({ ...base, dataChoice: 'restore', backupPath: path.join(home, 'missing.gz') }), 'backup');

  const clientField = async (input) => {
    try {
      await controller.completeClient(input, null);
    } catch (error) {
      return error.field;
    }
    return 'accepted';
  };
  assert.equal(await clientField({ host: 'http://x', port: 5055, secret: 'ABCD-EFGH-JKLM' }), 'host');
  assert.equal(await clientField({ host: '127.0.0.1', port: 5055, secret: 'x' }), 'secret');
  fs.rmSync(home, { recursive: true, force: true });
});

test('restore arguments rename the source database only when needed', () => {
  const renamed = buildRestoreArgs({ port: 27217, archivePath: 'C:\\b.gz', gzip: true, sourceDb: 'kapoInventory', targetDb: DATABASE_NAME });
  assert.ok(renamed.includes('--gzip'));
  assert.ok(renamed.includes('--drop'));
  assert.ok(renamed.includes('--nsInclude=kapoInventory.*'));
  assert.ok(renamed.includes('--nsFrom=kapoInventory.*'));
  assert.ok(renamed.includes(`--nsTo=${DATABASE_NAME}.*`));

  const same = buildRestoreArgs({ port: 27217, archivePath: 'b', gzip: false, sourceDb: DATABASE_NAME, targetDb: DATABASE_NAME });
  assert.ok(!same.some((arg) => arg.startsWith('--nsFrom')));
  assert.ok(!same.includes('--gzip'));
});

test('restore output parsing', () => {
  const parsed = parseRestoreOutput(
    'finished restoring kapoInventory.products (12 documents, 0 failures)\n' +
      'finished restoring kapoInventory.categories (3 documents, 0 failures)\n' +
      '15 document(s) restored successfully. 0 document(s) failed to restore.'
  );
  assert.equal(parsed.finished.length, 2);
  assert.equal(parsed.restored, 15);
  assert.equal(parsed.failed, 0);
});

test('archive reader rejects files that are not mongodump archives', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kapomatic-archive-')), 'notes.gz');
  fs.writeFileSync(file, 'just text, not an archive');
  await assert.rejects(readArchiveSummary(file, require(bsonPath)), (error) => error.code === 'NOT_AN_ARCHIVE');
});

test('real tools: a VPS dump of kapoInventory restores into kapomatic_warehouse', { skip: !canRun, timeout: 240000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kapomatic-restore-'));
  const mongodb = require(driverPath);
  const managers = [];
  const startMongod = async (name, port) => {
    const manager = new MongodManager({
      mongodPath: bin('mongod.exe'),
      dbPath: path.join(home, name),
      logFile: path.join(home, `${name}.log`),
      pidFile: path.join(home, `${name}.pid`),
      port,
      mongodb,
      log: silentLog,
    });
    managers.push(manager);
    await manager.start();
    return manager;
  };

  try {
    // "VPS": database kapoInventory with a few documents.
    const vps = await startMongod('vps', 27331);
    const vpsClient = new mongodb.MongoClient('mongodb://127.0.0.1:27331', { directConnection: true });
    const vpsDb = vpsClient.db('kapoInventory');
    await vpsDb.collection('categories').insertMany([{ name: 'زيوت' }, { name: 'فتيس' }]);
    await vpsDb.collection('products').insertMany([{ name: 'Oil 5W30', code: 'O-1' }]);
    await vpsDb.collection('products').createIndex({ code: 1 }, { unique: true });
    await vpsClient.close();

    // The command the user runs on the VPS (with --uri there).
    const archive = path.join(home, 'kapomatic-offline.archive.gz');
    const dump = spawnSync(bin('mongodump.exe'), ['--host=127.0.0.1', '--port=27331', '--db=kapoInventory', `--archive=${archive}`, '--gzip'], { encoding: 'utf8' });
    assert.equal(dump.status, 0, dump.stderr);
    await vps.stop();

    const summary = await readArchiveSummary(archive, require(bsonPath));
    assert.equal(summary.gzip, true);
    assert.deepEqual(Object.keys(summary.databases), ['kapoInventory']);
    assert.deepEqual(summary.databases.kapoInventory.sort(), ['categories', 'products']);
    assert.match(summary.serverVersion, /^8\.0/);
    assert.equal(chooseSourceDatabase(summary), 'kapoInventory');

    // Main PC: the target already has a stale copy of one collection, which --drop replaces.
    const target = await startMongod('target', 27332);
    const targetClient = new mongodb.MongoClient(target.uri, { directConnection: true });
    await targetClient.db().collection('categories').insertOne({ name: 'stale' });

    const progress = [];
    const result = await runRestore({
      mongorestorePath: bin('mongorestore.exe'),
      port: 27332,
      archivePath: archive,
      gzip: summary.gzip,
      sourceDb: 'kapoInventory',
      targetDb: DATABASE_NAME,
      totalCollections: 2,
      log: silentLog,
      onProgress: (p) => progress.push(p),
    });
    assert.equal(result.restored, 3);
    assert.equal(result.collections, 2);
    assert.deepEqual(progress[progress.length - 1], { done: 2, total: 2 });

    const db = targetClient.db(DATABASE_NAME);
    assert.deepEqual((await db.collection('categories').find().toArray()).map((c) => c.name).sort(), ['زيوت', 'فتيس']);
    const indexes = await db.collection('products').indexes();
    assert.ok(indexes.some((index) => index.unique && index.key.code === 1), 'indexes were restored');
    assert.equal((await targetClient.db('kapoInventory').listCollections().toArray()).length, 0, 'no copy under the old name');
    await targetClient.close();
    await target.stop();
  } finally {
    for (const manager of managers) {
      if (manager.child) {
        manager.stopping = true;
        manager.child.kill();
        await manager.exited;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
