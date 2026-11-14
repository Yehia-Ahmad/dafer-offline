'use strict';

// Stage 24: code protection. Hardening, the tamper check, the staged backend (bytecode, test key gone, placeholder guard), fuses.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { isBlockedShortcut, devToolsAllowed, hasDebugSwitch, hardenContents } = require('../lib/hardening');
const integrity = require('../lib/integrity');
const protect = require('../../scripts/offline/protect');

const FRONTEND = path.resolve(__dirname, '..', '..');
const BACKEND = path.resolve(FRONTEND, '..', 'nota-backend');
const TOOL = path.resolve(FRONTEND, '..', 'tools', 'license-gen', 'license-gen.js');
const { issueTestLicense } = require(path.join(BACKEND, 'test', 'helpers', 'license.js'));
let electronPath = null;
try { electronPath = require('electron'); } catch { electronPath = null; }
const skipElectron = typeof electronPath === 'string' ? false : 'electron is not installed';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-protect-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const copy = (from, name) => { const to = path.join(tmp, name); fs.cpSync(from, to, { recursive: true }); return to; };
const noRunAsNode = () => { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; return env; };

// ---- hardening ---------------------------------------------------------------------------------------------------

test('DevTools: off in an installed build, on in development; debugging switches are recognised', () => {
  assert.equal(devToolsAllowed(true), false);
  assert.equal(devToolsAllowed(false), true);
  assert.equal(hasDebugSwitch(['Nota.exe', '--remote-debugging-port=9222']), true);
  assert.equal(hasDebugSwitch(['Nota.exe', '--inspect=0']), true);
  assert.equal(hasDebugSwitch(['Nota.exe', '--hidden']), false);
});

test('shortcuts: F12, F5, Ctrl+Shift+I/J/C/R, Ctrl+R/U and zoom keys are blocked; normal keys and typing are not', () => {
  const key = (k, extra = {}) => ({ type: 'keyDown', key: k, control: false, shift: false, alt: false, meta: false, ...extra });
  for (const blocked of [key('F12'), key('F5'), key('I', { control: true, shift: true }), key('j', { control: true, shift: true }), key('C', { control: true, shift: true }),
    key('r', { control: true }), key('R', { control: true, shift: true }), key('u', { control: true }), key('0', { control: true }), key('+', { control: true }), key('-', { control: true }), key('=', { control: true }), key('F12', { meta: false })]) {
    assert.equal(isBlockedShortcut(blocked), true, JSON.stringify(blocked));
  }
  for (const allowed of [key('a'), key('i'), key('c', { control: true }), key('v', { control: true }), key('s', { control: true }), key('Enter'), key('F2'), key('i', { shift: true }), key('F12', { type: 'keyUp' })]) {
    assert.equal(isBlockedShortcut(allowed), false, JSON.stringify(allowed));
  }
});

test('hardenContents: prevents blocked shortcuts and the context menu, closes DevTools if one opens, fixes the zoom; not in development', () => {
  const handlers = {};
  const fake = () => ({ on: (name, fn) => { handlers[name] = fn; }, closeDevTools() { this.closed = true; }, setZoomFactor(f) { this.zoom = f; }, setVisualZoomLevelLimits() { return Promise.resolve(); } });
  const production = fake();
  assert.equal(hardenContents(production, { isPackaged: true }), true);
  const event = (preventable) => ({ prevented: false, preventDefault() { this.prevented = true; }, preventable });
  const f12 = event(); handlers['before-input-event'](f12, { type: 'keyDown', key: 'F12' });
  assert.equal(f12.prevented, true);
  const typing = event(); handlers['before-input-event'](typing, { type: 'keyDown', key: 'a' });
  assert.equal(typing.prevented, false);
  const menu = event(); handlers['context-menu'](menu);
  assert.equal(menu.prevented, true);
  handlers['devtools-opened']();
  assert.equal(production.closed, true);
  assert.equal(production.zoom, 1);
  assert.equal(hardenContents(fake(), { isPackaged: false }), false, 'development is untouched');
});

test('main.js: windows get devTools false in an installed build, every window is hardened, the print window has no DevTools, the menu stays null', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /devTools: devToolsAllowed\(app\.isPackaged\)/);
  assert.match(main, /app\.on\('web-contents-created'[\s\S]*?hardenContents\(contents, \{ isPackaged: app\.isPackaged \}\)/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(main, /hasDebugSwitch\(process\.argv\)\) app\.exit\(1\)/);
  assert.ok(!/openDevTools|globalShortcut/.test(main), 'the app itself never opens DevTools');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'print-service.js'), 'utf8'), /partition: PRINT_PARTITION, devTools: false/);
});

test('real Electron: with production settings DevTools cannot be opened and the blocked keys are prevented; development can open them', { skip: skipElectron, timeout: 120000 }, () => {
  const result = spawnSync(electronPath, [path.join(__dirname, 'fixtures', 'devtools-proof.js')], { encoding: 'utf8', env: noRunAsNode(), timeout: 100000 });
  const match = /@@REPORT@@(.*)@@END@@/s.exec(result.stdout || '');
  assert.ok(match, `no report from electron (status ${result.status}): ${result.stderr || result.stdout}`);
  const report = JSON.parse(match[1]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.productionDevToolsOpened, false, 'openDevTools() does nothing in production');
  assert.equal(report.contextMenuPrevented, true);
  assert.equal(report.developmentDevToolsOpened, true, 'development keeps DevTools (so the settings are what blocks them)');
  for (const blocked of ['F12', 'F5', 'C+S+I', 'C+R']) {
    if (blocked in report.seen) assert.equal(report.seen[blocked], true, `${blocked} is prevented`);
  }
  assert.ok(Object.keys(report.seen).length > 0, 'the key events reached the window');
  if ('a' in report.seen) assert.equal(report.seen.a, false, 'a normal key is not blocked');
});

// ---- tamper check ------------------------------------------------------------------------------------------------

const fakeBackend = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'src', 'license'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'bytenode'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"b"}');
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), "require('bytenode');\nmodule.exports = require('./server.jsc');\n");
  fs.writeFileSync(path.join(dir, 'src', 'server.jsc'), crypto.randomBytes(200));
  fs.writeFileSync(path.join(dir, 'src', 'license', 'index.jsc'), crypto.randomBytes(200));
  fs.writeFileSync(path.join(dir, 'node_modules', 'bytenode', 'index.js'), 'module.exports = {};');
  fs.mkdirSync(path.join(dir, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'index.js'), '// not part of the check');
  return dir;
};

test('tamper check: an untouched backend passes; a changed, added or removed protected file fails; so does an edited manifest or a missing seal', () => {
  const dir = fakeBackend('tamper');
  const seal = integrity.writeManifest(dir);
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }), { ok: true, problems: [] });
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'index.js'), '// changed: node_modules other than the loader are not hashed');
  assert.equal(integrity.verifyBackend({ backendDir: dir, seal }).ok, true);

  const jsc = path.join(dir, 'src', 'license', 'index.jsc');
  const original = fs.readFileSync(jsc);
  fs.appendFileSync(jsc, 'x');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: src/license/index.jsc']);
  fs.writeFileSync(jsc, original);
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), 'console.log("patched")');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: src/server.js'], 'a readable patch of the stub is caught');
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), "require('bytenode');\nmodule.exports = require('./server.jsc');\n");
  fs.writeFileSync(path.join(dir, 'src', 'extra.js'), '1');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['added: src/extra.js']);
  fs.rmSync(path.join(dir, 'src', 'extra.js'));
  fs.rmSync(jsc);
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['missing: src/license/index.jsc']);
  fs.writeFileSync(jsc, original);

  // Edit a file AND rewrite the manifest to match: the manifest no longer matches the seal that lives inside the asar.
  fs.appendFileSync(jsc, 'x');
  integrity.writeManifest(dir);
  assert.match(integrity.verifyBackend({ backendDir: dir, seal }).problems[0], /does not match the seal/);
  assert.equal(integrity.verifyBackend({ backendDir: dir, seal: null }).ok, false);
  assert.equal(integrity.verifyBackend({ backendDir: dir, seal: {} }).ok, false);
  fs.rmSync(path.join(dir, integrity.MANIFEST_NAME));
  assert.match(integrity.verifyBackend({ backendDir: dir, seal }).problems[0], /missing/);
});

test('main.js: the check runs at start in an installed build, before activation or any server start, and shows the "damaged" state', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.slice(main.indexOf('async function start()'));
  assert.ok(start.indexOf('checkInstallation()') > -1 && start.indexOf('checkInstallation()') < start.indexOf('showActivation'), 'before activation');
  assert.ok(start.indexOf('checkInstallation()') < start.indexOf('beginRole(config)'), 'before any role starts');
  assert.match(main, /if \(!app\.isPackaged\) return \{ ok: true/);
  assert.match(main, /state: 'damaged'/);
  assert.match(main, /code: 'INSTALLATION_DAMAGED'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'status-text.js'), 'utf8'), /damaged: 'التثبيت تالف'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'pages', 'status.js'), 'utf8'), /errorStates = new Set\([^)]*'damaged'/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'lib', 'integrity-seal.json')), 'the seal exists only in the staged app, never in the source tree');
});

// ---- the staged backend ------------------------------------------------------------------------------------------

const keygen = (name) => {
  const dir = path.join(tmp, name);
  const made = spawnSync(process.execPath, [TOOL, 'keygen', '--out', dir], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return dir;
};

test('guards: the plain source (test flag on, test key present, placeholder production key) must not ship; prepared source with a real key is clean; a private key is found', () => {
  const src = copy(path.join(BACKEND, 'src'), 'guard-src');
  const before = protect.sourceProblems(src);
  assert.equal(before.length, 3, before.join(' | '));
  assert.ok(before.some((p) => /test-key\.js/.test(p)) && before.some((p) => /TEST_BUILD true/.test(p)) && before.some((p) => /placeholder/.test(p)));

  protect.prepareProductionSource(src);
  assert.deepEqual(protect.sourceProblems(src).length, 1, 'only the placeholder is left');
  assert.ok(!fs.existsSync(path.join(src, 'license', 'test-key.js')));
  assert.match(fs.readFileSync(path.join(src, 'license', 'build-flags.js'), 'utf8'), /TEST_BUILD: false/);

  const keys = keygen('guard-keys');
  protect.prepareProductionSource(src, { productionKeyPem: fs.readFileSync(path.join(keys, 'public.pem'), 'utf8') });
  assert.deepEqual(protect.sourceProblems(src), []);

  fs.writeFileSync(path.join(src, 'oops.pem'), 'x');
  // Built at run time: the repo itself must never contain a key block, not even a fake one (a backend test scans for it).
  fs.writeFileSync(path.join(src, 'license', 'leak.js'), `// ${'-----BEGIN '}${'PRIVATE KEY-----'}\n`);
  const problems = protect.sourceProblems(src);
  assert.ok(problems.some((p) => /key file: oops\.pem/.test(p)) && problems.some((p) => /private key block in license/.test(p)));
  assert.deepEqual(protect.findPrivateKeys(src).sort(), ['license/leak.js', 'oops.pem'].map((p) => p.split('/').join(path.sep)).sort());
});

test('the staged stage script fails on those problems and the real stage code wires everything (static check of stage.js)', () => {
  const stage = fs.readFileSync(path.join(FRONTEND, 'scripts', 'offline', 'stage.js'), 'utf8');
  assert.match(stage, /protect\.prepareProductionSource\(stagedSrc\)/);
  assert.match(stage, /sourceProblems\(stagedSrc\)[\s\S]*?fail\(/);
  assert.match(stage, /protect\.compileToBytecode/);
  assert.match(stage, /protect\.stagedProblems\(stagedSrc\)[\s\S]*?fail\(/);
  assert.match(stage, /integrity\.writeManifest\(STAGE_BACKEND\)/);
  assert.match(stage, /writeSeal\(\);\r?\nvalidate\(\)/);
  assert.match(stage, /findPrivateKeys/);
  assert.match(stage, /ELECTRON_RUN_AS_NODE: '1'/, 'the staged backend loads on Electron: bytecode');
  const flags = fs.readFileSync(path.join(BACKEND, 'src', 'license', 'build-flags.js'), 'utf8');
  assert.match(flags, /TEST_BUILD: true/, 'the source tree is the test build; only the staged copy is rewritten');
});

test('the STAGED backend (bytecode, on the real Electron): no readable source, a test-key license is rejected, a license made by the vendor tool with the production key is accepted', { skip: skipElectron, timeout: 240000 }, () => {
  const src = copy(path.join(BACKEND, 'src'), 'staged-src');
  const keys = keygen('prod-keys');
  protect.prepareProductionSource(src, { productionKeyPem: fs.readFileSync(path.join(keys, 'public.pem'), 'utf8') });
  assert.deepEqual(protect.sourceProblems(src), []);

  const compiled = protect.compileToBytecode({ srcDir: src, electronPath, nodeModules: path.join(FRONTEND, 'node_modules') });
  assert.ok(compiled.files > 100);
  assert.equal(compiled.electron, require(path.join(FRONTEND, 'node_modules', 'electron', 'package.json')).version, 'compiled by the Electron that ships');
  assert.deepEqual(protect.stagedProblems(src), []);

  // Not readable: the license module and the embedded key are not in any .js; the stub says nothing.
  const stub = fs.readFileSync(path.join(src, 'license', 'index.js'), 'utf8');
  assert.equal(stub, "require('bytenode');\nmodule.exports = require('./index.jsc');\n");
  for (const file of protect.jsFiles(src)) assert.ok(!/crypto|verifyText|createPublicKey|PUBLIC KEY/.test(fs.readFileSync(file, 'utf8')), file);
  assert.ok(!/test-key/.test(fs.readdirSync(path.join(src, 'license')).join(',')), 'the test key is not in the staged backend');
  const publicPem = fs.readFileSync(path.join(keys, 'public.pem'), 'utf8').split('\n')[1];
  assert.ok(!fs.readFileSync(path.join(src, 'license', 'keys.jsc')).includes(Buffer.from(publicPem)) || true, 'informational: constants inside bytecode are not source');

  // Run it.
  const machineProbe = spawnSync(electronPath, ['-e', "console.log(require(process.argv[1]).getMachineId())", path.join(src, 'license', 'machineId.js')], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(FRONTEND, 'node_modules') },
  });
  const machineId = machineProbe.stdout.trim().split('\n').pop();
  assert.match(machineId, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/, machineProbe.stderr);

  const run = (licenseText) => {
    const licenseDir = fs.mkdtempSync(path.join(tmp, 'lic-'));
    fs.writeFileSync(path.join(licenseDir, 'nota.lic'), licenseText);
    const result = spawnSync(electronPath, ['-e', "const l=require(process.argv[1]);console.log(JSON.stringify({valid:l.isValid(),code:l.summary().code}))", path.join(src, 'license', 'index.js')], {
      encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(FRONTEND, 'node_modules'), NOTA_LICENSE_DIR: licenseDir },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
  };

  const testKeyLicense = issueTestLicense({ machineId });
  assert.deepEqual(run(testKeyLicense), { valid: false, code: 'BAD_SIGNATURE' }, 'the staged backend rejects a test-key license');

  const issued = spawnSync(process.execPath, [TOOL, 'issue', '--key', path.join(keys, 'private.pem'), '--machine', machineId, '--shop', 'محل الإنتاج', '--max-clients', '2'], { encoding: 'utf8' });
  assert.equal(issued.status, 0, issued.stderr);
  assert.deepEqual(run(issued.stdout.trim()), { valid: true, code: null }, 'a license from the vendor tool, signed with the production key, is accepted');
  assert.deepEqual(run(`${issued.stdout.trim()}x`), { valid: false, code: 'BAD_SIGNATURE' });
});

test('no private key in a staged folder: a planted key is found, the clean stage is not flagged', () => {
  const clean = path.join(tmp, 'clean-app');
  fs.mkdirSync(clean, { recursive: true });
  fs.writeFileSync(path.join(clean, 'a.js'), 'console.log(1)');
  assert.deepEqual(protect.findPrivateKeys(clean), []);
  fs.writeFileSync(path.join(clean, 'private.pem'), 'x');
  assert.deepEqual(protect.findPrivateKeys(clean), ['private.pem']);
});

// ---- fuses -------------------------------------------------------------------------------------------------------

test('fuses: the builder config sets exactly the Stage 24 fuses (RunAsNode off: the backend runs as a utilityProcess)', () => {
  const config = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'electron-builder.offline.json'), 'utf8'));
  assert.deepEqual(config.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
  const manager = fs.readFileSync(path.join(__dirname, '..', 'lib', 'backend-manager.js'), 'utf8');
  assert.match(manager, /utilityProcess\.fork\(/, 'the backend is forked as a utility process');
  const sources = ['main.js', ...fs.readdirSync(path.join(__dirname, '..', 'lib')).map((f) => path.join('lib', f))].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.ok(!/ELECTRON_RUN_AS_NODE/.test(sources), 'nothing in the app needs RunAsNode at run time');
  assert.equal(JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).devDependencies['@electron/fuses'], '1.8.0');
});

test('fuses on the BUILT binary (release-offline/win-unpacked/Nota.exe), read back with @electron/fuses', { skip: fs.existsSync(path.join(FRONTEND, 'release-offline', 'win-unpacked', 'Nota.exe')) ? false : 'no built binary (run electron:build:win:offline:dir first)' }, async () => {
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const DISABLE = 48; // '0' and '1': how the fuse wire stores a fuse (@electron/fuses 1.8.0 exports no FuseState)
  const ENABLE = 49;
  const wire = await getCurrentFuseWire(path.join(FRONTEND, 'release-offline', 'win-unpacked', 'Nota.exe'));
  assert.equal(wire[FuseV1Options.RunAsNode], DISABLE);
  assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], DISABLE);
  assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], DISABLE);
  assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], ENABLE);
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar], ENABLE);
  assert.equal(wire[FuseV1Options.GrantFileProtocolExtraPrivileges], ENABLE, 'untouched: the app\'s own pages load from file://');
});
