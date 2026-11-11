'use strict';

// Stage 22: financial reports, manual entries, accounts management, period closing. The desktop side of it:
//  - the lock date, the close records and the manual entries live in the database, so a backup (a whole-database dump) and a
//    restore carry them;
//  - the closing day, the reports' periods and "last month" are LOCAL days of the PC, so the desktop app must never force a timezone;
//  - the staged backend must ship what the reports and the closing need (the Excel library and the new modules).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const electron = path.join(root, 'electron-offline');
const backend = path.resolve(root, '..', 'nota-backend');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

test('a backup dumps the whole database and a restore puts all of it back, so a closed period (lock date, close records) and manual entries survive', () => {
  const service = read(electron, 'lib', 'backup-service.js');
  const dump = service.slice(service.indexOf('mongodump.exe'), service.indexOf('mongodump.exe') + 400);
  assert.match(dump, /--archive=/);
  assert.doesNotMatch(dump, /--collection|--excludeCollection|--nsInclude|--nsExclude/, 'no collection is left out of the dump');
  const restore = read(electron, 'lib', 'restore.js');
  assert.match(restore, /--nsInclude=\$\{sourceDb\}\.\*/, 'every collection of the archive is restored');
  assert.doesNotMatch(restore, /--excludeCollection|--nsExclude/);
  // the data the closing keeps is a property of the shop database (meta + the close and draft collections)
  const meta = read(backend, 'src', 'models', 'meta.model.js');
  assert.match(meta, /lockedThrough/);
  assert.ok(fs.existsSync(path.join(backend, 'src', 'models', 'periodClose.model.js')));
  assert.ok(fs.existsSync(path.join(backend, 'src', 'models', 'manualEntryDraft.model.js')));
});

test('the desktop app never forces a timezone: the closing day, the report periods and "last month" are the PC\'s local days', () => {
  const files = [path.join(electron, 'main.js'), ...fs.readdirSync(path.join(electron, 'lib')).filter((name) => name.endsWith('.js')).map((name) => path.join(electron, 'lib', name))];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /process\.env\.TZ\s*=|\bTZ\s*:\s*['"]/, `${path.relative(root, file)} sets a timezone`);
  }
  // the backend reads local time for business days (clock.js), never a fixed zone
  const clock = read(backend, 'src', 'utils', 'clock.js');
  assert.match(clock, /getFullYear\(\), date\.getMonth\(\), date\.getDate\(\)/);
  assert.doesNotMatch(clock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''), /Africa\/Cairo|process\.env\.TZ|timeZone/, 'code, not comments, never names a zone');
});

test('the staged backend ships the Excel library (report exports) and the Stage 22 modules; none of them is excluded or forbidden', () => {
  const pkg = JSON.parse(read(backend, 'package.json'));
  assert.ok(pkg.dependencies.exceljs, 'exceljs is a production dependency of the backend');
  const stage = read(root, 'scripts', 'offline', 'stage.js');
  assert.match(stage, /BACKEND_EXCLUDED_DEPENDENCIES = \[\]/, 'no backend dependency is excluded from the installer');
  const forbidden = JSON.parse(stage.match(/FORBIDDEN_BACKEND_PATHS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const file of ['reports/financial.js', 'reports/excel.js', 'accounting/closing.js', 'accounting/period.js', 'accounting/manualEntry.js', 'controllers/accountAdmin.controller.js', 'controllers/closing.controller.js', 'controllers/manualEntry.controller.js', 'controllers/reports.controller.js', 'routes/reports.routes.js']) {
    assert.ok(fs.existsSync(path.join(backend, 'src', file)), `${file} exists`);
    assert.ok(!forbidden.some((entry) => file.split('/').includes(entry)), `${file} is not under a forbidden path`);
  }
});

test('the posting lock is a backend rule, not a desktop one: the Electron main process has no period-closing code (the UI hides, the backend enforces)', () => {
  const sources = [path.join(electron, 'main.js'), path.join(electron, 'preload.js'), ...fs.readdirSync(path.join(electron, 'lib')).map((name) => path.join(electron, 'lib', name))]
    .filter((file) => file.endsWith('.js')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(sources, /lockedThrough|PERIOD_LOCKED|closing\/close/, 'no lock logic in the main process');
  // and every posting path of the backend that a desktop page can reach is behind the lock check
  const postEntry = read(backend, 'src', 'accounting', 'posting.js');
  assert.match(postEntry, /assertOpenDate\(date, \{ session \}\)/);
});
