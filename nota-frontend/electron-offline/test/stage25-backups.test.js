'use strict';

// Stage 25, step C: the daily backup time, the primary backup folder, the "no good backup for 3 days" reminder, and a real backup into a
// custom folder that is restored from there (real mongod / mongodump / mongorestore).

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AUTO_PREFIX, AutoBackup, REMINDER_AFTER_DAYS, validTime } = require('../lib/auto-backup');
const { BackupService, SAFETY_PREFIX, UPGRADE_PREFIX, backupFileName, upgradeBackupName } = require('../lib/backup-service');
const { createBackupHandlers } = require('../lib/backup-handlers');
const { normalizeConfig } = require('../lib/config-store');
const { DATABASE_NAME, MongodManager } = require('../lib/mongod-manager');
const { resolveResources } = require('../lib/paths');

const DAY = 24 * 60 * 60 * 1000;
const silentLog = { info() {}, warn() {}, error() {} };

function setup({ time = '00:00', primary = '' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-s25bk-'));
  const dir = path.join(home, 'backups', 'auto');
  fs.mkdirSync(dir, { recursive: true });
  let clock = new Date(2026, 10, 2, 9, 0, 0).getTime();
  const ctx = {
    home, dir, time, primary, backups: [],
    at: (hours, minutes = 0, dayOffset = 0) => { clock = new Date(2026, 10, 2 + dayOffset, hours, minutes, 0).getTime(); },
    advance: (ms) => (clock += ms),
    files: (folder = dir) => fs.readdirSync(folder).sort(),
  };
  ctx.auto = new AutoBackup({
    dir,
    statePath: path.join(home, 'backups', 'backup-state.json'),
    dataDir: home,
    sameDrive: async () => true,
    getCopyFolder: () => '',
    getBackupTime: () => ctx.time,
    getPrimaryFolder: () => ctx.primary,
    now: () => new Date(clock),
    log: silentLog,
    runBackup: async (file) => {
      fs.writeFileSync(file, `backup ${ctx.backups.length}`);
      ctx.backups.push(file);
      return { path: file };
    },
  });
  return ctx;
}
const cleanup = (ctx) => fs.rmSync(ctx.home, { recursive: true, force: true });

test('the daily backup: one a day, at the set time; a set time that passed while the app was closed (or before the shop opened) is made up at the next start', async () => {
  const ctx = setup({ time: '22:30' });
  try {
    // a shop with no backup at all gets one at the first start (the last 22:30 slot has no backup)
    ctx.at(9, 0);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1, 'first start, nothing backed up yet');
    ctx.at(9, 30);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1, 'only one a day');
    ctx.at(22, 31);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1, 'today already has one: 22:30 does not make a second');

    // next morning: the app was closed at 22:30, so that evening's backup was missed (only the morning one exists): made up at the start
    ctx.at(8, 0, 1);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 2, 'the 22:30 that passed while the app was closed is made up at the next start');
    ctx.at(8, 30, 1);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 2, 'and only once that day');

    // the app stays on until 22:30 of day 2, a backup exists from the evening of day 1: the next one is due only when 22:30 comes
    fs.writeFileSync(path.join(ctx.dir, backupFileName(AUTO_PREFIX, new Date(2026, 10, 3, 22, 30, 5))), 'evening');
    ctx.at(8, 0, 2);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 2, 'yesterday 22:30 was taken: nothing is due at 08:00');
    ctx.at(22, 30, 2);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 3, 'at 22:30 it is due');

    // changing the time to an earlier one makes today's backup due at once, if that time has passed and there is none today
    ctx.at(12, 0, 3);
    ctx.time = '11:00';
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 4);

    // the PC was off for days and is switched on at 20:00, before the set time: the missed slot is made up at once
    ctx.at(20, 0, 7);
    ctx.time = '22:30';
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 5);
    assert.ok(validTime('00:00') && validTime('23:59') && !validTime('24:00') && !validTime('9:30') && !validTime('22:60') && !validTime(null));
  } finally {
    cleanup(ctx);
  }
});

test('closing the app: today\'s backup is taken on close when it was not taken; not twice, not after a recent failure, and never longer than the limit', async () => {
  const ctx = setup({ time: '22:30' });
  try {
    ctx.at(9, 0);
    fs.writeFileSync(path.join(ctx.dir, backupFileName(AUTO_PREFIX, new Date(2026, 10, 1, 22, 30, 0))), 'older'); // some history: closing is about today
    const first = await ctx.auto.backUpOnClose();
    assert.ok(first, 'taken on close');
    assert.equal(ctx.backups.length, 1);
    assert.equal(await ctx.auto.backUpOnClose(), null);
    assert.equal(ctx.backups.length, 1, 'not twice');

    // a failing backup is not retried on close within the retry delay, and never throws
    ctx.at(9, 0, 1);
    ctx.auto.runBackup = async () => { throw Object.assign(new Error('disk full'), { code: 'BACKUP_FAILED' }); };
    assert.equal(await ctx.auto.backUpOnClose(), null);
    assert.equal(await ctx.auto.backUpOnClose(), null, 'the retry delay applies');

    // a backup that hangs cannot hold the close up
    ctx.at(9, 0, 3);
    ctx.auto.retryAt = 0;
    ctx.auto.runBackup = () => new Promise(() => {});
    const started = Date.now();
    assert.equal(await ctx.auto.backUpOnClose({ timeoutMs: 100, settleMs: 100 }), null);
    assert.ok(Date.now() - started < 3000);
  } finally {
    cleanup(ctx);
  }
});

test('the default time is 00:00, so the old behaviour (a backup at the first check of the day) is unchanged', async () => {
  const ctx = setup();
  try {
    ctx.at(0, 5);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1);
  } finally {
    cleanup(ctx);
  }
});

test('config.json: backupTime and backupFolder are read for the main PC, a bad time falls back to 00:00', () => {
  const base = { schemaVersion: 1, role: 'main', instanceId: 'i', lanSecretProtected: 'x', port: 5055 };
  assert.equal(normalizeConfig(base).backupTime, '00:00');
  assert.equal(normalizeConfig(base).backupFolder, '');
  assert.equal(normalizeConfig({ ...base, backupTime: '22:30', backupFolder: 'D:\\Backups' }).backupTime, '22:30');
  assert.equal(normalizeConfig({ ...base, backupTime: '25:99' }).backupTime, '00:00');
  assert.equal(normalizeConfig({ ...base, backupFolder: 'D:\\Backups' }).backupFolder, 'D:\\Backups');
});

test('the primary folder receives the daily backups, pruning there touches only daily backups, and an unavailable folder falls back to the home folder', async () => {
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-s25-usb-'));
  const primary = path.join(usb, 'NotaBackups');
  const ctx = setup({ primary });
  try {
    ctx.at(9, 0);
    // files that must never be pruned, living in the same folder
    fs.mkdirSync(primary, { recursive: true });
    fs.writeFileSync(path.join(primary, upgradeBackupName('1.0.0', '1.1.0', new Date(2026, 9, 1))), 'upgrade');
    fs.writeFileSync(path.join(primary, backupFileName(SAFETY_PREFIX, new Date(2026, 9, 2))), 'restore');
    for (let day = 0; day < 20; day += 1) fs.writeFileSync(path.join(primary, backupFileName(AUTO_PREFIX, new Date(2026, 9, 1 + day, 1, 0, 0))), `old ${day}`);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1);
    assert.equal(path.dirname(ctx.backups[0]), primary, 'the daily backup went to the primary folder');
    const left = ctx.files(primary);
    assert.equal(left.filter((name) => name.startsWith(AUTO_PREFIX)).length, 14, 'the newest 14 daily backups stay');
    assert.ok(left.some((name) => name.startsWith(UPGRADE_PREFIX)), 'before-upgrade is exempt');
    assert.ok(left.some((name) => name.startsWith(SAFETY_PREFIX)), 'before-restore is exempt');
    assert.equal(ctx.files(ctx.dir).length, 0, 'nothing in the home folder');
    assert.equal((await ctx.auto.summary()).primaryFallback, false);
    assert.equal((await ctx.auto.summary()).primaryFolder, primary);

    // the folder becomes unusable (a path under a plain file): the home folder takes over, and the summary says so
    ctx.at(9, 0, 1);
    fs.writeFileSync(path.join(usb, 'not-a-folder'), 'x');
    ctx.primary = path.join(usb, 'not-a-folder', 'sub');
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 2);
    assert.equal(path.dirname(ctx.backups[1]), ctx.dir, 'fell back to the home folder');
    const summary = await ctx.auto.summary();
    assert.equal(summary.primaryFallback, true);
    assert.equal(summary.autoDir, ctx.dir);
  } finally {
    cleanup(ctx);
    fs.rmSync(usb, { recursive: true, force: true });
  }
});

test('the reminder: nothing on day 0, then true when the last good backup (daily or manual) is 3 days old or more', async () => {
  assert.equal(REMINDER_AFTER_DAYS, 3);
  const ctx = setup();
  try {
    ctx.auto.runBackup = async () => { throw Object.assign(new Error('disk full'), { code: 'BACKUP_FAILED' }); };
    ctx.at(9, 0);
    let summary = await ctx.auto.summary();
    assert.equal(summary.reminder, false, 'a new install is not nagged on day 0');
    assert.equal(summary.lastGood, null);
    ctx.at(9, 0, 3);
    assert.equal((await ctx.auto.summary()).reminder, true, 'exactly 3 days: yes (3 days or more)');
    ctx.at(9, 0, 2);
    assert.equal((await ctx.auto.summary()).reminder, false, '2 days: not yet');
    ctx.at(9, 0, 3);
    ctx.at(9, 0, 4);
    summary = await ctx.auto.summary();
    assert.equal(summary.reminder, true, 'more than 3 days and no good backup');
    assert.equal(summary.daysSinceGood, 4);

    // a manual backup counts as a good backup and clears it
    fs.writeFileSync(path.join(ctx.home, 'manual.archive.gz'), 'x');
    await ctx.auto.recordManual({ path: path.join(ctx.home, 'manual.archive.gz') });
    summary = await ctx.auto.summary();
    assert.equal(summary.reminder, false);
    assert.equal(summary.lastGood.kind, 'manual');

    // a daily backup file on disk is the truth, a failing day does not hide how old the newest good one is
    ctx.at(9, 0, 8);
    summary = await ctx.auto.summary();
    assert.equal(summary.reminder, true, '4 days after the manual backup');
    fs.writeFileSync(path.join(ctx.dir, backupFileName(AUTO_PREFIX, new Date(2026, 10, 9, 2, 0, 0))), 'daily');
    summary = await ctx.auto.summary();
    assert.equal(summary.lastGood.kind, 'auto');
    assert.equal(summary.reminder, false);
  } finally {
    cleanup(ctx);
  }
});

function handlerHarness() {
  const calls = [];
  const deps = {
    isServerCopy: () => true, serverRunning: () => true, isBusy: () => false, busyError: () => new Error('busy'),
    backend: () => ({ me: async (token) => ({ user: { username: 'owner' }, permissions: token === 'cashier-token-0000' ? [] : ['backup.manage'] }), verifyPassword: async () => {} }),
    chooseSavePath: async () => null, chooseOpenPath: async () => null, chooseFolder: async () => 'E:\\NotaBackups', confirmRestore: async () => true,
    defaultBackupPath: () => 'x', createBackup: async () => ({}), recordManual: async () => true, inspect: async () => ({}), restoreArchive: async () => ({}),
    copyFolderInvalid: (folder) => folder.startsWith('C:\\ProgramData'), setCopyFolder: () => {}, copyNow: async () => {}, summary: async () => ({ ok: true }),
    showItemInFolder: () => {}, openBackupsFolder: async () => {}, onProgress: () => {}, onRestored: () => {}, log: silentLog,
    setBackupTime: (time) => calls.push(['time', time]), setBackupFolder: (folder) => calls.push(['folder', folder]),
  };
  return { handlers: createBackupHandlers(deps), calls, deps };
}

test('the backup time and primary folder handlers: backup.manage only, the time is validated, a folder inside the program data is refused', async () => {
  const { handlers, calls, deps } = handlerHarness();
  assert.deepEqual(await handlers['backup:set-time']('owner-token-0000000', '22:30'), { ok: true, value: { ok: true } });
  assert.deepEqual(calls, [['time', '22:30']]);
  for (const bad of ['25:00', '9:30', '', null, undefined, '22:30; drop', 2230]) {
    const answer = await handlers['backup:set-time']('owner-token-0000000', bad);
    assert.equal(answer.ok, false, String(bad));
    assert.equal(answer.error.code, 'INVALID_TIME');
  }
  assert.equal(calls.length, 1, 'a bad time changes nothing');
  assert.equal((await handlers['backup:set-time']('cashier-token-0000', '22:30')).error.code, 'FORBIDDEN');
  assert.equal((await handlers['backup:choose-primary-folder']('cashier-token-0000')).error.code, 'FORBIDDEN');

  assert.equal((await handlers['backup:choose-primary-folder']('owner-token-0000000')).ok, true);
  assert.deepEqual(calls[1], ['folder', 'E:\\NotaBackups']);
  deps.chooseFolder = async () => 'C:\\ProgramData\\Nota\\data';
  const refused = await handlers['backup:choose-primary-folder']('owner-token-0000000');
  assert.equal(refused.error.code, 'COPY_FOLDER_INVALID');
  assert.equal(calls.length, 2);
  assert.equal((await handlers['backup:clear-primary-folder']('owner-token-0000000')).ok, true);
  assert.deepEqual(calls[2], ['folder', '']);
});

// ------------------------------------------------------------------ real tools

const resources = resolveResources({ isPackaged: false });
const bin = (name) => path.join(resources.mongodbBin, name);
const canRun = process.platform === 'win32' && ['mongod.exe', 'mongodump.exe', 'mongorestore.exe'].every((name) => fs.existsSync(bin(name)));

test('real tools: a backup written into a custom folder (the primary folder) restores from there; the before-upgrade backup is a real, restorable archive', { skip: !canRun, timeout: 300000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-s25real-'));
  const custom = path.join(home, 'my usb backups', 'نسخ'); // spaces and Arabic in the folder name
  const mongodb = require(path.join(resources.backendDir, 'node_modules', 'mongodb'));
  const mongod = new MongodManager({ mongodPath: bin('mongod.exe'), dbPath: path.join(home, 'db'), logFile: path.join(home, 'mongod.log'), pidFile: path.join(home, 'mongod.pid'), port: 27335, mongodb, log: silentLog });
  await mongod.start();
  const client = new mongodb.MongoClient(mongod.uri, { directConnection: true });
  const db = client.db(DATABASE_NAME);
  try {
    const service = new BackupService({ mongodbBin: resources.mongodbBin, port: 27335, backupsDir: path.join(home, 'backups'), mongodb, bson: require(path.join(resources.backendDir, 'node_modules', 'bson')), log: silentLog });
    await db.collection('products').insertMany([{ name: 'Oil' }, { name: 'Filter' }]);
    await db.collection('metas').insertOne({ _id: 'schema', version: 12, appVersion: '1.0.0' });

    // the daily backup, driven by AutoBackup into the custom folder, with the REAL mongodump
    const auto = new AutoBackup({
      dir: path.join(home, 'backups', 'auto'), statePath: path.join(home, 'backups', 'backup-state.json'), dataDir: home, sameDrive: async () => true,
      getCopyFolder: () => '', getBackupTime: () => '00:00', getPrimaryFolder: () => custom, log: silentLog,
      runBackup: (file) => service.createBackup(file),
    });
    await auto.check();
    const daily = fs.readdirSync(custom).filter((name) => name.startsWith(AUTO_PREFIX));
    assert.equal(daily.length, 1, 'the daily backup is in the custom folder');
    assert.equal(fs.existsSync(path.join(home, 'backups', 'auto')) ? fs.readdirSync(path.join(home, 'backups', 'auto')).length : 0, 0);

    // the before-upgrade backup (what main.js takes before the first migration of a newer Nota)
    const upgrade = await service.createUpgradeBackup({ from: '1.0.0', to: '1.1.0' });
    assert.match(path.basename(upgrade.path), /^before-upgrade-1\.0\.0-1\.1\.0-\d{4}-\d{2}-\d{2}_\d{6}\.archive\.gz$/);
    assert.equal(upgrade.collections, 2);

    // lose the data, then restore from the custom folder file
    await db.collection('products').insertOne({ name: 'added after the backup' });
    const archive = await service.inspect(path.join(custom, daily[0]));
    const restored = await service.restore(archive, { safety: true });
    assert.equal(restored.restored, 3, "2 products + the schema record");
    assert.deepEqual((await db.collection('products').find().toArray()).map((doc) => doc.name).sort(), ['Filter', 'Oil']);
    assert.equal((await db.collection('metas').findOne({ _id: 'schema' })).appVersion, '1.0.0', 'the data version travels inside the backup');

    // and from the before-upgrade backup, the way a shop rolls back a bad upgrade
    await db.collection('products').deleteMany({});
    const back = await service.restore(await service.inspect(upgrade.path), { safety: false });
    assert.equal(back.restored, 3);
    assert.equal(await db.collection('products').countDocuments(), 2);
  } finally {
    await client.close();
    await mongod.stop().catch(() => {});
    if (mongod.child) { mongod.child.kill(); await mongod.exited; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the close-time backup: the cap, the installer, a Windows session end

const hangingBackup = (ctx, taken) => (file, { signal } = {}) => new Promise((resolve, reject) => {
  // stands in for mongodump: a partial file, and a kill that removes it
  fs.writeFileSync(`${file}.partial`, 'half a dump');
  taken.push(file);
  const stop = () => { fs.rmSync(`${file}.partial`, { force: true }); reject(Object.assign(new Error('stopped'), { code: 'BACKUP_ABORTED' })); };
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});

test('the cap on the close-time backup stops the dump and removes its partial file, then returns so the shutdown continues', async () => {
  const ctx = setup({ time: '22:30' });
  try {
    ctx.at(9, 0);
    const started = [];
    ctx.auto.runBackup = hangingBackup(ctx, started);
    const begun = Date.now();
    assert.equal(await ctx.auto.backUpOnClose({ timeoutMs: 100, settleMs: 2000 }), null);
    assert.ok(Date.now() - begun < 1500, 'it did not wait for the dump');
    assert.equal(started.length, 1, 'the dump had started');
    assert.deepEqual(ctx.files(), [], 'no partial file and no backup is left');
    assert.equal(ctx.auto.retryAt, 0, 'a cancelled backup is not a failure (no retry delay, no error shown)');
    assert.equal((await ctx.auto.summary()).autoError, null);
  } finally {
    cleanup(ctx);
  }
});

test('quitting for the installer or on a Windows session end: no close backup, and one already running is stopped', async () => {
  const ctx = setup({ time: '22:30' });
  try {
    ctx.at(9, 0);
    const started = [];
    ctx.auto.runBackup = hangingBackup(ctx, started);
    const closing = ctx.auto.backUpOnClose({ timeoutMs: 60000, settleMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(started.length, 1, 'the close backup is running');
    ctx.auto.cancelCloseBackup(); // gracefulQuit(reason, { backup: false })
    assert.equal(await closing, null);
    assert.deepEqual(ctx.files(), []);

    // cancelled before it begins: nothing is started at all
    const second = [];
    ctx.auto.runBackup = hangingBackup(ctx, second);
    const early = ctx.auto.backUpOnClose({ timeoutMs: 60000 });
    ctx.auto.cancelCloseBackup();
    assert.equal(await early, null);
    assert.equal(second.length, 0);
    assert.deepEqual(ctx.files(), []);
  } finally {
    cleanup(ctx);
  }
});

test('main.js: the installer (server lock, --quit, --quit-all through the single-instance lock) and the Windows session end quit without a backup; a plain close keeps it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const calls = main.split(/\r?\n/).filter((line) => /gracefulQuit\(['`]/.test(line));
  const noBackup = (text) => calls.filter((call) => call.includes(text)).every((call) => /backup: false/.test(call)) && calls.some((call) => call.includes(text));
  assert.ok(noBackup('Windows session end ('), 'query-session-end');
  assert.ok(noBackup("'Windows session ended'"), 'session-end');
  assert.ok(noBackup('through the server lock (installer)'), 'the installer through the server lock');
  assert.ok(noBackup('another launch asked the app to quit'), 'the single-instance quit (--quit-all, --quit)');
  assert.ok(!calls.filter((call) => /window closed|user chose exit|user pressed exit/.test(call)).some((call) => /backup: false/.test(call)), 'a plain close still backs up');
  assert.match(main, /if \(!state\.skipCloseBackup && state\.autoBackup/);
  assert.match(main, /if \(!backup && state\.autoBackup\) state\.autoBackup\.cancelCloseBackup\(\)/);
});

test('real tools, scaled down: the cap kills mongodump, no partial file or backup is left, and mongod stops right after', { skip: !canRun, timeout: 300000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-s25cap-'));
  const mongodb = require(path.join(resources.backendDir, 'node_modules', 'mongodb'));
  const mongod = new MongodManager({ mongodPath: bin('mongod.exe'), dbPath: path.join(home, 'db'), logFile: path.join(home, 'mongod.log'), pidFile: path.join(home, 'mongod.pid'), port: 27391, mongodb, log: silentLog });
  await mongod.start();
  const client = new mongodb.MongoClient(mongod.uri, { directConnection: true });
  const db = client.db(DATABASE_NAME);
  try {
    const service = new BackupService({ mongodbBin: resources.mongodbBin, port: 27391, backupsDir: path.join(home, 'backups'), mongodb, bson: require(path.join(resources.backendDir, 'node_modules', 'bson')), log: silentLog });
    // Size incompressible data with the real mongodump until this machine proves the dump takes comfortably longer
    // than the 700 ms close cap. This removes the old race where 60,000 highly-compressible documents finished first.
    const probe = path.join(home, 'probe.archive.gz');
    let dumpMs = 0;
    let batch = 0;
    while (dumpMs < 1400 && batch < 12) {
      const random = randomBytes(4_000_000).toString('base64');
      await db.collection('products').insertMany(Array.from({ length: 2000 }, (_, i) => ({
        n: batch * 2000 + i,
        filler: random.slice(i * 2000, (i + 1) * 2000),
      })));
      batch += 1;
      const probeStarted = Date.now();
      await service.createBackup(probe);
      dumpMs = Date.now() - probeStarted;
      fs.rmSync(probe, { force: true });
    }
    assert.ok(dumpMs >= 1400, `real mongodump never exceeded the close cap safely (last probe ${dumpMs} ms)`);
    const dir = path.join(home, 'backups', 'auto');
    const auto = new AutoBackup({
      dir, statePath: path.join(home, 'backups', 'backup-state.json'), dataDir: home, sameDrive: async () => true,
      getCopyFolder: () => '', getBackupTime: () => '00:00', getPrimaryFolder: () => '', log: silentLog,
      runBackup: (file, options) => service.createBackup(file, () => {}, { signal: options && options.signal }),
    });
    const begun = Date.now();
    assert.equal(await auto.backUpOnClose({ timeoutMs: 700, settleMs: 10000 }), null, 'the cap fired');
    assert.ok(Date.now() - begun < 9000, 'the close did not wait for the whole dump');
    const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(left, [], 'no partial file and no half backup');
    const dumps = require('node:child_process').spawnSync('tasklist', ['/FI', 'IMAGENAME eq mongodump.exe', '/NH'], { encoding: 'utf8' }).stdout;
    assert.ok(!/mongodump\.exe/i.test(dumps), 'mongodump was killed');
    await client.close();
    const stopping = Date.now();
    await mongod.stop();
    assert.ok(Date.now() - stopping < 30000, 'mongod stops right after');
  } finally {
    await client.close().catch(() => {});
    await mongod.stop().catch(() => {});
    if (mongod.child) { mongod.child.kill(); await mongod.exited; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
