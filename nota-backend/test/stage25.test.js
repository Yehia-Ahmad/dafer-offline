process.env.NODE_ENV = "test";

// Stage 25: upgrade safety. Pending migrations on existing data call beforeMigrate first (the desktop app takes the before-upgrade backup there);
// a failing hook stops everything with the data untouched; data from a NEWER app is refused without a single write; a new database is not backed up.

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const AuditLog = require("../src/models/auditLog.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const { runMigrations, recordAppVersion, highestVersion, migrations } = require("../src/migrations");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop;
test.before(async () => { if (mongodSkipReason) return; stop = await startMongod({ port: 27165, tag: "s25-" }); });
test.after(async () => { if (stop) await stop(); });
test.beforeEach(async () => { if (!mongodSkipReason) await clearDatabase(); });
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

const snapshot = async () => ({
  meta: await Meta.find({}).lean(),
  audit: await AuditLog.countDocuments({}),
  collections: (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort(),
});

it("a brand-new database is migrated without a backup request", async () => {
  let calls = 0;
  await runMigrations({ beforeMigrate: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal((await Meta.findById("schema").lean()).version, highestVersion());
});

it("an existing older database: beforeMigrate runs once, BEFORE any migration, with from/to", async () => {
  await Meta.create({ _id: "schema", version: 4, appVersion: "1.0.0" });
  let seen = null; let versionAtCall = null; let auditAtCall = null;
  await runMigrations({
    beforeMigrate: async (info) => {
      seen = info;
      versionAtCall = (await Meta.findById("schema").lean()).version;
      auditAtCall = await AuditLog.countDocuments({ action: "system.migration" });
    },
  });
  assert.equal(versionAtCall, 4, "nothing was migrated when the backup was requested");
  assert.equal(auditAtCall, 0);
  assert.deepEqual(seen, { fromSchema: 4, toSchema: highestVersion(), fromApp: "1.0.0", pending: migrations.filter((m) => m.version > 4).map((m) => m.version) });
  assert.equal((await Meta.findById("schema").lean()).version, highestVersion());
});

it("legacy data with no Meta record (never migrated) is existing data too: from = schema 0", async () => {
  await Product.collection.insertOne({ name: "old product", quantity: 3 });
  let seen = null;
  await runMigrations({ beforeMigrate: async (info) => { seen = info; } });
  assert.equal(seen.fromSchema, 0);
  assert.equal(seen.fromApp, null);
});

it("when the backup fails nothing is migrated and the data is untouched", async () => {
  await Meta.create({ _id: "schema", version: 4 });
  await Product.collection.insertOne({ name: "keep me" });
  const before = await snapshot();
  const failure = Object.assign(new Error("disk full"), { code: "UPGRADE_BACKUP_FAILED" });
  await assert.rejects(runMigrations({ beforeMigrate: async () => { throw failure; } }), (error) => error === failure);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await Product.countDocuments({}), 1);
});

it("data from a NEWER Nota is refused with an Arabic + English message and not one write", async () => {
  await Meta.create({ _id: "schema", version: highestVersion() + 5, appVersion: "9.9.0" });
  const before = await snapshot();
  let hook = 0;
  await assert.rejects(runMigrations({ beforeMigrate: async () => { hook += 1; } }), (error) => {
    assert.equal(error.code, "SCHEMA_TOO_NEW");
    assert.match(error.message, /أحدث من نوتة/);
    assert.match(error.message, /newer Nota/);
    assert.match(error.message, /9\.9\.0/);
    return true;
  });
  assert.equal(hook, 0, "no backup, no migration");
  assert.deepEqual(await snapshot(), before);
});

it("an interrupted chunked migration resumes without a second backup", async () => {
  await Meta.create({ _id: "schema", version: 1, migrationProgress: { migration: 2 } });
  let calls = 0;
  await runMigrations({ beforeMigrate: async () => { calls += 1; } });
  assert.equal(calls, 0);
});

it("an up-to-date database starts with no hook and records which app version ran", async () => {
  await runMigrations();
  let calls = 0;
  await runMigrations({ beforeMigrate: async () => { calls += 1; } });
  assert.equal(calls, 0);
  await recordAppVersion("1.2.3", "20261114.1200");
  const meta = await Meta.findById("schema").lean();
  assert.equal(meta.appVersion, "1.2.3");
  assert.equal(meta.appBuild, "20261114.1200");
  assert.equal(meta.version, highestVersion());
});

test("the collection names the desktop app reads without mongoose are the real ones of the models", () => {
  const collections = require("../src/models/collections");
  assert.equal(Meta.collection.name, collections.META);
  assert.equal(AuditLog.collection.name, collections.AUDIT_LOG);
  assert.equal(require("../src/models/device.model").collection.name, collections.DEVICE);
});
