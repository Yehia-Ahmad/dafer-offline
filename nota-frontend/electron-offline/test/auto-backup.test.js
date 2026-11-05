'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AUTO_PREFIX, AutoBackup, onSameDrive } = require('../lib/auto-backup');

const DAY = 24 * 60 * 60 * 1000;

// Tests run on one drive: folders named nota-usb-* stand in for another drive.
const onUsb = (file) => path.resolve(file).split(path.sep).some((part) => part.startsWith('nota-usb-'));
const fakeSameDrive = async (a, b) => onUsb(a) === onUsb(b);

function setup({ copyFolder = null, failWith = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-auto-'));
  const dir = path.join(home, 'backups', 'auto');
  fs.mkdirSync(dir, { recursive: true });
  let clock = new Date(2026, 10, 2, 9, 0, 0).getTime();
  const logs = [];
  const ctx = {
    home,
    dir,
    logs,
    copyFolder,
    failWith,
    backups: [],
    advance: (ms) => (clock += ms),
    files: (folder = dir) => fs.readdirSync(folder).sort(),
  };
  ctx.auto = new AutoBackup({
    dir,
    statePath: path.join(home, 'backups', 'backup-state.json'),
    dataDir: home,
    sameDrive: fakeSameDrive,
    getCopyFolder: () => ctx.copyFolder,
    now: () => new Date(clock),
    log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    retryAfterFailureMs: 60 * 60 * 1000,
    // Stands in for the paused-backend mongodump of main.js.
    runBackup: async (file) => {
      if (ctx.failWith) throw ctx.failWith;
      fs.writeFileSync(file, `backup ${ctx.backups.length}`);
      ctx.backups.push(path.basename(file));
      return { path: file };
    },
  });
  return ctx;
}

test('one backup per day, and one catch-up backup after days the PC was off', async () => {
  const ctx = setup();
  await ctx.auto.check();
  assert.deepEqual(ctx.files(), [`${AUTO_PREFIX}2026-11-02_090000.archive.gz`]);

  ctx.advance(15 * 60 * 1000);
  await ctx.auto.check();
  assert.equal(ctx.backups.length, 1, 'not twice on the same day');

  ctx.advance(15 * 60 * 60 * 1000); // 00:15 the next day, the PC stayed on
  await ctx.auto.check();
  assert.equal(ctx.backups[1], `${AUTO_PREFIX}2026-11-03_001500.archive.gz`);

  ctx.advance(3 * DAY); // off for three days
  await ctx.auto.check();
  await ctx.auto.check();
  assert.equal(ctx.backups.length, 3, 'one catch-up backup, not one per missed day');
});

test('keeps the newest 14 daily backups and leaves other files alone', async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.dir, 'notes.txt'), 'mine');
  for (let day = 0; day < 17; day++) {
    await ctx.auto.check();
    ctx.advance(DAY);
  }
  const backups = ctx.files().filter((name) => name.startsWith(AUTO_PREFIX));
  assert.equal(backups.length, 14);
  assert.equal(backups[0], `${AUTO_PREFIX}2026-11-05_090000.archive.gz`, 'the oldest three are gone');
  assert.ok(ctx.files().includes('notes.txt'));
});

test('the extra folder gets a copy and counts as a backup outside the PC', async () => {
  const ctx = setup();
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-usb-'));
  ctx.copyFolder = usb;

  assert.equal((await ctx.auto.summary()).externalOverdue, true, 'warns before any copy outside the PC');
  await ctx.auto.check();
  assert.deepEqual(ctx.files(usb), ctx.files());

  const summary = await ctx.auto.summary();
  assert.equal(summary.lastCopy.status, 'copied');
  assert.equal(summary.lastExternal.kind, 'copy-folder');
  assert.equal(summary.externalOverdue, false);
  assert.equal(summary.lastBackup.kind, 'auto');

  ctx.advance(8 * DAY);
  ctx.copyFolder = null; // extra copy turned off: nothing new leaves the PC
  await ctx.auto.check();
  assert.equal((await ctx.auto.summary()).externalOverdue, true, 'warns again after 7 days');
});

test('a missing extra folder is skipped and logged once; the copy happens once it is back', async () => {
  const ctx = setup();
  const usb = path.join(ctx.home, 'nota-usb-drive');
  ctx.copyFolder = usb;

  await ctx.auto.check();
  ctx.advance(15 * 60 * 1000);
  await ctx.auto.check();
  assert.equal(ctx.backups.length, 1, 'the backup itself is not affected');
  assert.equal(ctx.logs.filter(([level, m]) => level === 'warn' && m.includes('not available')).length, 1);
  const waiting = await ctx.auto.summary();
  assert.equal(waiting.lastCopy.status, 'unavailable');
  assert.equal(waiting.externalOverdue, true);

  fs.mkdirSync(usb); // plugged in
  ctx.advance(15 * 60 * 1000);
  await ctx.auto.check();
  assert.deepEqual(ctx.files(usb), ctx.files());
  assert.equal((await ctx.auto.summary()).lastCopy.status, 'copied');
  assert.equal(ctx.backups.length, 1, 'copying did not make another backup');
});

test('the extra folder keeps 14 too, and only this app files are removed there', async () => {
  const ctx = setup();
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-usb-'));
  fs.writeFileSync(path.join(usb, 'family-photos.zip'), 'not ours');
  fs.writeFileSync(path.join(usb, `${AUTO_PREFIX}2026-01-01_000000.archive.gz.partial`), 'interrupted copy');
  ctx.copyFolder = usb;
  for (let day = 0; day < 16; day++) {
    await ctx.auto.check();
    ctx.advance(DAY);
  }
  const names = ctx.files(usb);
  assert.equal(names.filter((name) => name.endsWith('.archive.gz')).length, 14);
  assert.ok(names.includes('family-photos.zip'));
  assert.ok(!names.some((name) => name.endsWith('.partial')));
});

test('a failed backup is shown and retried after an hour; a busy server just waits for the next check', async () => {
  const failed = Object.assign(new Error('فشل إنشاء النسخة الاحتياطية.'), { code: 'BACKUP_FAILED', detail: 'disk full' });
  const ctx = setup({ failWith: failed });
  await ctx.auto.check();
  const summary = await ctx.auto.summary();
  assert.equal(summary.autoError.message, failed.message);
  assert.equal(summary.lastBackup, null);

  ctx.failWith = null;
  ctx.advance(15 * 60 * 1000);
  await ctx.auto.check();
  assert.equal(ctx.backups.length, 0, 'no retry before the hour is up');
  ctx.advance(60 * 60 * 1000);
  await ctx.auto.check();
  assert.equal(ctx.backups.length, 1);
  assert.equal((await ctx.auto.summary()).autoError, null, 'a success clears the error');

  const busy = setup({ failWith: Object.assign(new Error('busy'), { code: 'BACKUP_BUSY' }) });
  await busy.auto.check();
  assert.equal((await busy.auto.summary()).autoError, null, 'busy is not an error');
  busy.failWith = null;
  busy.advance(15 * 60 * 1000);
  await busy.auto.check();
  assert.equal(busy.backups.length, 1);
});

test('a manual backup on another drive is the latest backup and a copy outside the PC', async () => {
  const ctx = setup();
  await ctx.auto.check();
  ctx.advance(60 * 1000);
  assert.equal(await ctx.auto.recordManual({ path: path.join(os.tmpdir(), 'nota-usb-x', 'backup.archive.gz') }), true);
  const summary = await ctx.auto.summary();
  assert.equal(summary.lastBackup.kind, 'manual');
  assert.equal(summary.lastExternal.kind, 'manual');
  assert.equal(summary.externalOverdue, false);
});

test('a manual backup on the data drive is the latest backup but does not clear the warning', async () => {
  const ctx = setup();
  await ctx.auto.check();
  ctx.advance(60 * 1000);
  assert.equal(await ctx.auto.recordManual({ path: path.join(ctx.home, '..', 'Documents', 'backup.archive.gz') }), false);
  const summary = await ctx.auto.summary();
  assert.equal(summary.lastBackup.kind, 'manual');
  assert.equal(summary.lastExternal, null);
  assert.equal(summary.externalOverdue, true);
});

test('an extra folder on the data drive gets the copy but is flagged and does not clear the warning', async () => {
  const ctx = setup();
  const sameDriveFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-other-folder-'));
  ctx.copyFolder = sameDriveFolder;
  await ctx.auto.check();
  assert.deepEqual(ctx.files(sameDriveFolder), ctx.files(), 'still copied');
  const summary = await ctx.auto.summary();
  assert.equal(summary.copyFolderSameDrive, true);
  assert.equal(summary.lastCopy.status, 'copied');
  assert.equal(summary.externalOverdue, true);
  assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && m.includes('same drive')));

  ctx.copyFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-usb-'));
  await ctx.auto.copyNow();
  const moved = await ctx.auto.summary();
  assert.equal(moved.copyFolderSameDrive, false);
  assert.equal(moved.externalOverdue, false);
});

test('real drive check: by volume, missing paths by their parent, unknown drives by letter', {
  skip: process.platform === 'win32' ? false : 'Windows volume/drive-letter check',
}, async () => {
  const systemDrive = path.parse(os.tmpdir()).root;
  assert.equal(await onSameDrive(os.tmpdir(), path.join(systemDrive, 'Windows')), true);
  assert.equal(await onSameDrive(path.join(os.tmpdir(), 'not', 'created', 'yet'), os.tmpdir()), true);

  const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => `${l}:\\` !== systemDrive.toUpperCase());
  const missing = letters.find((l) => !fs.existsSync(`${l}:\\`));
  if (missing) assert.equal(await onSameDrive(`${missing}:\\Backups`, os.tmpdir()), false, 'an unplugged drive is another drive');
  // Read-only: only the volume id of another existing drive is looked at.
  const other = letters.find((l) => fs.existsSync(`${l}:\\`));
  if (other) assert.equal(await onSameDrive(`${other}:\\`, os.tmpdir()), false, `${other}: is another drive`);
});

test('first check shortly after start, then every interval; stop cancels', async () => {
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => pending.splice(pending.indexOf(timer) >>> 0, 1),
  };
  const auto = new AutoBackup({
    dir: os.tmpdir(),
    statePath: path.join(os.tmpdir(), 'unused.json'),
    getCopyFolder: () => null,
    log: { info() {}, warn() {}, error() {} },
    runBackup: async () => ({}),
    firstCheckDelayMs: 120000,
    checkIntervalMs: 900000,
    timers,
  });
  auto.check = async () => {};
  auto.start();
  assert.deepEqual(pending.map((t) => t.ms), [120000]);
  pending.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((t) => t.ms), [900000]);
  auto.stop();
  assert.equal(pending.length, 0);
});
