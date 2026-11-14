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

test('debug switches: Chromium accepts -, -- and / in front and any letter case; so does the guard (and it asks app.commandLine too)', () => {
  for (const arg of ['--remote-debugging-port=9222', '-remote-debugging-port=9222', '/remote-debugging-port=9222', '--REMOTE-DEBUGGING-PORT=9222', '-Remote-Debugging-Port=1', '/REMOTE-DEBUGGING-PIPE', '--remote-debugging-pipe', '--inspect', '-inspect=9229', '/INSPECT-BRK=9229', '--inspect-brk', '--debug', '-debug-port=5858']) {
    assert.equal(hasDebugSwitch(['Nota.exe', arg]), true, arg);
  }
  for (const arg of ['--hidden', '--quit', '--quit-all', '-hidden', '/hidden', 'C:\\inspect\\x', 'remote-debugging-port', '--no-sandbox']) assert.equal(hasDebugSwitch(['Nota.exe', arg]), false, arg);
  // what Chromium itself parsed, whatever the spelling
  const fakeCommandLine = (...present) => ({ hasSwitch: (name) => present.includes(name) });
  for (const name of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk']) assert.equal(hasDebugSwitch(['Nota.exe'], fakeCommandLine(name)), true, name);
  assert.equal(hasDebugSwitch(['Nota.exe'], fakeCommandLine()), false);
  assert.equal(hasDebugSwitch(['Nota.exe'], fakeCommandLine('hidden')), false);
  assert.equal(hasDebugSwitch(undefined, undefined), false);
});

test('real Electron: with a debugging switch (any spelling) the app exits at once and the port NEVER opens; without the guard the same switch opens it', { skip: skipElectron, timeout: 240000 }, async () => {
  const net = require('node:net');
  const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const fixture = path.join(__dirname, 'fixtures', 'debug-switch-proof.js');
  // Watches the port from before the process starts until it exits: did it EVER accept a connection?
  const run = async (arg, guard) => {
    const port = await freePort();
    const child = require('node:child_process').spawn(electronPath, [fixture, arg.replace('%PORT%', String(port))], { windowsHide: true, stdio: 'ignore', env: { ...noRunAsNode(), NOTA_PROOF_GUARD: guard ? '1' : '0' } });
    let opened = false; let exitCode = null;
    child.once('exit', (code) => { exitCode = code; });
    while (exitCode === null) {
      await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => { opened = true; socket.destroy(); resolve(); });
        socket.once('error', () => resolve());
        socket.setTimeout(100, () => { socket.destroy(); resolve(); });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { opened, exitCode };
  };
  // Lower case: Chromium opens the port for each spelling, so the control proves the test means something. Upper case: Chromium itself may
  // ignore it, but the guard blocks it all the same (a switch must never be let through on a technicality of spelling).
  const variants = [['--remote-debugging-port=%PORT%', true], ['-remote-debugging-port=%PORT%', true], ['/remote-debugging-port=%PORT%', true], ['--REMOTE-DEBUGGING-PORT=%PORT%', false], ['/Remote-Debugging-Port=%PORT%', false]];
  for (const [arg, chromiumOpensIt] of variants) {
    const guarded = await run(arg, true);
    assert.deepEqual(guarded, { opened: false, exitCode: 1 }, `${arg}: the app exited and the port never opened`);
    const control = await run(arg, false);
    assert.equal(control.exitCode, 0, arg);
    if (chromiumOpensIt) assert.equal(control.opened, true, `${arg}: without the guard Chromium opens the port (so the guarded result above proves something)`);
  }
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
  assert.match(main, /hasDebugSwitch\(process\.argv, app\.commandLine\)\) app\.exit\(1\)/);
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
  fs.mkdirSync(path.join(dir, 'node_modules', 'express', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'mongodb'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"b"}');
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), "require('bytenode');\nmodule.exports = require('./server.jsc');\n");
  fs.writeFileSync(path.join(dir, 'src', 'server.jsc'), crypto.randomBytes(200));
  fs.writeFileSync(path.join(dir, 'src', 'license', 'index.jsc'), crypto.randomBytes(200));
  fs.writeFileSync(path.join(dir, 'node_modules', 'bytenode', 'index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'index.js'), "module.exports = require('./lib/express');");
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'lib', 'express.js'), 'module.exports = function express() {};');
  fs.writeFileSync(path.join(dir, 'node_modules', 'mongodb', 'index.js'), 'module.exports = {};'); // the main process loads this one from the backend folder
  return dir;
};

test('tamper check: an untouched backend passes; a changed, added or removed file ANYWHERE in the backend folder fails (src, node_modules, package.json); so does an edited manifest or a missing seal', () => {
  const dir = fakeBackend('tamper');
  const seal = integrity.writeManifest(dir);
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }), { ok: true, problems: [] });
  // everything is in the manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, integrity.MANIFEST_NAME), 'utf8')).files;
  assert.deepEqual(Object.keys(manifest).sort(), ['node_modules/bytenode/index.js', 'node_modules/express/index.js', 'node_modules/express/lib/express.js', 'node_modules/mongodb/index.js', 'package.json', 'src/license/index.jsc', 'src/server.jsc', 'src/server.js'].sort());

  // THE REVIEWER'S ATTACK: patch a dependency the backend loads so it replaces crypto.verify
  const express = path.join(dir, 'node_modules', 'express', 'index.js');
  const originalExpress = fs.readFileSync(express);
  fs.writeFileSync(express, "require('crypto').verify = () => true;\nmodule.exports = require('./lib/express');");
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: node_modules/express/index.js'], 'a patched dependency = damaged');
  fs.writeFileSync(express, originalExpress);
  // a file added to a dependency (a new module that gets required, a .node, a .json)
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'evil.js'), 'require("crypto").verify = () => true;');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['added: node_modules/express/evil.js']);
  fs.rmSync(path.join(dir, 'node_modules', 'express', 'evil.js'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'brand-new'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'brand-new', 'index.js'), '1');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['added: node_modules/brand-new/index.js'], 'a whole new package');
  fs.rmSync(path.join(dir, 'node_modules', 'brand-new'), { recursive: true });
  // what the main process loads from the backend folder (the MongoDB driver) is covered by the same hash
  const mongo = path.join(dir, 'node_modules', 'mongodb', 'index.js');
  fs.appendFileSync(mongo, '// x');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: node_modules/mongodb/index.js']);
  fs.writeFileSync(mongo, 'module.exports = {};');
  // package.json (the dependency list and the "main")
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"b","main":"evil.js"}');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: package.json']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"b"}');
  assert.equal(integrity.verifyBackend({ backendDir: dir, seal }).ok, true, 'put back = fine again');

  const jsc = path.join(dir, 'src', 'license', 'index.jsc');
  const original = fs.readFileSync(jsc);
  fs.appendFileSync(jsc, 'x');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: src/license/index.jsc']);
  fs.writeFileSync(jsc, original);
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), 'console.log("patched")');
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['changed: src/server.js'], 'a readable patch of the stub is caught');
  fs.writeFileSync(path.join(dir, 'src', 'server.js'), "require('bytenode');\nmodule.exports = require('./server.jsc');\n");
  fs.rmSync(jsc);
  assert.deepEqual(integrity.verifyBackend({ backendDir: dir, seal }).problems, ['missing: src/license/index.jsc']);
  fs.writeFileSync(jsc, original);

  // Edit a file AND rewrite the manifest to match: the manifest no longer matches the seal that lives inside the asar.
  fs.appendFileSync(express, '\n//patched');
  integrity.writeManifest(dir);
  assert.match(integrity.verifyBackend({ backendDir: dir, seal }).problems[0], /does not match the seal/);
  assert.equal(integrity.verifyBackend({ backendDir: dir, seal: null }).ok, false);
  assert.equal(integrity.verifyBackend({ backendDir: dir, seal: {} }).ok, false);
  fs.rmSync(path.join(dir, integrity.MANIFEST_NAME));
  assert.match(integrity.verifyBackend({ backendDir: dir, seal }).problems[0], /missing/);
});

test('the REAL staged backend folder (offline-stage/backend, if staged): everything is hashed, a patched express or an added file in node_modules fails, and the hashing time is measured', { skip: fs.existsSync(path.join(FRONTEND, 'offline-stage', 'backend', 'node_modules', 'express', 'index.js')) ? false : 'no staged backend (run offline:stage first)', timeout: 180000 }, async () => {
  const staged = path.join(FRONTEND, 'offline-stage', 'backend');
  const copyDir = path.join(tmp, 'real-stage-copy');
  fs.cpSync(staged, copyDir, { recursive: true });
  let started = process.hrtime.bigint();
  const seal = integrity.writeManifest(copyDir);
  const buildMs = Number(process.hrtime.bigint() - started) / 1e6;
  const manifest = JSON.parse(fs.readFileSync(path.join(copyDir, integrity.MANIFEST_NAME), 'utf8')).files;
  const count = Object.keys(manifest).length;
  assert.ok(count > 1000, `the whole folder: ${count} files`);
  assert.ok(Object.keys(manifest).some((key) => key.startsWith('node_modules/express/')) && Object.keys(manifest).some((key) => key.startsWith('node_modules/mongodb/')) && 'package.json' in manifest && 'src/server.jsc' in manifest);

  started = process.hrtime.bigint();
  const clean = integrity.verifyBackend({ backendDir: copyDir, seal });
  const verifyMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(clean, { ok: true, problems: [] });
  console.log(`[integrity] real staged backend: ${count} files, hashing for the manifest ${buildMs.toFixed(0)} ms, the start-up check ${verifyMs.toFixed(0)} ms`);
  assert.ok(verifyMs < 15000, `the start-up check took ${verifyMs} ms`);
  started = process.hrtime.bigint();
  assert.deepEqual(await integrity.verifyBackendAsync({ backendDir: copyDir, seal }), { ok: true, problems: [] });
  console.log(`[integrity] the concurrent check the app really runs: ${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(0)} ms (warm cache)`);

  const express = path.join(copyDir, 'node_modules', 'express', 'index.js');
  fs.appendFileSync(express, "\nrequire('crypto').verify = () => true;\n");
  assert.deepEqual(integrity.verifyBackend({ backendDir: copyDir, seal }).problems, ['changed: node_modules/express/index.js']);
  fs.writeFileSync(path.join(copyDir, 'node_modules', 'express', 'planted.js'), 'x');
  assert.deepEqual(integrity.verifyBackend({ backendDir: copyDir, seal }).problems.sort(), ['added: node_modules/express/planted.js', 'changed: node_modules/express/index.js']);
  fs.rmSync(copyDir, { recursive: true, force: true });
});

test('the concurrent verifier (what the app runs) answers exactly like the synchronous one, for every kind of tampering', async () => {
  const dir = fakeBackend('async-same');
  const seal = integrity.writeManifest(dir);
  const same = async (label) => {
    const sync = integrity.verifyBackend({ backendDir: dir, seal });
    const concurrent = await integrity.verifyBackendAsync({ backendDir: dir, seal });
    assert.deepEqual({ ok: concurrent.ok, problems: [...concurrent.problems].sort() }, { ok: sync.ok, problems: [...sync.problems].sort() }, label);
    return concurrent;
  };
  assert.equal((await same('untouched')).ok, true);
  const express = path.join(dir, 'node_modules', 'express', 'index.js');
  const original = fs.readFileSync(express);
  fs.appendFileSync(express, "\nrequire('crypto').verify = () => true;");
  assert.deepEqual((await same('patched')).problems, ['changed: node_modules/express/index.js']);
  fs.writeFileSync(express, original);
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'extra.js'), 'x');
  assert.deepEqual((await same('added')).problems, ['added: node_modules/express/extra.js']);
  fs.rmSync(path.join(dir, 'node_modules', 'express', 'extra.js'));
  fs.rmSync(path.join(dir, 'node_modules', 'mongodb', 'index.js'));
  assert.deepEqual((await same('missing')).problems, ['missing: node_modules/mongodb/index.js']);
  assert.equal((await integrity.verifyBackendAsync({ backendDir: dir, seal: null })).ok, false);
  assert.equal((await integrity.verifyBackendAsync({ backendDir: path.join(tmp, 'no-such-backend'), seal })).ok, false);
  assert.equal(integrity.HASH_CONCURRENCY >= 8, true, 'many reads at once: the cold-cache start-up cost is latency, not CPU');
});

// ---- the supervisor checks before EVERY backend start --------------------------------------------------------------

const { EventEmitter } = require('node:events');
const { MainPcSupervisor } = require('../lib/supervisor');
const fakeService = (name) => Object.assign(new EventEmitter(), {
  name, running: false, starts: 0,
  async start() { this.starts += 1; this.running = true; },
  async stop() { this.running = false; },
  die() { this.running = false; this.emit('exit', 1); },
});
const manualTimers = () => { const pending = []; return { pending, setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout() {}, fire: async () => { const fn = pending.shift(); if (fn) await fn(); await new Promise((resolve) => setTimeout(resolve, 40)); } }; }; // the restart the timer starts is not returned to us: let it settle
const quietLog = { info() {}, warn() {}, error() {} };
const supervise = (dir, seal) => {
  const mongod = fakeService('mongod');
  const backend = fakeService('backend');
  const timers = manualTimers();
  const statuses = [];
  const supervisor = new MainPcSupervisor({ mongod, backend, log: quietLog, timers, restartDelaysMs: [10], verifyInstallation: () => integrity.verifyBackend({ backendDir: dir, seal }) });
  supervisor.on('status', (status) => statuses.push(status));
  return { supervisor, mongod, backend, timers, statuses };
};

test('supervisor: a file changed AFTER the app started, then the backend is killed -> the restart is REFUSED and the "damaged" state shows (no retry loop)', async () => {
  const dir = fakeBackend('supervised');
  const seal = integrity.writeManifest(dir);
  const { supervisor, backend, timers, statuses } = supervise(dir, seal);
  await supervisor.start();
  assert.equal(supervisor.status.state, 'running');
  assert.equal(backend.starts, 1);

  fs.appendFileSync(path.join(dir, 'node_modules', 'express', 'index.js'), "\nrequire('crypto').verify = () => true;\n"); // patched while the app runs
  backend.die(); // killed (or crashed)
  assert.equal(supervisor.status.state, 'restarting');
  await timers.fire(); // the restart timer
  assert.equal(backend.starts, 1, 'the backend was NOT started again');
  assert.equal(backend.running, false);
  assert.equal(supervisor.status.state, 'damaged');
  assert.equal(supervisor.status.code, 'INSTALLATION_DAMAGED');
  assert.match(supervisor.status.detail, /changed: node_modules\/express\/index\.js/);
  assert.equal(timers.pending.length, 0, 'no further restart attempt is scheduled');
  backend.die(); // even another exit signal does not retry
  assert.equal(timers.pending.length, 0);
  assert.ok(statuses.some((s) => s.state === 'damaged'));
});

test('supervisor: the first start, a restart after a backup/restore and a normal crash restart ALL check; an untouched installation restarts fine', async () => {
  const dir = fakeBackend('supervised-ok');
  const seal = integrity.writeManifest(dir);
  let checks = 0;
  const mongod = fakeService('mongod'); const backend = fakeService('backend'); const timers = manualTimers();
  const supervisor = new MainPcSupervisor({ mongod, backend, log: quietLog, timers, restartDelaysMs: [10], verifyInstallation: () => { checks += 1; return integrity.verifyBackend({ backendDir: dir, seal }); } });
  await supervisor.start();
  assert.equal(checks, 1, 'the first start');
  backend.die();
  await timers.fire();
  assert.equal(checks, 2, 'a crash restart');
  assert.equal(supervisor.status.state, 'running');
  assert.equal(backend.starts, 2);
  await supervisor.runMaintenance(async () => {}, { reason: 'backup' });
  assert.equal(checks, 3, 'the restart after a backup');
  assert.equal(supervisor.status.state, 'running');

  // tampered during a restore: the backend is not started after it, and the state is "damaged"
  const task = async () => { fs.appendFileSync(path.join(dir, 'package.json'), ' '); };
  await supervisor.runMaintenance(task, { reason: 'restore' }).catch(() => {});
  assert.equal(supervisor.status.state, 'damaged');
  assert.equal(backend.starts, 3, 'not started again');
});

test('supervisor: an installation that is already damaged at the first start never starts the backend', async () => {
  const dir = fakeBackend('supervised-first');
  const seal = integrity.writeManifest(dir);
  fs.writeFileSync(path.join(dir, 'node_modules', 'express', 'extra.js'), 'x');
  const { supervisor, backend } = supervise(dir, seal);
  await supervisor.start();
  assert.equal(backend.starts, 0);
  assert.equal(supervisor.status.state, 'damaged');
});

test('main.js: the supervisor is built with the installation check, and "damaged" shows the reinstall screen', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /new MainPcSupervisor\(\{[^}]*verifyInstallation: \(\) => checkInstallation\(\)/);
  const supervisor = fs.readFileSync(path.join(__dirname, '..', 'lib', 'supervisor.js'), 'utf8');
  assert.equal((supervisor.match(/this\.backend\.start\(\)/g) || []).length, 1, 'the backend is started in ONE place, behind the check');
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
  assert.match(stage, /sourceProblems\(stagedSrc, \{ allowPlaceholder \}\)[\s\S]*?fail\(/);
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
  // The bytecode holds no source text (it keeps constants and names, never the code): a line of the real source must not be in it.
  for (const [module_, line] of [['keys', 'const pems = [PRODUCTION_PUBLIC_KEY_PEM]'], ['index', 'const parsed = parseText(text);'], ['machineId', 'const match = /MachineGuid']]) {
    assert.ok(!fs.readFileSync(path.join(src, 'license', `${module_}.jsc`)).includes(Buffer.from(line)), `${module_}.jsc contains the source line: ${line}`);
  }
  assert.ok(fs.readFileSync(path.join(path.join(BACKEND, 'src', 'license', 'index.js')), 'utf8').includes('const parsed = parseText(text);'), 'the probe lines really are in the original source');

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

test('PLACEHOLDER guard: offline:stage tolerates the placeholder key ONLY with NOTA_ALLOW_PLACEHOLDER_KEY=1 and then marks the stage non-releasable; other problems still fail', () => {
  const src = copy(path.join(BACKEND, 'src'), 'ph-src');
  protect.prepareProductionSource(src);
  assert.equal(protect.sourceProblems(src).length, 1, 'the placeholder alone is a problem by default');
  assert.match(protect.sourceProblems(src)[0], /placeholder/);
  assert.match(protect.productionKeyProblem(src), /placeholder/);
  assert.deepEqual(protect.sourceProblems(src, { allowPlaceholder: true }), [], 'tolerated with the dev-verification flag');
  fs.writeFileSync(path.join(src, 'license', 'test-key.js'), 'module.exports = {};');
  assert.equal(protect.sourceProblems(src, { allowPlaceholder: true }).length, 1, 'the test key still fails, flag or not');
  fs.writeFileSync(path.join(src, 'license', 'build-flags.js'), 'module.exports = { TEST_BUILD: true };');
  assert.equal(protect.sourceProblems(src, { allowPlaceholder: true }).length, 2, 'and so does TEST_BUILD true');

  const stage = path.join(tmp, 'ph-stage');
  assert.deepEqual(protect.releaseProblems(stage), []);
  protect.markNonReleasable(stage, 'built with the placeholder production key (NOTA_ALLOW_PLACEHOLDER_KEY=1)');
  assert.ok(fs.existsSync(path.join(stage, protect.NON_RELEASABLE)));
  assert.match(protect.releaseProblems(stage)[0], /NON-RELEASABLE/);
  protect.clearNonReleasable(stage);
  assert.deepEqual(protect.releaseProblems(stage), [], 'a normal stage run clears the marker');

  const stageScript = fs.readFileSync(path.join(FRONTEND, 'scripts', 'offline', 'stage.js'), 'utf8');
  assert.match(stageScript, /NOTA_ALLOW_PLACEHOLDER_KEY === '1'/);
  assert.match(stageScript, /sourceProblems\(stagedSrc, \{ allowPlaceholder \}\)/);
  assert.match(stageScript, /markNonReleasable\(STAGE,/);
  assert.match(stageScript, /clearNonReleasable\(STAGE\)/);
});

test('PLACEHOLDER guard: electron:build:win:offline (and the :dir build) ALWAYS fail with the placeholder, whatever the environment; afterPack refuses a non-releasable stage', () => {
  const guard = path.join(FRONTEND, 'scripts', 'offline', 'build-guard.js');
  const backend = path.join(tmp, 'ph-backend');
  fs.mkdirSync(backend, { recursive: true });
  fs.cpSync(path.join(BACKEND, 'src'), path.join(backend, 'src'), { recursive: true });
  const emptyStage = path.join(tmp, 'ph-empty-stage');
  fs.mkdirSync(emptyStage, { recursive: true });
  const runGuard = (env) => spawnSync(process.execPath, [guard], { encoding: 'utf8', env: { ...process.env, NOTA_BACKEND_DIR: backend, NOTA_STAGE_DIR: emptyStage, ...env } });

  for (const env of [{}, { NOTA_ALLOW_PLACEHOLDER_KEY: '1' }, { NOTA_ALLOW_PLACEHOLDER_KEY: 'true', NODE_ENV: 'test', CI: '1' }, { NOTA_ALLOW_PLACEHOLDER_KEY: '1', NOTA_TEST_BUILD: '1' }]) {
    const result = runGuard(env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.match(result.stderr, /placeholder/, JSON.stringify(env));
  }
  // with a real key it passes, and the dev flag changes nothing either way
  const keys = keygen('ph-keys');
  protect.prepareProductionSource(path.join(backend, 'src'), { productionKeyPem: fs.readFileSync(path.join(keys, 'public.pem'), 'utf8') });
  assert.equal(runGuard({}).status, 0);
  assert.equal(runGuard({ NOTA_ALLOW_PLACEHOLDER_KEY: '1' }).status, 0);
  // ... but not from a stage that was marked non-releasable
  const marked = path.join(tmp, 'ph-marked-stage');
  protect.markNonReleasable(marked, 'built with the placeholder production key (NOTA_ALLOW_PLACEHOLDER_KEY=1)');
  const refused = spawnSync(process.execPath, [guard], { encoding: 'utf8', env: { ...process.env, NOTA_BACKEND_DIR: backend, NOTA_STAGE_DIR: marked } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /NON-RELEASABLE/);

  // the installer build scripts run the guard BEFORE offline:stage, and afterPack re-checks the marker
  const scripts = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).scripts;
  for (const name of ['electron:build:win:offline', 'electron:build:win:offline:dir']) {
    assert.ok(scripts[name].indexOf('node scripts/offline/build-guard.js') > -1 && scripts[name].indexOf('build-guard.js') < scripts[name].indexOf('npm run offline:stage'), name);
  }
  const code = fs.readFileSync(guard, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/process\.env\.NOTA_ALLOW_PLACEHOLDER_KEY/.test(code), 'the installer guard never reads the dev-verification variable');
  const afterPack = fs.readFileSync(path.join(FRONTEND, 'scripts', 'offline', 'after-pack.js'), 'utf8');
  assert.match(afterPack, /releaseProblems\(path\.join\(ROOT, 'offline-stage'\)\)[\s\S]*?throw new Error/);
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
