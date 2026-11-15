'use strict';

// Stage 25, step C: the diagnostics file. Secrets are planted EVERYWHERE a shop's PC has them (security folder, license, config, logs,
// backups, print settings); none may reach the zip. Permission: owner / manager only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createZip, readZip, crc32 } = require('../lib/zip-writer');
const { redactText } = require('../lib/redact');
const { buildDiagnosticsEntries, buildDiagnosticsZip, diagnosticsFileName } = require('../lib/diagnostics');
const { createDiagnosticsHandlers } = require('../lib/diagnostics-handlers');
const { IPC_RULES } = require('../lib/ipc-guard');

const silentLog = { info() {}, warn() {}, error() {} };
const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `nota-${name}-`));

// ------------------------------------------------------------------ the zip writer

test('zip writer: files come back byte for byte (Arabic names, empty files, binary, compressible text) with the right checksums', () => {
  const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256));
  const entries = [
    { name: 'a.txt', data: 'hello hello hello hello hello hello' },
    { name: 'مجلد/ملف.txt', data: 'نص عربي '.repeat(500) },
    { name: 'empty.log', data: '' },
    { name: 'bin/data.bin', data: binary },
  ];
  const files = readZip(createZip(entries));
  assert.deepEqual(files.map((file) => file.name), entries.map((entry) => entry.name));
  assert.equal(files[0].data.toString(), 'hello hello hello hello hello hello');
  assert.equal(files[1].data.toString(), 'نص عربي '.repeat(500));
  assert.equal(files[2].data.length, 0);
  assert.ok(files[3].data.equals(binary));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'the standard CRC-32 check value');
  assert.throws(() => createZip([{ name: '../evil.txt', data: 'x' }]), /bad zip entry name/);
  assert.throws(() => createZip([{ name: '/abs.txt', data: 'x' }]) && createZip([{ name: 'a//b', data: 'x' }]), /bad zip entry name/);
});

test('zip writer: an independent reader (Windows tar, or unzip when present) opens the file and sees the same content', (t) => {
  const dir = tempDir('zip');
  try {
    const zipFile = path.join(dir, 'x.zip');
    fs.writeFileSync(zipFile, createZip([{ name: 'one.txt', data: 'first file\n'.repeat(100) }, { name: 'logs/two.log', data: 'second' }]));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    let result = spawnSync('tar', ['-xf', zipFile, '-C', out], { encoding: 'utf8' });
    if (result.error || result.status !== 0) result = spawnSync('unzip', ['-o', zipFile, '-d', out], { encoding: 'utf8' });
    if (result.error || result.status !== 0) { t.skip('no tar/unzip on this machine'); return; }
    assert.equal(fs.readFileSync(path.join(out, 'one.txt'), 'utf8'), 'first file\n'.repeat(100));
    assert.equal(fs.readFileSync(path.join(out, 'logs', 'two.log'), 'utf8'), 'second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ redaction

const PLANTED = {
  password: 'Sup3rS3cretPass',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  hex: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  license: 'NOTA1.eyJsaWNlbnNlSWQiOiJOT1RBLVNFQ1JFVCJ9.c2lnbmF0dXJlLWJ5dGVzLXNlY3JldA',
  mongo: 'mongodb://nota_app:Mongo-Pa55w0rd@127.0.0.1:27217/nota',
  email: 'owner.private@example.com',
  phone: '01012345678',
  phoneIntl: '+20 100 123 4567',
  blob: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm',
  // built at run time: the repo itself must never contain a key block, not even a fake one (a backend test scans for it)
  pem: `-----${'BEGIN'} PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPLANTEDSECRETKEYMATERIAL\n-----${'END'} PRIVATE KEY-----`,
};

test('redaction removes every planted secret and personal detail, and keeps what support needs (dates, IPs, versions, ports, messages)', () => {
  const lines = [
    `login failed password=${PLANTED.password} for user ali`,
    `{"password":"${PLANTED.password}","username":"ali"}`,
    `Authorization: Bearer ${PLANTED.jwt}`,
    `token ${PLANTED.jwt}`,
    `lan key ${PLANTED.hex}`,
    `license ${PLANTED.license}`,
    `connecting ${PLANTED.mongo}`,
    `contact ${PLANTED.email} or ${PLANTED.phone} or ${PLANTED.phoneIntl}.`,
    `dpapi ${PLANTED.blob}`,
    PLANTED.pem,
    'path C:\\Users\\Ahmed\\AppData\\Local\\Nota',
    '--password hunter2 --keyFile D:\\x\\keyfile',
    'recoveryCode: ABCD-EFGH-1234',
  ].join('\n');
  const out = redactText(lines);
  for (const [name, secret] of Object.entries(PLANTED)) {
    assert.ok(!out.includes(secret.split('\n')[1] || secret), `${name} is gone`);
  }
  for (const gone of ['hunter2', 'Ahmed', 'ABCD-EFGH-1234', 'Mongo-Pa55w0rd', 'nota_app']) assert.ok(!out.includes(gone), `${gone} is gone`);
  assert.match(out, /C:\\Users\\\[user\]\\AppData/);

  const keep = '2026-11-14T21:46:28.953Z [info] app 1.0.0 build 20261114.2346 backend on 192.168.1.10:5055 port 5055 started in 1523 ms; reached 192.168.1.10.';
  assert.equal(redactText(keep), keep);
});

// ------------------------------------------------------------------ the collector (allowlist)

function plantHome() {
  const home = tempDir('diag-home');
  const logs = path.join(home, 'logs');
  const security = path.join(home, 'security');
  const backups = path.join(home, 'backups');
  const auto = path.join(backups, 'auto');
  const license = path.join(home, 'license');
  for (const dir of [logs, security, backups, auto, license]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(security, 'db-app.dpapi'), `DPAPI-BLOB-${PLANTED.blob}`);
  fs.writeFileSync(path.join(security, 'keyfile'), 'KEYFILE-SECRET-CONTENT-0000');
  fs.writeFileSync(path.join(license, 'nota.lic'), PLANTED.license);
  fs.writeFileSync(path.join(home, 'eula.json'), '{"acceptedBy":"private-owner-name"}');
  fs.writeFileSync(path.join(logs, 'app.log'), [`2026-11-14T10:00:00.000Z [info] [main] starting`, `login password=${PLANTED.password}`, `jwt ${PLANTED.jwt}`, `owner ${PLANTED.email} ${PLANTED.phone}`, `lan ${PLANTED.hex}`].join('\n'));
  fs.writeFileSync(path.join(logs, 'backend.log'), `[backend] ${PLANTED.mongo}\n[backend] license ${PLANTED.license}\n`);
  fs.writeFileSync(path.join(logs, 'secrets.log'), 'NOT-ON-THE-ALLOWLIST-SECRET');
  fs.writeFileSync(path.join(logs, 'backend.log.9'), 'NOT-A-ROTATION-ON-THE-ALLOWLIST');
  fs.writeFileSync(path.join(backups, 'before-upgrade-1.0.0-1.1.0-2026-11-14_090507.archive.gz'), 'ARCHIVE-BYTES-WITH-CUSTOMER-DATA');
  fs.writeFileSync(path.join(auto, 'nota-auto-backup-2026-11-14_020000.archive.gz'), 'AUTO-ARCHIVE-BYTES');
  return home;
}

const input = (home) => ({
  now: new Date(2026, 10, 14, 12, 0, 0),
  edition: { productName: 'Nota', version: '1.0.0', build: '20261114.2346', builtAt: '2026-11-14T21:46:28Z' },
  runtime: { electron: '35.7.5', node: '22.14.0', chrome: '134', packaged: true },
  config: {
    schemaVersion: 1, role: 'main', port: 5055, instanceId: 'inst-1234', startWithWindows: true,
    lanSecretProtected: `PROTECTED-LAN-SECRET-${PLANTED.blob}`, jwtSecret: PLANTED.hex, password: PLANTED.password, shopName: 'محل خاص', phone: PLANTED.phone,
  },
  status: { state: 'running', label: 'يعمل', code: null, message: null, token: PLANTED.jwt },
  license: { licenseId: 'NOTA-ABC123', type: 'lifetime', maxClients: 3, issuedAt: '2026-05-01', machineId: 'AAAA-BBBB', shopName: 'محل خاص', licenseText: PLANTED.license },
  database: { schemaVersion: 12, appVersion: '1.0.0', appBuild: '20261114.2346', licenseText: PLANTED.license },
  backups: { backupsDir: path.join(home, 'backups'), autoDir: path.join(home, 'backups', 'auto'), summary: { autoCount: 1, keep: 14, passwordHint: PLANTED.password } },
  printSettings: { receiptPrinter: 'XP-80', receiptCopies: 1, apiKey: PLANTED.hex },
  logsDir: path.join(home, 'logs'),
});

test('the diagnostics zip holds only allowlisted files and not one planted secret (security folder, license, config, logs, backups)', () => {
  const home = plantHome();
  try {
    const zip = buildDiagnosticsZip(input(home));
    const files = readZip(zip);
    const names = files.map((file) => file.name);
    assert.deepEqual(names, ['README.txt', 'info.json', 'config.json', 'license.json', 'status.json', 'database.json', 'backups.json', 'printing.json', 'logs/app.log', 'logs/backend.log']);
    const everything = files.map((file) => file.data.toString('utf8')).join('\n');
    for (const secret of [
      PLANTED.password, PLANTED.jwt, PLANTED.hex, PLANTED.license, 'Mongo-Pa55w0rd', PLANTED.email, PLANTED.phone, PLANTED.blob,
      'DPAPI-BLOB', 'KEYFILE-SECRET', 'PROTECTED-LAN-SECRET', 'private-owner-name', 'NOT-ON-THE-ALLOWLIST', 'NOT-A-ROTATION', 'ARCHIVE-BYTES', 'محل خاص', 'AAAA-BBBB',
    ]) assert.ok(!everything.includes(secret), `${secret} must not be in the diagnostics file`);
    assert.ok(!zip.includes(Buffer.from(PLANTED.password)), 'not even inside the compressed bytes');

    const byName = Object.fromEntries(files.map((file) => [file.name, file.data.toString('utf8')]));
    assert.equal(JSON.parse(byName['info.json']).app.version, '1.0.0');
    assert.equal(JSON.parse(byName['info.json']).app.build, '20261114.2346');
    assert.deepEqual(JSON.parse(byName['config.json']), { schemaVersion: 1, role: 'main', port: 5055, instanceId: 'inst-1234', startWithWindows: true });
    assert.deepEqual(JSON.parse(byName['license.json']), { licenseId: 'NOTA-ABC123', type: 'lifetime', maxClients: 3, issuedAt: '2026-05-01' });
    assert.deepEqual(JSON.parse(byName['database.json']), { schemaVersion: 12, appVersion: '1.0.0', appBuild: '20261114.2346' });
    const backups = JSON.parse(byName['backups.json']);
    assert.deepEqual(backups.backups.map((entry) => entry.name), ['before-upgrade-1.0.0-1.1.0-2026-11-14_090507.archive.gz']);
    assert.deepEqual(backups.daily.map((entry) => entry.name), ['nota-auto-backup-2026-11-14_020000.archive.gz']);
    assert.deepEqual(JSON.parse(byName['printing.json']), { receiptPrinter: 'XP-80', receiptCopies: 1 });
    assert.match(byName['logs/app.log'], /login password= "\[removed\]"/);
    assert.match(byName['logs/app.log'], /starting/, 'the log keeps its useful lines');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a big log is cut to its tail (the newest lines) and says so', () => {
  const home = tempDir('diag-big');
  try {
    fs.mkdirSync(path.join(home, 'logs'));
    fs.writeFileSync(path.join(home, 'logs', 'app.log'), `${'old line\n'.repeat(200000)}THE-NEWEST-LINE\n`);
    const entries = buildDiagnosticsEntries({ edition: { productName: 'Nota', version: '1', build: 'dev' }, logsDir: path.join(home, 'logs') });
    const log = entries.find((entry) => entry.name === 'logs/app.log').data.toString('utf8');
    assert.ok(log.length < 450 * 1024);
    assert.match(log, /earlier bytes not included/);
    assert.match(log, /THE-NEWEST-LINE/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the file name is nota-diagnostics-<licenseId>-<date>.zip and a hostile license id cannot change the path', () => {
  const date = new Date(2026, 10, 14);
  assert.equal(diagnosticsFileName('NOTA-ABC123', date), 'nota-diagnostics-NOTA-ABC123-2026-11-14.zip');
  assert.equal(diagnosticsFileName(undefined, date), 'nota-diagnostics-unlicensed-2026-11-14.zip');
  assert.equal(diagnosticsFileName('..\\..\\x/y z', date), 'nota-diagnostics-xyz-2026-11-14.zip');
});

test('the collector never touches the security folder, the license file, eula.json or the database folder (static check)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'diagnostics.js'), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
  for (const forbidden of [/paths\.security/, /\bsecurity['"/\\]/, /nota\.lic/, /eula/, /dbPath/, /secret-store/, /safeStorage/]) assert.ok(!forbidden.test(source), `diagnostics.js must not reference ${forbidden}`);
});

// ------------------------------------------------------------------ the handler (permission)

function handlers({ permissions, saveTo }) {
  const calls = { collect: 0, choose: 0 };
  const deps = {
    backend: () => ({
      me: async (token) => {
        if (token === 'expired-token-0000') { const error = new Error('x'); error.code = 'SESSION_EXPIRED'; throw Object.assign(error, { name: 'GuardError' }); }
        return { user: { username: 'manager' }, permissions };
      },
    }),
    collect: async () => { calls.collect += 1; return { zip: createZip([{ name: 'a.txt', data: 'x' }]), fileName: 'nota-diagnostics-NOTA-1-2026-11-14.zip' }; },
    chooseSavePath: async () => { calls.choose += 1; return saveTo; },
    log: silentLog,
  };
  return { call: createDiagnosticsHandlers(deps)['diagnostics:export'], calls };
}

test('only an owner or manager (shop.manage) can export: a cashier is FORBIDDEN and nothing is collected or written', async () => {
  assert.equal(IPC_RULES['diagnostics:export'], 'shop.manage');
  const dir = tempDir('diag-ipc');
  try {
    const target = path.join(dir, 'out.zip');
    const cashier = handlers({ permissions: ['sales.create'], saveTo: target });
    const refused = await cashier.call('valid-session-token-123');
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'FORBIDDEN');
    assert.equal(cashier.calls.collect, 0);
    assert.equal(cashier.calls.choose, 0);
    assert.equal(fs.existsSync(target), false);

    const noToken = await handlers({ permissions: ['shop.manage'], saveTo: target }).call(undefined);
    assert.equal(noToken.error.code, 'SESSION_EXPIRED');
    assert.equal(fs.existsSync(target), false);

    const manager = handlers({ permissions: ['shop.manage'], saveTo: target });
    const done = await manager.call('valid-session-token-123');
    assert.equal(done.ok, true);
    assert.equal(done.value.path, target);
    assert.equal(readZip(fs.readFileSync(target))[0].name, 'a.txt');
    assert.equal(fs.existsSync(`${target}.partial`), false);

    const cancelled = await handlers({ permissions: ['shop.manage'], saveTo: null }).call('valid-session-token-123');
    assert.deepEqual(cancelled, { ok: true, value: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main.js registers the export and the preload exposes it; the manager route is guarded', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /registerDiagnosticsIpc\(\);/);
  assert.match(main, /createDiagnosticsHandlers\(/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /diagnostics:export/);
});
