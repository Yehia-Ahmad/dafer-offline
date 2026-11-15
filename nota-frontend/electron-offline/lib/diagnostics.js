'use strict';

// Stage 25: the diagnostics file a shop sends to support (one zip, saved where the owner or a manager chooses).
//
// What goes in is an ALLOWLIST. This code never reads the security folder (database password, keyFile, session secret, DPAPI blobs), the
// license text, the eula record, the database files, config.json as a whole, or any backup content. It builds each file from named fields:
//
//   README.txt       what is inside and what is not
//   info.json        app version + build, Electron/Node/Chrome versions, Windows version, CPU/RAM, uptime
//   config.json      role, port, instanceId, startWithWindows, main PC address (allowlisted keys only; no secrets)
//   license.json     license id, type, max client PCs, issue date and the shop name (no license text, no Machine ID)
//   status.json      what the status page shows (state, label, error code and message)
//   database.json    the data version, the app version/build that last ran on it, the paired and known client PCs
//   migrations.json  the migration log (version, name, when)
//   health.json      the accounting health checks: pass/fail and the numbers (no names), when the server runs and the caller may read them
//   backups.json     backup file NAMES, sizes and dates (not contents), and the daily-backup status
//   printing.json    this PC's print settings (printer names, copies, paper width, offset)
//   logs/*.log       the last ~400 KB of app.log, backend.log, mongod.log, mongod-upgrade.log (and their rotations)
//
// Every text file also goes through redact.js (tokens, passwords, license strings, hex/base64 blobs, e-mails, phone numbers, Windows
// account names), as a second line of defence for whatever a log line happens to contain.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { redactText } = require('./redact');
const { createZip } = require('./zip-writer');

const LOG_ALLOWLIST = /^(app|backend|mongod|mongod-upgrade)\.log(\.[1-3])?$/;
const LOG_TAIL_BYTES = 400 * 1024;
const BACKUP_FILE = /\.archive\.gz(\.partial)?$/;
const CONFIG_KEYS = ['schemaVersion', 'role', 'port', 'instanceId', 'startWithWindows', 'mainHost', 'mainInstanceId', 'autoLockMinutes'];
const PRINT_KEYS = ['receiptPrinter', 'documentPrinter', 'autoPrintReceipt', 'receiptCopies', 'receiptWidthMm', 'receiptOffsetMm'];

const pad = (value) => String(value).padStart(2, '0');
const dateStamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const pick = (source, keys) => {
  const out = {};
  if (source && typeof source === 'object') for (const key of keys) if (key in source) out[key] = source[key];
  return out;
};

/** nota-diagnostics-<licenseId>-<date>.zip (the license id keeps only letters, digits and dashes) */
function diagnosticsFileName(licenseId, date = new Date()) {
  const id = String(licenseId || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'unlicensed';
  return `nota-diagnostics-${id}-${dateStamp(date)}.zip`;
}

function readTail(file, bytes = LOG_TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = `[... ${start} earlier bytes not included ...]\n${text.slice(text.indexOf('\n') + 1)}`;
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function listBackupFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => BACKUP_FILE.test(name)).sort().map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, sizeMb: Math.round((stat.size / 1048576) * 10) / 10, modified: stat.mtime.toISOString() };
  });
}

/** Free and total space of the drive that holds `dir` (null when the platform cannot say). */
function diskFree(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return { drive: path.parse(path.resolve(dir)).root.replace(/[\\/]$/, ''), freeMb: Math.round((stat.bavail * stat.bsize) / 1048576), totalMb: Math.round((stat.blocks * stat.bsize) / 1048576) };
  } catch {
    return null;
  }
}

const README = `Nota diagnostics file / ملف تشخيص نوتة

This file helps support understand a problem. It was made on the shop's PC by an owner or manager and saved where they chose.
It contains: app/Windows versions, this PC's settings (no secrets), license id, the status page, the data version, backup file names and
dates (no data), and the last part of the program logs with passwords, tokens, license text, e-mails and phone numbers removed.

It does NOT contain: the database, invoices, customers, prices, backups, passwords, the license text, or any key.
Nothing was sent anywhere: the owner chooses whether to send this file.

هذا الملف يساعد الدعم الفني على فهم المشكلة. أنشأه المالك أو المدير على جهاز المحل وحفظه في المكان الذي اختاره.
يحتوي على: إصدارات البرنامج وويندوز، إعدادات هذا الجهاز (بدون أسرار)، رقم الترخيص، حالة البرنامج، إصدار البيانات، أسماء ملفات
النسخ الاحتياطي وتواريخها (بدون بيانات)، وآخر جزء من سجلات البرنامج بعد حذف كلمات السر والرموز ونص الترخيص والبريد والهواتف.
لا يحتوي على: قاعدة البيانات أو الفواتير أو العملاء أو الأسعار أو النسخ الاحتياطية أو كلمات السر أو نص الترخيص أو أي مفتاح.
لم يُرسَل شيء إلى أي مكان: المالك هو من يقرر إرسال هذا الملف.
`;

/**
 * Builds the entries of the zip. Everything is injected, so tests can plant secrets everywhere and check none reaches the file.
 * @param {object} o
 * @param {Date} o.now
 * @param {{productName:string,version:string,build:string,builtAt:string|null}} o.edition
 * @param {{ electron?:string, node?:string, chrome?:string, packaged?:boolean }} [o.runtime]
 * @param {object} [o.config]       the config.json object (only allowlisted keys are used)
 * @param {object} [o.status]       state, label, code, message
 * @param {object} [o.license]      licenseId, type, maxClients, issuedAt
 * @param {object} [o.database]     { schemaVersion, appVersion, appBuild } or { error }
 * @param {{ backupsDir:string, autoDir:string, summary:object|null }} [o.backups]
 * @param {object} [o.printSettings]
 * @param {string} [o.logsDir]
 */
function buildDiagnosticsEntries({ now = new Date(), edition, runtime = {}, config, status, license, database, migrations, health, diskFree, backups, printSettings, logsDir }) {
  const entries = [];
  // names: true only for log text; the JSON files are built from an allowlist (their `name` keys are file names and the like)
  const add = (name, value, { names = false } = {}) => entries.push({ name, data: Buffer.from(redactText(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { names }), 'utf8') });

  add('README.txt', README);
  add('info.json', {
    createdAt: now.toISOString(),
    app: { product: edition.productName, version: edition.version, build: edition.build, builtAt: edition.builtAt || null, packaged: Boolean(runtime.packaged) },
    runtime: { electron: runtime.electron || null, node: runtime.node || null, chrome: runtime.chrome || null },
    system: {
      platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model || null,
      totalMemoryMb: Math.round(os.totalmem() / 1048576), freeMemoryMb: Math.round(os.freemem() / 1048576), uptimeHours: Math.round(os.uptime() / 360) / 10,
    },
    disk: diskFree || null,
  });
  add('config.json', pick(config, CONFIG_KEYS));
  add('license.json', pick(license, ['licenseId', 'type', 'maxClients', 'issuedAt', 'shopName']));
  add('status.json', pick(status, ['state', 'label', 'code', 'message']));
  add('database.json', pick(database, ['schemaVersion', 'appVersion', 'appBuild', 'pairedClients', 'knownClients', 'error', 'unavailable']));
  add('backups.json', {
    backups: backups ? listBackupFiles(backups.backupsDir) : [],
    daily: backups ? listBackupFiles(backups.autoDir) : [],
    status: backups && backups.summary ? pick(backups.summary, ['lastBackup', 'lastAuto', 'autoCount', 'keep', 'autoError', 'dataDrive', 'copyFolderSameDrive', 'lastCopy', 'lastExternal', 'externalOverdue', 'schedule', 'lastGood', 'daysSinceGood']) : null,
  });
  add('printing.json', pick(printSettings, PRINT_KEYS));
  add('migrations.json', Array.isArray(migrations) ? migrations : { unavailable: 'the database was not readable' });
  add('health.json', health || { available: false, reason: 'not read' });

  if (logsDir) {
    let names = [];
    try { names = fs.readdirSync(logsDir); } catch { names = []; }
    for (const name of names.filter((entry) => LOG_ALLOWLIST.test(entry)).sort()) {
      try { add(`logs/${name}`, readTail(path.join(logsDir, name)), { names: true }); } catch { /* an unreadable log is left out */ }
    }
  }
  return entries;
}

function buildDiagnosticsZip(input) {
  const now = input.now || new Date();
  return createZip(buildDiagnosticsEntries({ ...input, now }), { date: now });
}

module.exports = { diskFree, LOG_ALLOWLIST, buildDiagnosticsEntries, buildDiagnosticsZip, diagnosticsFileName, readTail };
