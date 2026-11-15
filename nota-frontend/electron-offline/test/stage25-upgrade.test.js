'use strict';

// Stage 25, step B: one version source, the before-upgrade backup protocol between the server and the desktop app, retention exemption.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackendManager, buildBackendEnv } = require('../lib/backend-manager');
const { UPGRADE_PREFIX, SAFETY_PREFIX, BackupService, upgradeBackupName } = require('../lib/backup-service');
const { loadEdition } = require('../lib/edition');

const silentLog = { info() {}, warn() {}, error() {} };
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `nota-${name}-`));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the version comes from package.json only: changing it changes what the app shows, and edition.json carries none', () => {
  const root = tempDir('edition');
  try {
    const electronDir = path.join(root, 'electron-offline');
    fs.mkdirSync(electronDir);
    fs.writeFileSync(path.join(electronDir, 'edition.json'), JSON.stringify({ productName: 'Nota', nameAr: 'نوتة', version: '0.0.1-from-edition' }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    assert.equal(loadEdition({ electronDir }).version, '1.2.0', 'package.json wins; a leftover version in edition.json is ignored');
    assert.equal(loadEdition({ electronDir }).build, 'dev');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.3.1' }));
    fs.writeFileSync(path.join(electronDir, 'build.json'), JSON.stringify({ build: '20261114.0930', builtAt: '2026-11-14T09:30:00Z' }));
    const edition = loadEdition({ electronDir });
    assert.equal(edition.version, '1.3.1');
    assert.equal(edition.build, '20261114.0930');
    assert.equal(edition.full, '1.3.1 (20261114.0930)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'edition.json'), 'utf8'));
  assert.equal('version' in shipped, false, 'edition.json has no version to edit by hand');
  assert.equal(require('../lib/edition').version, require('../../package.json').version, 'the app shows nota-frontend/package.json');
});

test('the stage writes the build number and takes the version from package.json (static check)', () => {
  const stage = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'offline', 'stage.js'), 'utf8');
  assert.match(stage, /version: require\(path\.join\(ROOT, 'package\.json'\)\)\.version/);
  assert.match(stage, /build\.json/);
  const env = buildBackendEnv({ port: 1, mongoUri: 'x', secret: 's', appVersion: '1.0.0', appBuild: '20261114.0930', instanceId: 'i', sourceEnv: {} });
  assert.equal(env.NOTA_APP_VERSION, '1.0.0');
  assert.equal(env.NOTA_APP_BUILD, '20261114.0930');
});

test('before-upgrade backups are named from/to and are never pruned by the safety or daily backup retention', () => {
  const name = upgradeBackupName('1.0.0', '1.1.0', new Date(2026, 10, 14, 9, 5, 7));
  assert.equal(name, 'before-upgrade-1.0.0-1.1.0-2026-11-14_090507.archive.gz');
  assert.equal(upgradeBackupName('schema12', '1.1.0', new Date(2026, 10, 14, 9, 5, 7)).startsWith('before-upgrade-schema12-1.1.0-'), true);
  assert.equal(upgradeBackupName('../../x y', '1.1.0').includes('/'), false);

  const dir = tempDir('retention');
  try {
    const upgrade = path.join(dir, name);
    fs.writeFileSync(upgrade, 'x');
    for (let i = 0; i < 9; i += 1) fs.writeFileSync(path.join(dir, `${SAFETY_PREFIX}2026-11-0${i + 1}_000000.archive.gz`), 'x');
    const service = new BackupService({ mongodbBin: '', port: 1, backupsDir: dir, mongodb: {}, bson: {}, log: silentLog, keepSafety: 5 });
    service.pruneSafetyBackups();
    assert.ok(fs.existsSync(upgrade), 'the before-upgrade backup survives pruning');
    assert.equal(fs.readdirSync(dir).filter((file) => file.startsWith(SAFETY_PREFIX)).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const auto = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auto-backup.js'), 'utf8');
  assert.match(auto, /startsWith\(AUTO_PREFIX\)/, 'the daily backup prunes only its own files');
  assert.equal(UPGRADE_PREFIX, 'before-upgrade-');
});

class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 4242; this.sent = []; this.stdout = null; this.stderr = null; }
  postMessage(message) { this.sent.push(message); }
  kill() { this.emit('exit', 1); }
}

function manager(upgradeBackup) {
  const child = new FakeChild();
  const backend = new BackendManager({ utilityProcess: { fork: () => child }, serverPath: 'x', cwd: '.', env: {}, port: 5000, log: silentLog, output: () => {}, upgradeBackup });
  return { child, backend };
}

test('the server asks for the backup, the app takes it, the server is told to go on, and the start completes', async () => {
  const calls = [];
  const { child, backend } = manager(async (info) => { calls.push(info); });
  const started = backend.start();
  child.emit('message', { type: 'upgrade-backup', fromSchema: 4, toSchema: 12, fromApp: '1.0.0', pending: [5] });
  await wait(20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fromApp, '1.0.0');
  assert.deepEqual(child.sent, [{ type: 'upgrade-backup-result', ok: true }]);
  child.emit('message', { type: 'ready', port: 5000 });
  await started;
});

test('a failed backup tells the server (ar + en) so it stops before migrating; the start fails with the server error', async () => {
  const { child, backend } = manager(async () => { throw Object.assign(new Error('disk full'), { detail: 'ENOSPC' }); });
  const started = backend.start();
  child.emit('message', { type: 'upgrade-backup', fromSchema: 4, toSchema: 12, fromApp: null, pending: [5] });
  await wait(20);
  const reply = child.sent[0];
  assert.equal(reply.ok, false);
  assert.match(reply.message, /تعذر أخذ نسخة احتياطية قبل التحديث/);
  assert.match(reply.message, /backup before the upgrade failed/);
  assert.equal(reply.detail, 'ENOSPC');
  child.emit('message', { type: 'error', code: 'UPGRADE_BACKUP_FAILED', message: reply.message });
  child.emit('exit', 1);
  await assert.rejects(started, (error) => error.code === 'UPGRADE_BACKUP_FAILED' && /backup before the upgrade failed/.test(error.message));
});

test('main.js wires the before-upgrade backup to the backup service with the app version', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /upgradeBackup: async \(info\)/);
  assert.match(main, /createUpgradeBackup\(\{ from, to: EDITION\.version \}\)/);
  assert.match(main, /appBuild: EDITION\.build/);
});

const { parseChangelog, pendingWhatsNew, currentWhatsNew, markWhatsNewSeen } = require('../lib/whats-new');

test('the changelog has a section with an Arabic and an English list for the current version', () => {
  const entries = parseChangelog(fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'));
  const current = entries.find((entry) => entry.version === require('../../package.json').version);
  assert.ok(current, 'CHANGELOG.md has a section for the version in package.json');
  assert.ok(current.ar.length > 0 && current.en.length > 0, 'both languages');
  assert.match(current.date || '', /^\d{4}-\d{2}-\d{2}$/);
});

test('what is new: a brand-new install records the version silently and shows nothing; the dialog shows only after an upgrade from an older recorded version, once', () => {
  const dir = tempDir('whatsnew');
  try {
    const changelogFile = path.join(dir, 'CHANGELOG.md');
    const stateFile = path.join(dir, 'home', 'whats-new.json');
    fs.writeFileSync(changelogFile, '# log\n\n## 1.1.0 - 2026-12-01\n\n### ar\n- جديد\n\n### en\n- new thing\n\n## 1.0.0 - 2026-11-14\n\n### ar\n- قديم\n\n### en\n- old\n');
    // brand-new install: no record yet -> nothing shown, the current version is recorded
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '1.0.0' }), null, 'first run shows nothing');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSeenVersion, '1.0.0', 'and records the version');
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '1.0.0' }), null, 'still nothing on the next start');
    // upgrade 1.0.0 -> 1.1.0
    const first = pendingWhatsNew({ changelogFile, stateFile, version: '1.1.0' });
    assert.deepEqual(first, { version: '1.1.0', date: '2026-12-01', ar: ['جديد'], en: ['new thing'] });
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSeenVersion, '1.0.0', 'recorded only when the user closes the window');
    assert.deepEqual(pendingWhatsNew({ changelogFile, stateFile, version: '1.1.0' }), first, 'still pending until it is closed');
    markWhatsNewSeen({ stateFile, version: '1.1.0' });
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '1.1.0' }), null, 'once');
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '1.1.0' }), null, 'still once');
    assert.equal(currentWhatsNew({ changelogFile, version: '1.1.0' }).en[0], 'new thing', 'the About page can still read it');
    fs.appendFileSync(changelogFile, '\n## 1.2.0 - 2027-01-01\n\n### ar\n- أحدث\n\n### en\n- newest\n');
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '1.2.0' }).en[0], 'newest', 'a newer version shows again');
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '9.9.9' }), null, 'no section, nothing to show');
    assert.equal(pendingWhatsNew({ changelogFile, stateFile, version: '1.0.0' }), null, 'an older build opened on newer-recorded PC shows nothing');
    assert.equal(pendingWhatsNew({ changelogFile: path.join(dir, 'missing.md'), stateFile, version: '1.2.0' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
