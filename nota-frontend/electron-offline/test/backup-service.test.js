'use strict';

// Backup and restore with the real bundled mongod, mongodump and mongorestore.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackupService, SAFETY_PREFIX, backupFileName, parseDumpOutput } = require('../lib/backup-service');
const { DATABASE_NAME, MongodManager } = require('../lib/mongod-manager');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const bin = (name) => path.join(resources.mongodbBin, name);
const mongodbPath = path.join(resources.backendDir, 'node_modules', 'mongodb');
const bsonPath = path.join(resources.backendDir, 'node_modules', 'bson');
const canRun =
  process.platform === 'win32' && ['mongod.exe', 'mongodump.exe', 'mongorestore.exe'].every((n) => fs.existsSync(bin(n)));
const silentLog = { info() {}, warn() {}, error() {} };

test('backup file names sort by date and time', () => {
  const name = backupFileName('kapomatic-backup-', new Date(2026, 10, 2, 9, 5, 7));
  assert.equal(name, 'kapomatic-backup-2026-11-02_090507.archive.gz');
  assert.ok(backupFileName(SAFETY_PREFIX).startsWith('before-restore-'));
});

test('mongodump output parsing', () => {
  const entries = parseDumpOutput(
    '2026-11-02T21:00:00.000+0200\tdone dumping kapomatic_warehouse.products (12 documents)\n' +
      '2026-11-02T21:00:00.000+0200\tdone dumping kapomatic_warehouse.categories (1 document)\n'
  );
  assert.deepEqual(entries, [
    { namespace: 'kapomatic_warehouse.products', documents: 12 },
    { namespace: 'kapomatic_warehouse.categories', documents: 1 },
  ]);
});

test('real tools: backup, restore over newer data, rollback on a broken file, pruning', { skip: !canRun, timeout: 300000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kapomatic-backup-'));
  const mongodb = require(mongodbPath);
  const mongod = new MongodManager({
    mongodPath: bin('mongod.exe'),
    dbPath: path.join(home, 'db'),
    logFile: path.join(home, 'mongod.log'),
    pidFile: path.join(home, 'mongod.pid'),
    port: 27334,
    mongodb,
    log: silentLog,
  });
  await mongod.start();
  const client = new mongodb.MongoClient(mongod.uri, { directConnection: true });
  const db = client.db(DATABASE_NAME);
  const names = async (collection) => (await db.collection(collection).find().toArray()).map((d) => d.name).sort();

  try {
    const service = new BackupService({
      mongodbBin: resources.mongodbBin,
      port: 27334,
      backupsDir: path.join(home, 'backups'),
      mongodb,
      bson: require(bsonPath),
      log: silentLog,
      keepSafety: 2,
    });

    // State A: two categories and a product with a unique index.
    await db.collection('categories').insertMany([{ name: 'زيوت' }, { name: 'فتيس' }]);
    await db.collection('products').insertOne({ name: 'Oil', code: 'O-1' });
    await db.collection('products').createIndex({ code: 1 }, { unique: true });

    const progress = [];
    const backupA = path.join(home, 'out', backupFileName());
    const created = await service.createBackup(backupA, (p) => progress.push(p));
    assert.deepEqual({ collections: created.collections, documents: created.documents }, { collections: 2, documents: 3 });
    assert.ok(fs.existsSync(backupA) && !fs.existsSync(`${backupA}.partial`));
    assert.deepEqual(progress[progress.length - 1], { phase: 'backup', done: 2, total: 2 });

    // State B: more data, plus a collection that did not exist in A.
    await db.collection('categories').insertOne({ name: 'جديد' });
    await db.collection('customers').insertOne({ name: 'Ahmed' });

    const archive = await service.inspect(backupA);
    assert.equal(archive.sourceDb, DATABASE_NAME);
    const phases = new Set();
    const restored = await service.restore(archive, { safety: true, onProgress: (p) => phases.add(p.phase) });
    assert.equal(restored.restored, 3);
    assert.deepEqual([...phases], ['safety-backup', 'restoring']);

    assert.deepEqual(await names('categories'), ['زيوت', 'فتيس'], 'back to state A');
    assert.equal(await db.collection('customers').countDocuments(), 0, 'collections added after the backup are gone');
    assert.ok((await db.collection('products').indexes()).some((i) => i.unique && i.key.code === 1));

    // The safety backup holds state B.
    const safetyB = await service.inspect(restored.safetyPath);
    assert.deepEqual(safetyB.collections, 3);

    // A truncated archive: header readable, body broken. The restore must fail and roll back.
    // The source backup is large, so a cut at 70% always lands in the data, after the header.
    const bulk = Array.from({ length: 5000 }, (_, i) => ({ i, text: `row ${i} ${'x'.repeat(200)}` }));
    await db.collection('bulk').insertMany(bulk);
    const bigBackup = path.join(home, 'big.archive.gz');
    await service.createBackup(bigBackup);
    await db.collection('bulk').drop();
    const broken = path.join(home, 'broken.archive.gz');
    const bytes = fs.readFileSync(bigBackup);
    fs.writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length * 0.7)));
    await db.collection('categories').insertOne({ name: 'قبل التجربة' });
    const before = await names('categories');

    const brokenArchive = await service.inspect(broken);
    const rollbackPhases = [];
    await assert.rejects(
      service.restore(brokenArchive, { safety: true, onProgress: (p) => rollbackPhases.push(p.phase) }),
      (error) => error.code === 'RESTORE_FAILED_ROLLED_BACK'
    );
    assert.ok(rollbackPhases.includes('rolling-back'));
    assert.deepEqual(await names('categories'), before, 'data unchanged after the failed restore');
    assert.equal((await db.listCollections({ name: 'bulk' }).toArray()).length, 0, 'nothing from the broken file was left');

    // Only the newest keepSafety (2) safety backups remain.
    await service.createSafetyBackup();
    await new Promise((resolve) => setTimeout(resolve, 1100)); // names have one-second resolution
    await service.createSafetyBackup();
    assert.equal(service.listSafetyBackups().length, 2);
  } finally {
    await client.close();
    await mongod.stop().catch(() => {});
    if (mongod.child) {
      mongod.child.kill();
      await mongod.exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
