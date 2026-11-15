'use strict';

// Daily automatic backup on the main PC, plus an optional copy of it in a second folder (a USB
// drive or another disk) chosen on the backup page.
//
// When: once per calendar day. A few minutes after the server starts, if today has no
// automatic backup yet (this also catches up after days the PC was off); when the PC stays on
// overnight, at the first check after midnight. Both are quiet times in a shop.
// Stage 25: "when" is at or after the backup time chosen in Settings (default 00:00): a check before that time on a given day does nothing.
// Where: backups\auto in the home folder, or the primary backup folder chosen in Settings. If that folder is not available (a USB drive
// that is not plugged in) the home folder is used, so a backup is never skipped. The newest 14 are kept in each. Only nota-auto-backup-
// files are ever pruned: before-restore- and before-upgrade- backups are never touched.
// How: runBackup(file), which main.js runs with the backend paused, so the backup is consistent.
//
// backup-state.json remembers the last manual backup, the last copy outside this PC and the last
// error, for the backup page. The backups on disk are the truth for "is today's backup done", so
// a lost state file only loses the page's history.
//
// "Outside this PC" means on another drive than the program's data folder (USB drive, external
// disk, another partition, network share): a manual backup saved there, or the extra folder
// when it is there. A copy on the same drive does not survive that drive failing.

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { BACKUP_SUFFIX, backupFileName, localDateStamp } = require('./backup-service');

const AUTO_PREFIX = 'nota-auto-backup-';
const KEEP_AUTO_BACKUPS = 14;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
// After a real failure (disk full, ...), so the server is not paused every check.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
// The backup page warns when nothing was copied outside this PC for longer than this.
const EXTERNAL_COPY_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Stage 25: the home page reminds the owner when the last good backup is older than this.
const REMINDER_AFTER_DAYS = 3;
const DEFAULT_BACKUP_TIME = '00:00';
const validTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
// Someone else is busy (a manual backup or restore, the server restarting): try again next check.
const BUSY_CODES = new Set(['SERVER_BUSY', 'BACKUP_BUSY']);

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Windows reports a drive's volume serial number as stat.dev, which also sees through mapped and
// subst drive letters. A path that does not exist yet uses its nearest existing parent; null when
// nothing on the way exists (a USB drive that is not plugged in).
async function volumeId(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      return (await fsp.stat(current)).dev || null;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

const driveRoot = (target) => path.parse(path.resolve(target)).root.toLowerCase();

// Compares volumes when both are known, otherwise the drive letters (or network shares).
async function onSameDrive(a, b) {
  const [first, second] = await Promise.all([volumeId(a), volumeId(b)]);
  if (first && second) return first === second;
  return driveRoot(a) === driveRoot(b);
}

// The local time in a backup's name (backupFileName), or null.
function backupTime(file) {
  const match = /(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(path.basename(file));
  if (!match) return null;
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number);
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

class AutoBackup extends EventEmitter {
  constructor({
    dir,
    statePath,
    dataDir, // the program's data folder: its drive is "this PC"
    sameDrive = onSameDrive,
    runBackup,
    getCopyFolder,
    getBackupTime = () => DEFAULT_BACKUP_TIME,
    getPrimaryFolder = () => '',
    log,
    keep = KEEP_AUTO_BACKUPS,
    firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
    checkIntervalMs = CHECK_INTERVAL_MS,
    retryAfterFailureMs = RETRY_AFTER_FAILURE_MS,
    now = () => new Date(),
    timers = { setTimeout, clearTimeout },
  }) {
    super();
    this.dir = dir;
    this.statePath = statePath;
    this.dataDir = dataDir;
    this.sameDrive = sameDrive;
    this.runBackup = runBackup;
    this.getCopyFolder = getCopyFolder;
    this.getBackupTime = getBackupTime;
    this.getPrimaryFolder = getPrimaryFolder;
    this.usingFallback = false;
    this.log = log;
    this.keep = keep;
    this.firstCheckDelayMs = firstCheckDelayMs;
    this.checkIntervalMs = checkIntervalMs;
    this.retryAfterFailureMs = retryAfterFailureMs;
    this.now = now;
    this.timers = timers;
    this.timer = null;
    this.started = false;
    this.retryAt = 0;
    this.tail = Promise.resolve(); // checks, copies and state writes run one at a time
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule(this.firstCheckDelayMs);
  }

  // A backup that is running finishes on its own (the supervisor waits for it when quitting).
  stop() {
    this.started = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.check().finally(() => {
        if (this.started) this.schedule(this.checkIntervalMs);
      });
    }, delayMs);
  }

  serial(task) {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => {});
    return run;
  }

  // Back up if today has no automatic backup yet, then copy the newest one to the extra folder
  // if it is not there yet (for example, the USB drive was plugged in since).
  check() {
    return this.serial(async () => {
      try {
        if (await this.isDue()) await this.backUp();
        await this.copyPending();
      } catch (error) {
        this.log.error(`automatic backup check: ${error.message}`);
      }
    });
  }

  // Called after the user picked or cleared the extra folder.
  copyNow() {
    return this.serial(() => this.copyPending());
  }

  // A manual backup is the latest backup; saved on another drive it is also a copy outside this
  // PC. Resolves to whether it was.
  recordManual(result) {
    return this.serial(async () => {
      const entry = { at: this.now().toISOString(), path: result.path };
      const outside = !(await this.sameDrive(result.path, this.dataDir));
      await this.updateState({ manual: { ...entry, outside }, ...(outside ? { external: { ...entry, kind: 'manual' } } : {}) });
      this.emit('change');
      return outside;
    });
  }

  // The folder the daily backup goes to now: the primary folder when it is usable, else the home folder (and the page says so).
  async activeDir() {
    const custom = this.getPrimaryFolder();
    if (!custom) { this.usingFallback = false; return this.dir; }
    try {
      await fsp.mkdir(custom, { recursive: true });
      await fsp.access(custom, require('node:fs').constants.W_OK);
      this.usingFallback = false;
      return custom;
    } catch {
      if (!this.usingFallback) this.log.warn(`primary backup folder ${custom} is not available; the daily backup goes to ${this.dir} until it is`);
      this.usingFallback = true;
      return this.dir;
    }
  }

  async listAuto(folder = null) {
    folder = folder || (await this.activeDir());
    const names = await fsp.readdir(folder).catch(() => []);
    return names
      .filter((name) => name.startsWith(AUTO_PREFIX) && name.endsWith(BACKUP_SUFFIX))
      .sort()
      .map((name) => path.join(folder, name));
  }

  async hasBackupToday() {
    const today = `${AUTO_PREFIX}${localDateStamp(this.now())}_`;
    return (await this.listAuto()).some((file) => path.basename(file).startsWith(today));
  }

  // Due when there is no daily backup today AND the newest one is older than the last scheduled time (today's if it has passed, else yesterday's).
  // So a time that passed while the app was closed (or before the shop opened) is made up at the next start, and there is still at most one a day.
  async isDue() {
    if (this.now().getTime() < this.retryAt) return false;
    if (await this.hasBackupToday()) return false;
    const time = validTime(this.getBackupTime()) ? this.getBackupTime() : DEFAULT_BACKUP_TIME;
    const [hours, minutes] = time.split(':').map(Number);
    const now = this.now();
    const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
    if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 1); // today's time has not come yet: yesterday's slot is the one that counts
    const times = (await this.listAuto()).map(backupTime).filter(Boolean).map((date) => date.getTime());
    const newest = times.length ? Math.max(...times) : 0;
    return newest < slot.getTime();
  }

  // The app is closing: if today's daily backup was not taken (the PC was switched on after the time, or the time never came), take it now.
  // Never throws and never waits longer than timeoutMs, so closing the program is not held up; a busy or failing backup is simply skipped.
  backUpOnClose({ timeoutMs = 60000, settleMs = 5000, testOnlyStartTimeoutAfter = null } = {}) {
    const controller = new AbortController();
    this.closeController = controller;
    let finished = false;
    const job = this.serial(async () => {
      try {
        if (controller.signal.aborted || this.now().getTime() < this.retryAt || await this.hasBackupToday()) return null;
        return await this.backUp({ signal: controller.signal });
      } catch (error) {
        this.log.error(`backup on close: ${error.message}`);
        return null;
      }
    });
    let timer = null;
    const limit = Promise.resolve(testOnlyStartTimeoutAfter).then(() => new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(null), timeoutMs);
    }));
    // The cap: stop the dump (mongodump is killed, its partial file removed) and wait briefly for that, so the server can then be stopped.
    job.finally(() => { finished = true; }).catch(() => {});
    return Promise.race([job, limit]).then(async (result) => {
      if (!finished) {
        controller.abort();
        await Promise.race([job.catch(() => {}), new Promise((resolve) => this.timers.setTimeout(resolve, settleMs))]);
      }
      return result;
    }).finally(() => { this.timers.clearTimeout(timer); if (this.closeController === controller) this.closeController = null; });
  }

  // Closing for the installer or a Windows session end: no backup (and one already running is stopped).
  cancelCloseBackup() {
    if (this.closeController) this.closeController.abort();
  }

  async backUp({ signal } = {}) {
    const dir = await this.activeDir();
    const file = path.join(dir, backupFileName(AUTO_PREFIX, this.now()));
    try {
      const result = await this.runBackup(file, { signal });
      this.retryAt = 0;
      await this.updateState({ autoError: null });
      await this.prune(dir);
      this.log.info(`automatic backup saved: ${path.basename(file)}`);
      this.emit('change');
      return result;
    } catch (error) {
      if (error.code === 'BACKUP_ABORTED' || (signal && signal.aborted)) {
        this.log.info('automatic backup cancelled while closing');
        return null;
      }
      if (BUSY_CODES.has(error.code)) {
        this.log.info(`automatic backup postponed: ${error.message}`);
        return null;
      }
      this.retryAt = this.now().getTime() + this.retryAfterFailureMs;
      this.log.error(`automatic backup failed: ${error.message}${error.detail ? ` (${error.detail})` : ''}`);
      await this.updateState({ autoError: { at: this.now().toISOString(), message: error.message } });
      this.emit('change');
      return null;
    }
  }

  async copyPending() {
    const folder = this.getCopyFolder();
    if (!folder) return;
    const latest = (await this.listAuto()).pop();
    if (!latest) return;
    const { copy } = await this.readState();
    const name = path.basename(latest);
    if (copy && copy.status === 'copied' && copy.name === name && samePath(copy.folder, folder)) return;
    await this.copyTo(folder, latest, copy);
  }

  // A missing folder (USB drive not plugged in, disk removed) is skipped and logged, never an error.
  async copyTo(folder, file, previous) {
    const name = path.basename(file);
    const at = this.now().toISOString();
    const available = await fsp.stat(folder).then((stat) => stat.isDirectory(), () => false);
    if (!available) {
      const unchanged = previous && previous.status === 'unavailable' && samePath(previous.folder, folder);
      if (!unchanged) this.log.warn(`extra backup folder ${folder} is not available; the copy waits until it is`);
      await this.updateState({ copy: { folder, name, at, status: 'unavailable' } });
      if (!unchanged) this.emit('change');
      return false;
    }

    const target = path.join(folder, name);
    const partial = `${target}.partial`;
    try {
      await fsp.copyFile(file, partial);
      await fsp.rm(target, { force: true });
      await fsp.rename(partial, target);
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => {});
      this.log.warn(`could not copy the backup to ${folder}: ${error.message}`);
      await this.updateState({ copy: { folder, name, at, status: 'failed', message: error.message } });
      this.emit('change');
      return false;
    }
    await this.prune(folder);
    this.log.info(`backup copied to ${target}`);
    const outside = !(await this.sameDrive(folder, this.dataDir));
    if (!outside) this.log.warn(`extra backup folder ${folder} is on the same drive as the data; it does not count as a copy outside this PC`);
    await this.updateState({
      copy: { folder, name, at, status: 'copied' },
      ...(outside ? { external: { at, path: target, kind: 'copy-folder' } } : {}),
    });
    this.emit('change');
    return true;
  }

  // Keeps the newest automatic backups and removes leftovers of interrupted copies. Only this
  // app's own files are touched, also in the user's extra folder.
  async prune(folder) {
    const names = (await fsp.readdir(folder).catch(() => [])).filter((name) => name.startsWith(AUTO_PREFIX));
    const backups = names.filter((name) => name.endsWith(BACKUP_SUFFIX)).sort();
    const remove = [
      ...backups.slice(0, Math.max(0, backups.length - this.keep)),
      ...names.filter((name) => name.endsWith('.partial')),
    ];
    for (const name of remove) {
      await fsp.rm(path.join(folder, name), { force: true }).catch((error) => {
        this.log.warn(`could not remove ${name}: ${error.message}`);
      });
    }
  }

  // What the backup page shows. Dates are ISO strings.
  async summary() {
    const state = await this.readState();
    const latest = (await this.listAuto()).pop();
    const lastAuto = latest ? { at: backupTime(latest).toISOString(), path: latest } : null;
    const lastBackup =
      [lastAuto && { ...lastAuto, kind: 'auto' }, state.manual && { ...state.manual, kind: 'manual' }]
        .filter(Boolean)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
    const folder = this.getCopyFolder() || null;
    const external = state.external || null;
    const activeDir = await this.activeDir();
    // The last GOOD backup: the newest automatic file on disk or the last manual backup. Before the first one, the clock starts the first time
    // the status is read (a new install is not nagged on day 0).
    const firstSeenAt = state.firstSeenAt || (await this.updateState({ firstSeenAt: this.now().toISOString() })).firstSeenAt;
    const lastGoodAt = lastBackup ? lastBackup.at : null;
    const daysSinceGood = Math.floor((this.now().getTime() - Date.parse(lastGoodAt || firstSeenAt)) / DAY_MS);
    return {
      schedule: { time: validTime(this.getBackupTime()) ? this.getBackupTime() : DEFAULT_BACKUP_TIME },
      primaryFolder: this.getPrimaryFolder() || null,
      primaryFallback: this.usingFallback,
      lastGood: lastGoodAt ? { at: lastGoodAt, kind: lastBackup.kind } : null,
      daysSinceGood: Math.max(0, daysSinceGood),
      reminder: daysSinceGood >= REMINDER_AFTER_DAYS,
      reminderAfterDays: REMINDER_AFTER_DAYS,
      lastBackup,
      lastAuto,
      autoCount: (await this.listAuto()).length,
      keep: this.keep,
      autoDir: activeDir,
      autoError: state.autoError || null,
      // The data folder's drive, e.g. "C:", for the page's messages.
      dataDrive: path.parse(path.resolve(this.dataDir)).root.replace(/\\$/, ''),
      copyFolder: folder,
      copyFolderSameDrive: folder ? await this.sameDrive(folder, this.dataDir) : false,
      lastCopy: folder && state.copy && samePath(state.copy.folder, folder) ? state.copy : null,
      lastExternal: external,
      externalMaxAgeDays: EXTERNAL_COPY_MAX_AGE_DAYS,
      externalOverdue: !external || this.now().getTime() - Date.parse(external.at) > EXTERNAL_COPY_MAX_AGE_DAYS * DAY_MS,
    };
  }

  async readState() {
    try {
      const value = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  async updateState(changes) {
    const next = { ...(await this.readState()), ...changes };
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
    await fsp.rename(temporary, this.statePath);
    return next;
  }
}

module.exports = { AUTO_PREFIX, AutoBackup, DEFAULT_BACKUP_TIME, EXTERNAL_COPY_MAX_AGE_DAYS, KEEP_AUTO_BACKUPS, REMINDER_AFTER_DAYS, onSameDrive, validTime };
