'use strict';

// Stage 25, step C: the daily backup time, the primary backup folder, the "no good backup for 3 days" reminder, and a real backup into a
// custom folder that is restored from there (real mongod / mongodump / mongorestore).

const assert = require('node:assert/strict');
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

test('the daily backup waits for the chosen time, runs once after it, and catches up if the PC was off at that time', async () => {
  const ctx = setup({ time: '22:30' });
  try {
    ctx.at(9, 0);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 0, '09:00 is before 22:30');
    ctx.at(22, 29);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 0, 'one minute early');
    ctx.at(22, 30);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1, 'at the time');
    ctx.at(23, 45);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1, 'only once a day');
    // off all next day, switched on at 08:00 the day after: before today's time, so yesterday's is not made up; 22:30 it is
    ctx.at(8, 0, 2);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 1);
    ctx.at(22, 31, 2);
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 2);
    // changing the time to an earlier one makes today's backup due at once if that time has passed and there is none today
    ctx.at(12, 0, 3);
    ctx.time = '11:00';
    await ctx.auto.check();
    assert.equal(ctx.backups.length, 3);
    assert.ok(validTime('00:00') && validTime('23:59') && !validTime('24:00') && !validTime('9:30') && !validTime('22:60') && !validTime(null));
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

test('the reminder: nothing on day 0, then true when the last good backup (daily or manual) is older than 3 days', async () => {
  assert.equal(REMINDER_AFTER_DAYS, 3);
  const ctx = setup();
  try {
    ctx.auto.runBackup = async () => { throw Object.assign(new Error('disk full'), { code: 'BACKUP_FAILED' }); };
    ctx.at(9, 0);
    let summary = await ctx.auto.summary();
    assert.equal(summary.reminder, false, 'a new install is not nagged on day 0');
    assert.equal(summary.lastGood, null);
    ctx.at(9, 0, 3);
    assert.equal((await ctx.auto.summary()).reminder, false, 'exactly 3 days: not yet');
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
