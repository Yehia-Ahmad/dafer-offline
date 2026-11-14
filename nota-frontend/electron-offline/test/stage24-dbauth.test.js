'use strict';

// Stage 24: mongod with --auth + keyFile, on a REAL mongod. Nothing here touches C:\ProgramData\Nota, the installed Nota or port 27017/27217:
// every test uses its own temp folder and one random free loopback port, and every mongod it starts is stopped afterwards.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { MongodManager, processImagePath } = require('../lib/mongod-manager');
const { DbAuth, DbAuthError, createSafeStorageVault, createMachineScopeVault } = require('../lib/db-auth');
const { protectSecret, unprotectSecret } = require('../lib/secret-store');
const { mongoUri, redactUri } = require('../lib/mongo-uri');
const { BackupService, SAFETY_PREFIX } = require('../lib/backup-service');
const { buildRestoreArgs } = require('../lib/restore');
const { resolveResources } = require('../lib/paths');

const resources = resolveResources({ isPackaged: false });
const mongodPath = process.env.NOTA_TEST_MONGOD || path.join(resources.mongodbBin, 'mongod.exe');
const toolsBin = path.dirname(mongodPath);
const driverPath = path.join(resources.backendDir, 'node_modules', 'mongodb');
const bsonPath = path.join(resources.backendDir, 'node_modules', 'bson');
const canRun = fs.existsSync(mongodPath) && fs.existsSync(driverPath);
const skip = canRun ? false : 'the bundled mongod or the backend\'s MongoDB driver is not available (npm run offline:vendor)';
const mongodb = canRun ? require(driverPath) : null;
const bson = canRun ? require(bsonPath) : null;
const silentLog = { info() {}, warn() {}, error() {} };

// ---- helpers ---------------------------------------------------------------------------------------------------------

// Stands in for Electron's safeStorage (which needs a running Electron): the same interface, AES-256-GCM.
const makeVault = () => {
  const key = crypto.randomBytes(32);
  return {
    encrypt(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decrypt(buffer) { const d = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); d.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([d.update(buffer.subarray(28)), d.final()]).toString('utf8'); },
  };
};
const deadVault = { encrypt() { throw new Error('no key'); }, decrypt() { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString'); } };

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const portIsFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

const root = canRun ? fs.mkdtempSync(path.join(os.tmpdir(), 'nota-dbauth-')) : null;
const managers = [];
let port = 0;
let template = null; // a data folder of the OLD version (no passwords), with data, ready to copy

const legacyOptions = (home) => ({
  mongodPath, dbPath: path.join(home, 'data', 'db'), logFile: path.join(home, 'logs', 'mongod.log'), pidFile: path.join(home, 'run', 'mongod.pid'),
  port, mongodb, log: silentLog, cacheSizeGB: 0.25,
});
const prepareHome = (name) => {
  const home = path.join(root, name);
  for (const dir of ['data/db', 'logs', 'run', 'security']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  return home;
};
const track = (manager) => { managers.push(manager); return manager; };
const newAuth = (home, vault = sharedVault, legacyVault = null) => new DbAuth({
  securityDir: path.join(home, 'security'), mongodPath, dbPath: path.join(home, 'data', 'db'), logDir: path.join(home, 'logs'),
  port, mongodb, vault, legacyVault, log: silentLog,
});
const CREDENTIALS = 'mongo-credentials.dpapi'; // machine-scope (Stage 24 follow-up)
const LEGACY_CREDENTIALS = 'mongo-credentials.bin'; // the first build: per Windows account (safeStorage)
// The real thing: Windows DPAPI in machine scope, the same code path as the app (purpose 'db'). Windows only.
const machineVault = () => createMachineScopeVault({ protect: (text) => protectSecret(text, { purpose: 'db' }), unprotect: (text) => unprotectSecret(text, { purpose: 'db' }) });
const onWindows = process.platform === 'win32' ? false : 'machine-scope DPAPI needs Windows';
const sharedVault = canRun ? makeVault() : null;

async function seed(home) {
  // What a Stage 23 shop has: a replica set initiated by the old app (no password), with data and indexes.
  const manager = track(new MongodManager(legacyOptions(home)));
  await manager.start();
  const client = new mongodb.MongoClient(manager.uri, { directConnection: true });
  try {
    const db = client.db('nota');
    await db.collection('products').insertMany(Array.from({ length: 50 }, (_, i) => ({ code: `P-${i}`, name: `منتج ${i}`, stock: i })));
    await db.collection('products').createIndex({ code: 1 }, { unique: true });
    await db.collection('sellings').insertMany(Array.from({ length: 20 }, (_, i) => ({ number: i, total: i * 10 })));
  } finally { await client.close(); }
  await manager.stop();
  return { products: 50, sellings: 20 };
}

const startAuthenticated = async (home, creds) => {
  const manager = track(new MongodManager({ ...legacyOptions(home), auth: { keyFile: creds.keyFile, admin: creds.admin } }));
  await manager.start();
  return manager;
};

const countsAs = async (creds, manager) => {
  const client = new mongodb.MongoClient(manager.appUri(creds.app), { serverSelectionTimeoutMS: 10000 });
  try {
    const db = client.db('nota');
    return { products: await db.collection('products').countDocuments(), sellings: await db.collection('sellings').countDocuments() };
  } finally { await client.close(); }
};

async function assertRefusedWithoutPassword(manager) {
  const client = new mongodb.MongoClient(mongoUri({ port: manager.port, replicaSet: null }), { directConnection: true, serverSelectionTimeoutMS: 5000 });
  try {
    await assert.rejects(() => client.db('nota').collection('products').find({}).toArray(), (error) => error.code === 13 || /requires authentication|not authorized|Unauthorized/i.test(error.message));
    await assert.rejects(() => client.db('admin').command({ listDatabases: 1 }), (error) => error.code === 13 || /requires authentication|not authorized|Unauthorized/i.test(error.message));
  } finally { await client.close(); }
}

// Pids of mongod.exe processes started from this test's temp folder (never anything else).
const mongodsRunningFrom = () => {
  if (process.platform !== 'win32') return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='mongod.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }";
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout || '';
  return out.split(/\r?\n/).filter((line) => line.includes(root)).map((line) => Number(line.split('|')[0]));
};

test.before(async () => {
  if (!canRun) return;
  port = await freePort();
  const home = prepareHome('template');
  await seed(home);
  template = path.join(home, 'data', 'db');
});
test.after(async () => {
  for (const manager of managers) {
    if (manager.child) { manager.stopping = true; manager.child.kill(); await manager.exited; }
  }
  if (root) {
    for (const pid of mongodsRunningFrom()) spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const existingShop = (name) => {
  const home = prepareHome(name);
  fs.rmSync(path.join(home, 'data', 'db'), { recursive: true, force: true });
  fs.cpSync(template, path.join(home, 'data', 'db'), { recursive: true });
  return home;
};

// ---- pure bits ---------------------------------------------------------------------------------------------------------

test('connection strings: with the app user, redacted for logs, and the restore arguments carry the credentials', () => {
  const plain = mongoUri({ port: 27217, db: 'nota' });
  assert.equal(plain, 'mongodb://127.0.0.1:27217/nota?replicaSet=rs0&directConnection=true');
  const secured = mongoUri({ port: 27217, db: 'nota', auth: { user: 'nota_app', password: 'p/w+1' } });
  assert.equal(secured, 'mongodb://nota_app:p%2Fw%2B1@127.0.0.1:27217/nota?replicaSet=rs0&directConnection=true&authSource=admin');
  assert.ok(!redactUri(secured).includes('p%2Fw'));
  assert.match(redactUri(secured), /nota_app:\*\*\*@/);
  const args = buildRestoreArgs({ port: 27217, archivePath: 'a.gz', gzip: true, sourceDb: 'nota', targetDb: 'nota', auth: { user: 'nota_app', password: 'x' } });
  assert.ok(args[0].startsWith('--uri=mongodb://nota_app:x@127.0.0.1:27217/'));
  assert.ok(!buildRestoreArgs({ port: 1, archivePath: 'a', gzip: false, sourceDb: 'n', targetDb: 'n' })[0].includes('@'), 'no auth = no credentials in the URI');
});

test('main.js starts mongod through DbAuth (before any server start), hands the backend the app user only, bound to 127.0.0.1', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /new DbAuth\(\{[\s\S]*?\.ensure\(\{ stopOrphan/);
  assert.match(main, /mongoUri: mongod\.appUri\(dbAuth\.app\)/);
  assert.ok(main.indexOf('new DbAuth(') < main.indexOf('new BackendManager('), 'credentials before the backend');
  assert.match(main, /never start the backend without the database credentials/);
  assert.match(main, /vault: createMachineScopeVault\(\{ protect: \(text\) => protectSecret\(text, \{ purpose: 'db' \}\)/, 'machine-scope DPAPI, like the LAN and session secrets');
  assert.match(main, /legacyVault: createSafeStorageVault\(safeStorage\)/, 'safeStorage only reads an old per-account file');
  assert.ok(!/vault: createSafeStorageVault/.test(main));
  const manager = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mongod-manager.js'), 'utf8');
  assert.match(manager, /'--bind_ip', '127\.0\.0\.1'/, 'mongod listens on 127.0.0.1 only');
  assert.match(manager, /'--auth', '--keyFile', this\.auth\.keyFile/);
});

test('safeStorage vault: encrypts and decrypts through the Electron API; refuses when encryption is unavailable', () => {
  const calls = [];
  const fake = { isEncryptionAvailable: () => true, encryptString: (t) => { calls.push('e'); return Buffer.from(`enc:${t}`); }, decryptString: (b) => { calls.push('d'); return b.toString().slice(4); } };
  const vault = createSafeStorageVault(fake);
  assert.equal(vault.decrypt(vault.encrypt('secret')), 'secret');
  assert.deepEqual(calls, ['e', 'd']);
  const unavailable = createSafeStorageVault({ isEncryptionAvailable: () => false });
  assert.throws(() => unavailable.encrypt('x'), (error) => error instanceof DbAuthError && error.code === 'SAFE_STORAGE_UNAVAILABLE');
});

// ---- real mongod -------------------------------------------------------------------------------------------------------

test('a NEW install: ensure() creates the users, the keyFile and the encrypted credentials; mongod then starts with auth and refuses a connection without a password', { skip, timeout: 240000 }, async () => {
  const home = prepareHome('fresh');
  const creds = await newAuth(home).ensure();
  assert.equal(creds.admin.user, 'nota_admin');
  assert.equal(creds.app.user, 'nota_app');
  assert.ok(creds.admin.password.length >= 43 && creds.app.password.length >= 43, '32+ bytes of randomness each');
  assert.notEqual(creds.admin.password, creds.app.password);

  const blob = fs.readFileSync(path.join(home, 'security', CREDENTIALS));
  assert.ok(!blob.includes(Buffer.from(creds.admin.password)) && !blob.includes(Buffer.from(creds.app.password)), 'passwords are not on disk in plain text');
  for (const file of fs.readdirSync(path.join(home, 'security'))) {
    assert.ok(!fs.readFileSync(path.join(home, 'security', file)).includes(Buffer.from(creds.app.password)) || file === 'never', file);
  }
  const key = fs.readFileSync(creds.keyFile, 'utf8').trim();
  assert.ok(key.length >= 6 && key.length <= 1024 && /^[A-Za-z0-9+/=]+$/.test(key), 'a valid MongoDB keyFile');
  const state = JSON.parse(fs.readFileSync(path.join(home, 'security', 'db-auth.json'), 'utf8'));
  assert.equal(state.phase, 'complete');
  assert.deepEqual(state.running, []);
  assert.ok(!JSON.stringify(state).includes(creds.app.password), 'the state file holds no secret');
  assert.ok(await portIsFree(port), 'no mongod is left running');

  const manager = await startAuthenticated(home, creds);
  await assertRefusedWithoutPassword(manager);
  const client = new mongodb.MongoClient(manager.appUri(creds.app));
  try {
    await client.db('nota').collection('t').insertOne({ ok: 1 });
    assert.equal(await client.db('nota').collection('t').countDocuments(), 1, 'the app user reads and writes the Nota database');
    await assert.rejects(() => client.db('other').collection('t').insertOne({ no: 1 }), (error) => error.code === 13 || /not authorized/i.test(error.message), 'and only that database');
    await assert.rejects(() => client.db('admin').collection('system.users').find({}).toArray(), (error) => error.code === 13 || /not authorized/i.test(error.message));
  } finally { await client.close(); }
  await manager.stop();

  // the second start is the fast path: same credentials, no upgrade
  const again = await newAuth(home).ensure();
  assert.deepEqual(again.app, creds.app);
  assert.ok(await portIsFree(port));
});

test('an EXISTING database with data (the first shop): upgraded in place, every document still there, the old password-less access is gone', { skip, timeout: 240000 }, async () => {
  const home = existingShop('existing');
  const creds = await newAuth(home).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  const manager = await startAuthenticated(home, creds);
  assert.deepEqual(await countsAs(creds, manager), { products: 50, sellings: 20 });
  const client = new mongodb.MongoClient(manager.appUri(creds.app));
  try {
    const indexes = (await client.db('nota').collection('products').indexes()).map((index) => index.name).sort();
    assert.deepEqual(indexes, ['_id_', 'code_1'], 'indexes are kept');
    assert.equal((await client.db('nota').collection('products').findOne({ code: 'P-7' })).name, 'منتج 7');
  } finally { await client.close(); }
  await assertRefusedWithoutPassword(manager);
  const status = await manager.whoAnswers();
  assert.equal(status.answered && status.pid === manager.child.pid, true, 'the manager signs in as admin to identify its own mongod');
  await manager.stop();
});

const STEPS = ['material', 'temp-started', 'admin-user', 'app-user', 'temp-stopped', 'verified-running', 'verified'];
// Killed: the whole machine died (mongod too). Left running: only the app died (a child process outlives its parent on Windows),
// which only matters at the steps where a mongod is alive.
const ALIVE_STEPS = ['temp-started', 'admin-user', 'app-user', 'verified-running'];
for (const killed of [true, false]) {
  for (const crashAt of killed ? STEPS : ALIVE_STEPS) {
    test(`crash after "${crashAt}" (${killed ? 'mongod killed' : 'mongod left running, as when the app dies'}): the re-run finishes, all data intact, nothing locked out, nothing left running`, { skip, timeout: 300000 }, async () => {
      const home = existingShop(`crash-${crashAt}-${killed ? 'k' : 'l'}`);
      let firstPassword = null;
      const hook = async (step, context) => {
        if (step === 'material') firstPassword = JSON.parse(newAuth(home).vault.decrypt(fs.readFileSync(path.join(home, 'security', CREDENTIALS)))).app.password;
        if (step !== crashAt) return;
        if (killed) for (const entry of newAuth(home).readState().running) { spawnSync('taskkill', ['/PID', String(entry.pid), '/F', '/T'], { windowsHide: true }); }
        throw Object.assign(new Error(`simulated crash after ${step}`), { simulatedCrash: true });
      };
      await assert.rejects(() => newAuth(home).ensure({ hook, stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() }), /simulated crash/);
      const midState = newAuth(home).readState();
      assert.notEqual(midState.phase, 'complete', 'a crash never marks the upgrade complete');
      assert.ok(fs.existsSync(path.join(home, 'security', CREDENTIALS)), 'the credentials were saved before the database was touched');

      // restart: the same job, a new process
      const creds = await newAuth(home).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
      assert.equal(creds.app.password, firstPassword, 'the same passwords after the crash (they are reused, never replaced)');
      assert.equal(newAuth(home).readState().phase, 'complete');
      assert.deepEqual(newAuth(home).readState().running, []);
      assert.ok(await portIsFree(port), 'no mongod left running after the re-run');

      const manager = await startAuthenticated(home, creds);
      assert.deepEqual(await countsAs(creds, manager), { products: 50, sellings: 20 }, 'all data intact');
      await assertRefusedWithoutPassword(manager);
      await manager.stop();
      assert.ok(await portIsFree(port));
    });
  }
}

test('credentials this PC cannot decrypt (a data folder copied from another PC): refused with a clear error, nothing is regenerated or changed', { skip, timeout: 240000 }, async () => {
  const home = existingShop('unreadable');
  await newAuth(home).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  const before = fs.readFileSync(path.join(home, 'security', CREDENTIALS));
  const stateBefore = fs.readFileSync(path.join(home, 'security', 'db-auth.json'), 'utf8');
  await assert.rejects(() => newAuth(home, deadVault).ensure(), (error) => error instanceof DbAuthError && error.code === 'DB_CREDENTIALS_UNREADABLE' && /الجهاز/.test(error.message));
  assert.deepEqual(fs.readFileSync(path.join(home, 'security', CREDENTIALS)), before, 'the credentials file is untouched');
  assert.equal(fs.readFileSync(path.join(home, 'security', 'db-auth.json'), 'utf8'), stateBefore);
  assert.ok(await portIsFree(port), 'nothing was started');
  // the right account still works
  const creds = await newAuth(home).ensure();
  const manager = await startAuthenticated(home, creds);
  assert.deepEqual(await countsAs(creds, manager), { products: 50, sellings: 20 });
  await manager.stop();
});

test('a deleted credentials file on an upgraded database: rebuilt (the users are updated, the data is not touched), and the database opens with the new passwords', { skip, timeout: 240000 }, async () => {
  const home = existingShop('lost-file');
  const first = await newAuth(home).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  fs.rmSync(path.join(home, 'security', CREDENTIALS));
  fs.rmSync(path.join(home, 'security', 'mongo-keyfile'));
  const second = await newAuth(home).ensure();
  assert.notEqual(second.app.password, first.app.password);
  const manager = await startAuthenticated(home, second);
  assert.deepEqual(await countsAs(second, manager), { products: 50, sellings: 20 });
  const stale = new mongodb.MongoClient(manager.appUri(first.app), { serverSelectionTimeoutMS: 5000 });
  try { await assert.rejects(() => stale.db('nota').collection('products').countDocuments(), /Authentication failed|auth/i); } finally { await stale.close(); }
  await manager.stop();
});

test('FRESH install with the real machine-scope DPAPI: the credentials file is DPAPI (purpose "db"), not readable as plain text or with another purpose, and the keyFile is readable by every account', { skip: skip || onWindows, timeout: 240000 }, async () => {
  const home = prepareHome('machine-fresh');
  const creds = await newAuth(home, machineVault()).ensure();
  const security = path.join(home, 'security');
  assert.ok(fs.existsSync(path.join(security, CREDENTIALS)));
  assert.ok(!fs.existsSync(path.join(security, LEGACY_CREDENTIALS)), 'no per-account file is written any more');
  const text = fs.readFileSync(path.join(security, CREDENTIALS), 'utf8');
  assert.ok(!text.includes(creds.app.password) && !text.includes(creds.admin.password), 'not plain text');
  const inner = JSON.parse(unprotectSecret(text.trim(), { purpose: 'db' }));
  assert.equal(inner.app.password, creds.app.password, 'machine-scope DPAPI opens it');
  assert.throws(() => unprotectSecret(text.trim(), { purpose: 'lan' }), /DPAPI unprotect failed/, 'bound to its purpose (entropy)');
  assert.throws(() => unprotectSecret(text.trim(), { purpose: 'jwt' }), /DPAPI unprotect failed/);

  // every Windows account on the PC can start the server, so the keyFile is readable by BUILTIN\Users and SYSTEM only (no inherited rights)
  const script = `(Get-Acl -LiteralPath '${creds.keyFile}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value + '|' + $_.IsInherited }`;
  const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/).sort();
  assert.deepEqual(acl, ['S-1-5-18|False', 'S-1-5-32-545|False']);

  const again = await newAuth(home, machineVault()).ensure();
  assert.deepEqual(again.app, creds.app, 'the second start reads it back');
  const manager = await startAuthenticated(home, creds);
  await assertRefusedWithoutPassword(manager);
  await manager.stop();
});

test('an OLD per-account mongo-credentials.bin that this account can decrypt is migrated: the SAME passwords are re-saved machine-scope, the old file is removed, no upgrade runs, data intact', { skip: skip || onWindows, timeout: 300000 }, async () => {
  const home = existingShop('migrate-old');
  const perAccount = makeVault(); // plays the first build's safeStorage
  const first = await newAuth(home, perAccount).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  const security = path.join(home, 'security');
  fs.renameSync(path.join(security, CREDENTIALS), path.join(security, LEGACY_CREDENTIALS)); // the file as the first build left it
  assert.equal(newAuth(home).readState().phase, 'complete');
  const stateBefore = fs.readFileSync(path.join(security, 'db-auth.json'), 'utf8');
  const keyBefore = fs.readFileSync(first.keyFile, 'utf8');

  const migrated = await newAuth(home, machineVault(), perAccount).ensure();
  assert.deepEqual(migrated.app, first.app, 'the same app password (never regenerated for a database that already has users)');
  assert.deepEqual(migrated.admin, first.admin);
  assert.ok(!fs.existsSync(path.join(security, LEGACY_CREDENTIALS)), 'the old file is removed');
  assert.ok(fs.existsSync(path.join(security, CREDENTIALS)));
  assert.equal(JSON.parse(unprotectSecret(fs.readFileSync(path.join(security, CREDENTIALS), 'utf8').trim(), { purpose: 'db' })).app.password, first.app.password, 'now machine-scope');
  assert.equal(fs.readFileSync(path.join(security, 'db-auth.json'), 'utf8'), stateBefore, 'no upgrade ran: the state is unchanged');
  assert.equal(fs.readFileSync(first.keyFile, 'utf8'), keyBefore, 'the keyFile is unchanged');
  assert.ok(await portIsFree(port), 'no mongod was started for the migration');

  // the database opens with those credentials, all data there; a later start needs no per-account vault at all
  const again = await newAuth(home, machineVault()).ensure();
  assert.deepEqual(again.app, first.app);
  const manager = await startAuthenticated(home, again);
  assert.deepEqual(await countsAs(again, manager), { products: 50, sellings: 20 });
  await manager.stop();
});

test('an OLD per-account file this account CANNOT decrypt (another Windows account): DB_CREDENTIALS_UNREADABLE, nothing is created, changed or removed', { skip: skip || onWindows, timeout: 300000 }, async () => {
  const home = existingShop('migrate-unreadable');
  const perAccount = makeVault();
  const first = await newAuth(home, perAccount).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  const security = path.join(home, 'security');
  fs.renameSync(path.join(security, CREDENTIALS), path.join(security, LEGACY_CREDENTIALS));
  const snapshot = () => Object.fromEntries(fs.readdirSync(security).sort().map((name) => [name, fs.readFileSync(path.join(security, name)).toString('base64')]));
  const before = snapshot();
  // the legacy vault cannot decrypt it (it is another account's key); and a missing legacy vault gives the same answer
  for (const legacyVault of [deadVault, null]) {
    await assert.rejects(() => newAuth(home, machineVault(), legacyVault).ensure(), (error) => error instanceof DbAuthError && error.code === 'DB_CREDENTIALS_UNREADABLE');
    assert.deepEqual(snapshot(), before, 'every file in the security folder is byte-for-byte the same');
    assert.ok(!fs.existsSync(path.join(security, CREDENTIALS)), 'no machine-scope file was made');
  }
  assert.ok(await portIsFree(port), 'nothing was started');
  // the account that CAN decrypt it still migrates it afterwards: the failure cost nothing
  const recovered = await newAuth(home, machineVault(), perAccount).ensure();
  assert.deepEqual(recovered.app, first.app);
  assert.ok(!fs.existsSync(path.join(security, LEGACY_CREDENTIALS)));
});

test('RESTORE with auth ON: the safety backup is taken BEFORE any collection is emptied, and a restore that fails half-way puts the original data back', { skip, timeout: 420000 }, async (t) => {
  const home = existingShop('restore-fails');
  const creds = await newAuth(home).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  const manager = await startAuthenticated(home, creds);
  t.after(async () => { if (manager.child) await manager.stop(); }); // a failed assertion must not leave a mongod for the next test
  const service = new BackupService({ mongodbBin: toolsBin, port, backupsDir: path.join(home, 'backups'), mongodb, bson, log: silentLog, auth: creds.app });
  const client = new mongodb.MongoClient(manager.appUri(creds.app));
  try {
    // a good backup, then a copy cut off in the middle: the header still reads, mongorestore fails after the collections were emptied
    const good = path.join(home, 'backups', 'good.archive.gz');
    await service.createBackup(good);
    const bytes = fs.readFileSync(good);
    const broken = path.join(home, 'backups', 'broken.archive.gz');
    fs.writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length * 0.6)));

    // the shop's CURRENT data (different from the archive): this is what must survive
    await client.db('nota').collection('products').deleteMany({});
    await client.db('nota').collection('products').insertMany(Array.from({ length: 7 }, (_, i) => ({ code: `KEEP-${i}`, name: `باقي ${i}` })));
    await client.db('nota').collection('extra').insertOne({ keep: true });

    const phases = [];
    let drops = 0;
    const originalDrop = service.replaceWith.bind(service);
    service.replaceWith = async (archive, onProgress) => { drops += 1; return originalDrop(archive, onProgress); };
    const inspected = await service.inspect(broken);
    await assert.rejects(() => service.restore(inspected, { safety: true, onProgress: (p) => phases.push(p.phase) }), (error) => error.code === 'RESTORE_FAILED_ROLLED_BACK');

    // order: the safety backup was made first, then the restore tried, then the rollback
    assert.ok(phases.indexOf('safety-backup') > -1 && phases.indexOf('safety-backup') < phases.indexOf('restoring'), phases.join(','));
    assert.ok(phases.includes('rolling-back'), 'the failure was rolled back');
    assert.equal(drops, 2, 'the restore emptied the collections, then the rollback did');
    assert.ok(fs.readdirSync(path.join(home, 'backups')).some((name) => name.startsWith(SAFETY_PREFIX)), 'the safety backup file exists');

    // the end state is the ORIGINAL data, byte for byte
    assert.equal(await client.db('nota').collection('products').countDocuments(), 7);
    assert.deepEqual((await client.db('nota').collection('products').find({}).sort({ code: 1 }).toArray()).map((d) => d.code), Array.from({ length: 7 }, (_, i) => `KEEP-${i}`));
    assert.equal(await client.db('nota').collection('extra').countDocuments(), 1);
    assert.equal(await client.db('nota').collection('sellings').countDocuments(), 20, 'a collection that was not touched by the test data is back too');
  } finally { await client.close(); }
  await assertRefusedWithoutPassword(manager);
  await manager.stop();
});

test('a leftover pid of an unrelated program is never killed: only this app\'s own mongod.exe is touched', { skip, timeout: 120000 }, async () => {
  const home = prepareHome('foreign-pid');
  const sleeper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const auth = newAuth(home);
    auth.writeState({ phase: 'prepared', running: [{ kind: 'temp', pid: sleeper.pid, port: await freePort() }] });
    await auth.cleanupLeftovers();
    assert.equal(sleeper.exitCode, null, 'the unrelated process is still running');
    assert.ok(processImagePath(sleeper.pid) || process.platform !== 'win32');
  } finally { sleeper.kill(); }
});

test('backup + restore with auth ON, including a backup made before Stage 24 (password-less)', { skip, timeout: 420000 }, async () => {
  // 1. a pre-Stage-24 backup: made by the old (password-less) service from the old mongod
  const oldHome = existingShop('old-backup');
  const oldManager = track(new MongodManager(legacyOptions(oldHome)));
  await oldManager.start();
  const oldService = new BackupService({ mongodbBin: toolsBin, port, backupsDir: path.join(oldHome, 'backups'), mongodb, bson, log: silentLog });
  const archive = path.join(oldHome, 'backups', 'pre-stage-24.archive.gz');
  await oldService.createBackup(archive);
  await oldManager.stop();
  assert.ok(fs.existsSync(archive));

  // 2. another shop (already on auth) with different data restores it
  const home = existingShop('restore-target');
  const creds = await newAuth(home).ensure({ stopOrphan: () => new MongodManager(legacyOptions(home)).stopOrphan() });
  const manager = await startAuthenticated(home, creds);
  const service = new BackupService({ mongodbBin: toolsBin, port, backupsDir: path.join(home, 'backups'), mongodb, bson, log: silentLog, auth: creds.app });
  const client = new mongodb.MongoClient(manager.appUri(creds.app));
  try {
    await client.db('nota').collection('products').deleteMany({});
    await client.db('nota').collection('extra').insertOne({ gone: true });
    assert.equal(await client.db('nota').collection('products').countDocuments(), 0);

    // a backup of the authenticated database works (the app user can read it)
    const newBackup = path.join(home, 'backups', 'after.archive.gz');
    await service.createBackup(newBackup);
    assert.ok(fs.statSync(newBackup).size > 0);

    // the restore: safety backup, collections dropped one by one, mongorestore signs in with the app user
    const inspected = await service.inspect(archive);
    const result = await service.restore(inspected, { safety: true });
    assert.ok(result, 'restore finished');
    assert.equal(await client.db('nota').collection('products').countDocuments(), 50, 'the pre-Stage-24 backup is back');
    assert.equal(await client.db('nota').collection('sellings').countDocuments(), 20);
    assert.equal(await client.db('nota').collection('extra').countDocuments(), 0, 'what was not in the backup is gone');
    assert.equal((await client.db('nota').collection('products').findOne({ code: 'P-7' })).name, 'منتج 7');
    assert.deepEqual((await client.db('nota').collection('products').indexes()).map((i) => i.name).sort(), ['_id_', 'code_1']);
  } finally { await client.close(); }
  await assertRefusedWithoutPassword(manager);
  await manager.stop();
});

test('no mongod of these tests is left running', { skip }, async () => {
  for (const manager of managers) assert.equal(manager.child, null);
  assert.ok(await portIsFree(port));
  assert.deepEqual(mongodsRunningFrom(), []);
});
