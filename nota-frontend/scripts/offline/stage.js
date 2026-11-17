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
const { bundleBackend } = require('./bundle-backend');
const { stripNodeModules } = require('./strip');
const { npmCommand } = require('./npm-cli');
const releaseKey = require('./release-key');
const verificationKey = require('./verification-key');
const integrity = require('../../electron-offline/lib/integrity');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_SOURCE = path.resolve(process.env.NOTA_BACKEND_DIR || path.join(ROOT, '..', 'nota-backend'));
const ANGULAR_OUTPUT = path.join(ROOT, 'dist-offline', 'browser');
const ELECTRON_SOURCE = path.join(ROOT, 'electron-offline');
// NOTA_STAGE_DIR moves the stage (tests stage into a temp folder so they never touch the real offline-stage/).
const STAGE = path.resolve(process.env.NOTA_STAGE_DIR || path.join(ROOT, 'offline-stage'));
const STAGE_APP = path.join(STAGE, 'app');
const STAGE_BACKEND = path.join(STAGE, 'backend');
// Stage 25: source maps of the bundled backend. Outside the backend folder, so they never ship; the release script keeps them.
const STAGE_SOURCEMAPS = path.join(STAGE, 'sourcemaps');
// Stage 25: the version is nota-frontend/package.json "version" (the single source); a build number is stamped at stage time.
const EDITION = { ...require(path.join(ELECTRON_SOURCE, 'edition.json')), version: require(path.join(ROOT, 'package.json')).version };
const buildStamp = () => {
  if (process.env.NOTA_BUILD_NUMBER) return process.env.NOTA_BUILD_NUMBER;
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}`;
};
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

// Stage 25: no shell (DEP0190): npm runs through the npm-cli.js that ships next to node (scripts/offline/npm-cli.js). Other commands run directly.
function run(command, args, options) {
  const [file, fileArgs] = command === 'npm' ? npmCommand(args) : [command, args];
  const result = spawnSync(file, fileArgs, { stdio: 'inherit', ...options });
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

function countFiles(dir) {
  let count = 0;
  walk(dir, (full, entry) => { if (entry.isFile()) count += 1; });
  return count;
}

// After bundling, node_modules only needs bytenode (the bytecode loader) and any package the bundle still requires at run time.
function pruneNodeModulesToBundleNeeds(externalRequires) {
  const keep = new Set(['bytenode', ...externalRequires.map((name) => (name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]))]);
  const modules = path.join(STAGE_BACKEND, 'node_modules');
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    const full = path.join(modules, entry.name);
    if (entry.name === '.bin' || entry.name === '.package-lock.json') fs.rmSync(full, { recursive: true, force: true });
    else if (entry.name.startsWith('@')) {
      for (const child of fs.readdirSync(full)) {
        if (!keep.has(`${entry.name}/${child}`)) fs.rmSync(path.join(full, child), { recursive: true, force: true });
      }
      if (!fs.readdirSync(full).length) fs.rmSync(full, { recursive: true, force: true });
    } else if (!keep.has(entry.name)) fs.rmSync(full, { recursive: true, force: true });
  }
  // The staged package.json lists only what still loads from node_modules.
  const manifestFile = path.join(STAGE_BACKEND, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => keep.has(name)));
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(STAGE_BACKEND, 'package-lock.json'), { force: true });
}

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
  // Stage 25: the changelog the "what's new" window reads (every released version must have a section).
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(STAGE_APP, 'CHANGELOG.md'));
  const build = { version: EDITION.version, build: buildStamp(), builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(STAGE_APP, 'electron-offline', 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
  fs.writeFileSync(path.join(STAGE, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
  log(`app staged: ${EDITION.productName} ${EDITION.version} build ${build.build} (${mb(folderSize(STAGE_APP))})`);
}

// The key that is compiled into the license bundle must be the one chosen above (and never the placeholder or the test key).
let stagedKeyBody = '';
function verifyBundledKey() {
  const text = fs.readFileSync(path.join(STAGE_BACKEND, 'src', 'license', 'index.js'), 'utf8');
  const testBody = (() => {
    try { return require(path.join(BACKEND_SOURCE, 'src', 'license', 'test-key.js')).TEST_PUBLIC_KEY_PEM.split('\n').filter((line) => !line.startsWith('-----')).join(''); } catch { return ''; }
  })();
  if (testBody && text.includes(testBody)) fail('the license bundle contains the TEST public key');
  if (stagedKeyBody && !stagedKeyBody.includes('PLACEHOLDER') && !text.includes(stagedKeyBody)) fail('the license bundle does not contain the production public key that was chosen');
  log('the license bundle carries the chosen production public key and no test key');
}

async function stageBackend() {
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
  // Stage 25: the production public key of a release comes from NOTA_RELEASE_PUBLIC_KEY_FILE (checked: public, Ed25519, not the placeholder,
  // not the test key) and is swapped into the STAGED copy only; the repo's keys.js keeps its placeholder. Without the variable the key committed in
  // keys.js is used (the placeholder is refused, or tolerated with NOTA_ALLOW_PLACEHOLDER_KEY=1 for a non-releasable verification stage).
  let chosenKey = null;
  if (process.env.NOTA_RELEASE_PUBLIC_KEY_FILE) {
    try {
      chosenKey = releaseKey.readReleaseKey(process.env.NOTA_RELEASE_PUBLIC_KEY_FILE, { backendDir: BACKEND_SOURCE });
    } catch (error) {
      fail(error.message);
    }
  }
  // A verification stage (NOTA_ALLOW_PLACEHOLDER_KEY=1, no release key): carries the verification key (scripts/offline/verification-key.js), so the smoke test can license the
  // real bundle. It is marked NON-RELEASABLE below.
  const verification = process.env.NOTA_ALLOW_PLACEHOLDER_KEY === '1' && !chosenKey;
  protect.prepareProductionSource(stagedSrc, chosenKey ? { productionKeyPem: chosenKey.pem } : verification ? { productionKeyPem: verificationKey.verificationPublicPem() } : {});
  // NOTA_ALLOW_PLACEHOLDER_KEY=1 is for development verification only: the stage is built, but marked NON-RELEASABLE, and the installer
  // build (build-guard.js, afterPack) refuses it. The installer build itself never honours this variable.
  const allowPlaceholder = process.env.NOTA_ALLOW_PLACEHOLDER_KEY === '1' && !chosenKey;
  const problems = protect.sourceProblems(stagedSrc, { allowPlaceholder });
  if (problems.length) fail(`the staged backend must not ship like this:\n  ${problems.join('\n  ')}`);
  protect.clearNonReleasable(STAGE);
  // What build-guard and the release note read: which key this stage carries (the plain keys.js is still readable here, before bundling).
  const stagedKeyLiteral = /const PRODUCTION_PUBLIC_KEY_PEM = `([^`]*)`;/.exec(fs.readFileSync(path.join(stagedSrc, 'license', 'keys.js'), 'utf8'));
  const stagedFingerprint = releaseKey.fingerprintOfLiteral(stagedKeyLiteral && stagedKeyLiteral[1]);
  if (stagedFingerprint && stagedFingerprint === releaseKey.testKeyFingerprint(BACKEND_SOURCE)) fail('the production public key in the staged backend is the TEST key; a build needs your own production key');
  releaseKey.writeRecord(STAGE, {
    source: chosenKey ? 'NOTA_RELEASE_PUBLIC_KEY_FILE' : 'nota-backend/src/license/keys.js',
    placeholder: !stagedFingerprint || verification,
    verification,
    fingerprint: stagedFingerprint,
  });
  if (stagedFingerprint) log(`production public key: ${stagedFingerprint.slice(0, 16)}... (${chosenKey ? 'from NOTA_RELEASE_PUBLIC_KEY_FILE' : 'from nota-backend/src/license/keys.js'})`);
  stagedKeyBody = stagedKeyLiteral
  ? stagedKeyLiteral[1]
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '')
  : '';
  if (verification) {
    protect.markNonReleasable(STAGE, 'built with the verification key, not a production key (NOTA_ALLOW_PLACEHOLDER_KEY=1)');
    log('WARNING: NOTA_ALLOW_PLACEHOLDER_KEY=1: this is a VERIFICATION stage (it carries the verification key, so the smoke test can license it). It is marked NON-RELEASABLE (offline-stage/NON_RELEASABLE.json) and cannot become an installer.');
  }

  log(`installing backend production dependencies from ${BACKEND_SOURCE}`);
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: STAGE_BACKEND });

  // Stage 25: bundle (NOTA_NO_BUNDLE=1 keeps the per-file layout), strip, then bytecode.
  const filesBefore = countFiles(STAGE_BACKEND);
  if (process.env.NOTA_NO_BUNDLE === '1') {
    log('NOTA_NO_BUNDLE=1: keeping the per-file layout (no bundle)');
  } else {
    const bundled = await bundleBackend({ backendDir: STAGE_BACKEND, sourceMapDir: STAGE_SOURCEMAPS });
    log(`bundle: ${bundled.inputs} inputs from ${bundled.packages.length} packages -> 3 files (${mb(bundled.bundleBytes)}); still external at run time: ${bundled.externalRequires.join(', ') || 'nothing'}`);
    pruneNodeModulesToBundleNeeds(bundled.externalRequires);
    verifyBundledKey();
  }
  const stripped = stripNodeModules(path.join(STAGE_BACKEND, 'node_modules'));
  log(`node_modules stripped: ${stripped.files} files (${mb(stripped.bytes)}) of docs, types, maps, tests and examples removed (LICENSE files kept)`);

  const before = folderSize(stagedSrc);
  const started = Date.now();
  const compiled = protect.compileToBytecode({ srcDir: stagedSrc, electronPath: require('electron'), nodeModules: FRONTEND_NODE_MODULES });
  const stillReadable = protect.stagedProblems(stagedSrc);
  if (stillReadable.length) fail(`the backend was not fully protected:\n  ${stillReadable.join('\n  ')}`);
  log(`bytecode: ${compiled.files} files compiled with Electron ${compiled.electron} (V8 ${compiled.v8}) in ${((Date.now() - started) / 1000).toFixed(1)} s; src ${mb(before)} -> ${mb(folderSize(stagedSrc))}`);

  // The tamper check's manifest. Its seal goes into the app (writeSeal, after both are staged).
  state.seal = integrity.writeManifest(STAGE_BACKEND);
  log(`backend staged: ${countFiles(STAGE_BACKEND)} files (${filesBefore} before bundling/stripping), ${mb(folderSize(STAGE_BACKEND))}`);
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
    const result = spawnSync(require('electron'), ['-e', "require('./src/server.js')"], {
      cwd: STAGE_BACKEND,
      encoding: 'utf8',
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', NOTA_STAGE_LOAD_CHECK: '1', ...env },
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
fs.mkdirSync(STAGE, { recursive: true });
stageApp();
stageBackend().then(() => {
  writeSeal();
  validate();
}).catch((error) => fail(error && error.stack ? error.stack : String(error)));
