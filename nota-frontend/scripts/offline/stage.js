#!/usr/bin/env node
// Stages the offline edition for electron-builder (electron-builder.offline.json):
//   offline-stage/app      Electron app folder: Angular offline build + electron-offline + package.json
//   offline-stage/backend  nota-backend with production dependencies only
//
// Inputs: dist-offline/ (npm run build:offline), vendor/ (npm run offline:vendor) and the
// backend checkout next to this project, or the folder in NOTA_BACKEND_DIR.
// Uses only Node's own fs functions, so it runs the same from cmd, PowerShell or bash.
//
// Stage 24: the staged backend is protected. Its license code gets the test flag off and loses the test key; the build FAILS if the
// production public key is still the placeholder; every backend .js is compiled to V8 bytecode with the exact Electron that runs it
// (scripts/offline/protect.js); a hash manifest of the protected files is written and its seal goes into the app (lib/integrity.js).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const protect = require('./protect');
const integrity = require('../../electron-offline/lib/integrity');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_SOURCE = path.resolve(process.env.NOTA_BACKEND_DIR || path.join(ROOT, '..', 'nota-backend'));
const ANGULAR_OUTPUT = path.join(ROOT, 'dist-offline', 'browser');
const ELECTRON_SOURCE = path.join(ROOT, 'electron-offline');
const STAGE = path.join(ROOT, 'offline-stage');
const STAGE_APP = path.join(STAGE, 'app');
const STAGE_BACKEND = path.join(STAGE, 'backend');
const EDITION = require(path.join(ELECTRON_SOURCE, 'edition.json'));
const FRONTEND_PACKAGE = require(path.join(ROOT, 'package.json'));
const FRONTEND_NODE_MODULES = path.join(ROOT, 'node_modules');

// Backend dependencies the offline edition must not ship. Currently none.
const BACKEND_EXCLUDED_DEPENDENCIES = [];

// Nothing that looks like configuration or a credential may reach the installer.
const FORBIDDEN_FILES = [
  { test: (name) => /^\.env(\..+)?$/i.test(name), why: 'environment file' },
  { test: (name) => /\.(pem|key|p12|pfx)$/i.test(name), why: 'key or certificate' },
  { test: (name) => /firebase-adminsdk.*\.json$|service-?account.*\.json$/i.test(name), why: 'service account' },
];
const FORBIDDEN_BACKEND_PATHS = ['test', '.mongo-data', '.git'];

const state = { seal: null };
const log = (message) => console.log(`[offline:stage] ${message}`);

function fail(message) {
  console.error(`[offline:stage] ERROR: ${message}`);
  process.exit(1);
}

function requireFile(file, hint) {
  if (!fs.existsSync(file)) fail(`missing ${path.relative(ROOT, file)}. ${hint}`);
}

function run(command, args, options) {
  // shell: true lets Windows resolve npm.cmd.
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.error) fail(`${command} ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function walk(dir, visit, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry, path.relative(base, full));
    if (entry.isDirectory()) walk(full, visit, base);
  }
}

function folderSize(dir) {
  let bytes = 0;
  walk(dir, (full, entry) => {
    if (entry.isFile()) bytes += fs.statSync(full).size;
  });
  return bytes;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function checkInputs() {
  requireFile(path.join(ANGULAR_OUTPUT, 'index.html'), 'Run "npm run build:offline" first.');
  requireFile(path.join(ROOT, 'vendor', 'mongodb', 'versions.json'), 'Run "npm run offline:vendor" first.');
  requireFile(path.join(ROOT, 'vendor', 'vcredist', 'vc_redist.x64.exe'), 'Run "npm run offline:vendor" first.');
  requireFile(path.join(ELECTRON_SOURCE, 'main.js'), 'The electron-offline folder is incomplete.');
  for (const file of ['src/server.js', 'src/app.js', 'package.json', 'package-lock.json']) {
    requireFile(
      path.join(BACKEND_SOURCE, file),
      'Check out nota-backend next to this project or set NOTA_BACKEND_DIR.'
    );
  }
}

function stageApp() {
  fs.rmSync(STAGE_APP, { recursive: true, force: true });
  fs.mkdirSync(STAGE_APP, { recursive: true });
  fs.cpSync(ANGULAR_OUTPUT, path.join(STAGE_APP, 'dist'), { recursive: true });
  // Tests never ship (electron-builder also leaves them out of the asar); they hold test fixtures, not product code.
  const testFolder = path.join(ELECTRON_SOURCE, 'test');
  fs.cpSync(ELECTRON_SOURCE, path.join(STAGE_APP, 'electron-offline'), { recursive: true, filter: (source) => source !== testFolder });

  const appPackage = {
    name: 'nota-offline',
    productName: EDITION.productName,
    version: EDITION.version,
    description: EDITION.description,
    author: EDITION.productName,
    main: 'electron-offline/main.js',
    private: true,
  };
  fs.writeFileSync(path.join(STAGE_APP, 'package.json'), `${JSON.stringify(appPackage, null, 2)}\n`);
  log(`app staged: ${EDITION.productName} ${EDITION.version} (${mb(folderSize(STAGE_APP))})`);
}

function stageBackend() {
  fs.rmSync(STAGE_BACKEND, { recursive: true, force: true });
  fs.mkdirSync(STAGE_BACKEND, { recursive: true });

  // Copy only what the server needs; .env, tests and local data stay behind.
  fs.cpSync(path.join(BACKEND_SOURCE, 'src'), path.join(STAGE_BACKEND, 'src'), { recursive: true });
  fs.copyFileSync(path.join(BACKEND_SOURCE, 'package-lock.json'), path.join(STAGE_BACKEND, 'package-lock.json'));

  const backendPackage = JSON.parse(fs.readFileSync(path.join(BACKEND_SOURCE, 'package.json'), 'utf8'));
  for (const name of BACKEND_EXCLUDED_DEPENDENCIES) delete backendPackage.dependencies[name];
  delete backendPackage.devDependencies;
  // The bytecode loader the compiled files need at run time (exact version, the one the frontend compiled with).
  backendPackage.dependencies.bytenode = FRONTEND_PACKAGE.devDependencies.bytenode;
  fs.writeFileSync(path.join(STAGE_BACKEND, 'package.json'), `${JSON.stringify(backendPackage, null, 2)}\n`);

  // Stage 24: production flags, then the guards. Anything wrong here stops the build before bytecode is made.
  const stagedSrc = path.join(STAGE_BACKEND, 'src');
  protect.prepareProductionSource(stagedSrc);
  const problems = protect.sourceProblems(stagedSrc);
  if (problems.length) fail(`the staged backend must not ship like this:\n  ${problems.join('\n  ')}`);

  log(`installing backend production dependencies from ${BACKEND_SOURCE}`);
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: STAGE_BACKEND });

  const before = folderSize(stagedSrc);
  const started = Date.now();
  const compiled = protect.compileToBytecode({ srcDir: stagedSrc, electronPath: require('electron'), nodeModules: FRONTEND_NODE_MODULES });
  const stillReadable = protect.stagedProblems(stagedSrc);
  if (stillReadable.length) fail(`the backend was not fully protected:\n  ${stillReadable.join('\n  ')}`);
  log(`bytecode: ${compiled.files} files compiled with Electron ${compiled.electron} (V8 ${compiled.v8}) in ${((Date.now() - started) / 1000).toFixed(1)} s; src ${mb(before)} -> ${mb(folderSize(stagedSrc))}`);

  // The tamper check's manifest. Its seal goes into the app (writeSeal, after both are staged).
  state.seal = integrity.writeManifest(STAGE_BACKEND);
  log(`backend staged (${mb(folderSize(STAGE_BACKEND))})`);
}

// The seal (SHA-256 of integrity.json) lives inside app.asar, which Electron's ASAR integrity fuse protects.
function writeSeal() {
  fs.writeFileSync(path.join(STAGE_APP, 'electron-offline', 'lib', 'integrity-seal.json'), `${JSON.stringify(state.seal)}\n`);
  log('integrity seal written into the app');
}

function validate() {
  const problems = [];
  for (const dir of [STAGE_APP, STAGE_BACKEND]) {
    walk(dir, (full, entry) => {
      if (!entry.isFile()) return;
      const rule = FORBIDDEN_FILES.find(({ test }) => test(entry.name));
      if (rule) problems.push(`${rule.why}: ${path.relative(ROOT, full)}`);
    });
  }
  for (const relative of FORBIDDEN_BACKEND_PATHS) {
    if (fs.existsSync(path.join(STAGE_BACKEND, relative))) problems.push(`not allowed in backend: ${relative}`);
  }
  // Stage 24: no private key anywhere in what ships (the vendor's key never leaves the vendor's PC).
  for (const dir of [STAGE_APP, path.join(STAGE_BACKEND, 'src')]) {
    for (const hit of protect.findPrivateKeys(dir)) problems.push(`private key: ${path.relative(ROOT, path.join(dir, hit))}`);
  }
  if (problems.length) fail(`the stage contains files that must not ship:\n  ${problems.join('\n  ')}`);

  // The staged backend must load without the excluded packages, in both modes. It is bytecode now, so it loads on Electron
  // (ELECTRON_RUN_AS_NODE, build time only), the same V8 that compiled it.
  const smoke = (env, label) => {
    const result = spawnSync(require('electron'), ['-e', "require('./src/app.js')"], {
      cwd: STAGE_BACKEND,
      encoding: 'utf8',
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ...env },
      timeout: 60000,
    });
    if (result.status !== 0) fail(`staged backend failed to load (${label}):\n${result.stderr}`);
  };
  smoke({}, 'online mode');
  smoke({ NOTA_LAN_MODE: '1', NOTA_LAN_SECRET: 'STAGE-CHECK-SECRET' }, 'LAN mode');
  // Stage 13: auth mode loads bcryptjs and jsonwebtoken, so this also proves they were staged.
  smoke(
    { NOTA_LAN_MODE: '1', NOTA_LAN_SECRET: 'STAGE-CHECK-SECRET', NOTA_AUTH: '1', NOTA_JWT_SECRET: 'STAGE-CHECK-JWT-SECRET-0123456789abcdef' },
    'LAN + auth mode'
  );
  log('checks passed: no secrets or excluded files, backend loads in online, LAN and LAN + auth mode');
}

checkInputs();
stageApp();
stageBackend();
writeSeal();
validate();
