'use strict';

// Stage 24 (Electron side): the main process's license gate, the activation page contract, the client's "main isn't activated" answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLicenseGate, MAX_LICENSE_BYTES } = require('../lib/license-gate');
const { buildBackendEnv } = require('../lib/backend-manager');
const { probeServer } = require('../lib/client-link');
const { layout } = require('../lib/paths');
const { statusLabel } = require('../lib/status-text');

const BACKEND = path.resolve(__dirname, '..', '..', '..', 'nota-backend');
const { issueTestLicense } = require(path.join(BACKEND, 'test', 'helpers', 'license.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-gate-'));
const savedDir = process.env.NOTA_LICENSE_DIR;
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.NOTA_LICENSE_DIR; else process.env.NOTA_LICENSE_DIR = savedDir;
  require(path.join(BACKEND, 'src', 'license')).resetForTests();
});

const newGate = (name) => {
  const licenseDir = path.join(tmp, name);
  fs.mkdirSync(licenseDir, { recursive: true });
  require(path.join(BACKEND, 'src', 'license')).resetForTests();
  return { licenseDir, gate: createLicenseGate({ licenseDir, loadModule: () => require(path.join(BACKEND, 'src', 'license')), log: { info() {}, warn() {} } }) };
};

test('no license: the gate says not licensed and shows this PC\'s Machine ID (the activation screen needs it)', () => {
  const { gate } = newGate('none');
  const status = gate.status();
  assert.equal(status.licensed, false);
  assert.equal(status.code, 'NO_LICENSE');
  assert.match(status.machineId, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
});

test('activation: a wrong license is refused with its reason and writes nothing; a right one is stored in <license dir>/nota.lic', () => {
  const { gate, licenseDir } = newGate('activate');
  assert.deepEqual(gate.activate('garbage'), { ok: false, code: 'MALFORMED' });
  assert.deepEqual(gate.activate(issueTestLicense({ machineId: 'AAAA-BBBB-CCCC-DDDD' })), { ok: false, code: 'WRONG_MACHINE' });
  assert.ok(!fs.existsSync(path.join(licenseDir, 'nota.lic')));
  assert.equal(gate.status().licensed, false);

  const done = gate.activate(issueTestLicense({ shopName: 'محل النور', shopNameEn: 'Al Nour' }));
  assert.equal(done.ok, true);
  assert.equal(done.shopName, 'محل النور');
  assert.equal(done.shopNameEn, 'Al Nour');
  assert.ok(fs.existsSync(path.join(licenseDir, 'nota.lic')));
  assert.equal(gate.status().licensed, true, 're-verified from the file');
});

test('the file is the source of truth: deleting or editing nota.lic un-licenses the gate (re-verified on every status call)', () => {
  const { gate, licenseDir } = newGate('truth');
  assert.equal(gate.activate(issueTestLicense({})).ok, true);
  const file = path.join(licenseDir, 'nota.lic');
  const text = fs.readFileSync(file, 'utf8');
  const [a, payload, sig] = text.split('.');
  const edited = JSON.parse(Buffer.from(payload, 'base64url'));
  edited.maxClients = 999;
  fs.writeFileSync(file, `${a}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`);
  assert.equal(gate.status().code, 'BAD_SIGNATURE');
  fs.rmSync(file);
  assert.equal(gate.status().code, 'NO_LICENSE');
});

test('activating from a nota.lic file works; an unreadable or oversized file is refused', () => {
  const { gate } = newGate('file');
  const file = path.join(tmp, 'picked.lic');
  fs.writeFileSync(file, `${issueTestLicense({ shopName: 'من ملف' })}\n`);
  assert.equal(gate.activateFile(file).shopName, 'من ملف');
  assert.deepEqual(gate.activateFile(path.join(tmp, 'missing.lic')), { ok: false, code: 'UNREADABLE' });
  const big = path.join(tmp, 'big.lic');
  fs.writeFileSync(big, 'x'.repeat(MAX_LICENSE_BYTES + 1));
  assert.equal(gate.activateFile(big).code, 'MALFORMED');
  assert.equal(gate.activate('x'.repeat(MAX_LICENSE_BYTES + 1)).code, 'MALFORMED');
});

test('the backend gets the license folder; the home layout has license/ and the EULA record', () => {
  const env = buildBackendEnv({ port: 5055, mongoUri: 'mongodb://127.0.0.1:1/x', secret: 's', jwtSecret: 'j', appVersion: '1', instanceId: 'i', licenseDir: 'C:\\x\\license', sourceEnv: {} });
  assert.equal(env.NOTA_LICENSE_DIR, 'C:\\x\\license');
  assert.equal('NOTA_LICENSE_DIR' in buildBackendEnv({ port: 1, mongoUri: 'm', secret: 's', appVersion: '1', instanceId: 'i', sourceEnv: {} }), false);
  const l = layout(path.join('C:', 'ProgramData', 'Nota'));
  assert.equal(l.license, path.join('C:', 'ProgramData', 'Nota', 'license'));
  assert.equal(l.eula, path.join('C:', 'ProgramData', 'Nota', 'eula.json'));
});

test('a client PC sees "not activated" when the main PC answers 402 LICENSE_REQUIRED', async () => {
  const reply = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });
  const target = { host: '10.0.0.5', port: 5055, secret: 'k' };
  assert.equal((await probeServer({ ...target, fetchImpl: reply(402, { code: 'LICENSE_REQUIRED' }) })).status, 'not-activated');
  assert.equal((await probeServer({ ...target, fetchImpl: reply(401, { code: 'LAN_KEY_INVALID' }) })).status, 'unauthorized');
  assert.equal((await probeServer({ ...target, fetchImpl: reply(402, { code: 'SOMETHING_ELSE' }) })).status, 'not-nota', 'only the license code counts');
  assert.ok(statusLabel({ state: 'not-activated' }).includes('غير مفعّل'));
});

test('activation page: strict CSP, no inline script, every state of the copy exists in Arabic and English, every error code has both messages', () => {
  const pages = path.join(__dirname, '..', 'pages');
  const html = fs.readFileSync(path.join(pages, 'activation.html'), 'utf8');
  assert.match(html, /Content-Security-Policy[^>]*script-src 'self'/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
  assert.ok(!/\sonclick=|\sstyle=/.test(html), 'no inline handlers or styles (the CSP forbids them)');
  const js = fs.readFileSync(path.join(pages, 'activation.js'), 'utf8');
  const block = (lang) => js.slice(js.indexOf(`${lang}: {`), js.indexOf(lang === 'ar' ? 'en: {' : 'let lang'));
  const keys = (text) => [...text.matchAll(/^\s{6}([A-Za-z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys(block('ar')), keys(block('en')), 'same keys in both languages');
  const dataKeys = [...html.matchAll(/data-t="([A-Za-z]+)"/g)].map((m) => m[1]);
  for (const key of dataKeys) assert.ok(keys(block('ar')).includes(key) && keys(block('en')).includes(key), `copy for ${key}`);
  for (const code of ['MALFORMED', 'BAD_SIGNATURE', 'WRONG_MACHINE', 'UNKNOWN_TYPE', 'UNKNOWN_VERSION', 'NO_MACHINE_ID', 'UNREADABLE']) {
    assert.equal((js.match(new RegExp(`${code}:`, 'g')) || []).length, 2, `${code} in both languages`);
  }
  assert.ok(/id="machine-id"/.test(html) && /id="copy"/.test(html) && /id="license-text"/.test(html) && /id="load-file"/.test(html));
});

test('main.js: activation comes before the role choice and before any main-PC start; clients are not gated', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /if \(!config\) \{[\s\S]*?showActivation\(\{ canSkip: true/, 'first run: activation, with a client skip');
  assert.match(main, /config\.role === 'main' && !licenseGate\(\)\.status\(\)\.licensed[\s\S]*?showActivation/, 'a main PC without a license never starts');
  assert.ok(!/role === 'client' && !licenseGate/.test(main), 'client PCs need no license');
  // the activation IPC answers only while the screen shows
  for (const channel of ['info', 'activate', 'load-file', 'copy-machine-id', 'skip-client', 'finish']) assert.ok(main.includes(`'activation:${channel}'`), channel);
  assert.ok((main.match(/state\.mode === 'activation'|active\(\)/g) || []).length >= 6);
});
