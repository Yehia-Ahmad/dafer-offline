#!/usr/bin/env node
// Stages the offline edition for electron-builder (electron-builder.offline.json):
//   offline-stage/app      Electron app folder: Angular offline build + electron-offline + package.json
//   offline-stage/backend  kapomatic-backend with production dependencies only
//
// Inputs: dist-offline/ (npm run build:offline), vendor/ (npm run offline:vendor) and the
// backend checkout next to this project, or the folder in KAPOMATIC_BACKEND_DIR.
// Uses only Node's own fs functions, so it runs the same from cmd, PowerShell or bash.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_SOURCE = path.resolve(process.env.KAPOMATIC_BACKEND_DIR || path.join(ROOT, '..', 'kapomatic-backend'));
const ANGULAR_OUTPUT = path.join(ROOT, 'dist-offline', 'browser');
const ELECTRON_SOURCE = path.join(ROOT, 'electron-offline');
const STAGE = path.join(ROOT, 'offline-stage');
const STAGE_APP = path.join(STAGE, 'app');
const STAGE_BACKEND = path.join(STAGE, 'backend');
const EDITION = require(path.join(ELECTRON_SOURCE, 'edition.json'));

// Backend dependencies the offline edition must not ship. Currently none.
const BACKEND_EXCLUDED_DEPENDENCIES = [];

// Nothing that looks like configuration or a credential may reach the installer.
const FORBIDDEN_FILES = [
  { test: (name) => /^\.env(\..+)?$/i.test(name), why: 'environment file' },
  { test: (name) => /\.(pem|key|p12|pfx)$/i.test(name), why: 'key or certificate' },
  { test: (name) => /firebase-adminsdk.*\.json$|service-?account.*\.json$/i.test(name), why: 'service account' },
];
const FORBIDDEN_BACKEND_PATHS = ['test', '.mongo-data', '.git'];

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
      'Check out kapomatic-backend next to this project or set KAPOMATIC_BACKEND_DIR.'
    );
  }
}

function stageApp() {
  fs.rmSync(STAGE_APP, { recursive: true, force: true });
  fs.mkdirSync(STAGE_APP, { recursive: true });
  fs.cpSync(ANGULAR_OUTPUT, path.join(STAGE_APP, 'dist'), { recursive: true });
  fs.cpSync(ELECTRON_SOURCE, path.join(STAGE_APP, 'electron-offline'), { recursive: true });

  const appPackage = {
    name: 'kapomatic-offline',
    productName: EDITION.productName,
    version: EDITION.version,
    description: EDITION.description,
    author: 'Kapomatic',
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
  fs.writeFileSync(path.join(STAGE_BACKEND, 'package.json'), `${JSON.stringify(backendPackage, null, 2)}\n`);

  log(`installing backend production dependencies from ${BACKEND_SOURCE}`);
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: STAGE_BACKEND });
  log(`backend staged (${mb(folderSize(STAGE_BACKEND))})`);
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
  if (problems.length) fail(`the stage contains files that must not ship:\n  ${problems.join('\n  ')}`);

  // The staged backend must load without the excluded packages, in both modes.
  const smoke = (env, label) => {
    const result = spawnSync(process.execPath, ['-e', "require('./src/app.js')"], {
      cwd: STAGE_BACKEND,
      encoding: 'utf8',
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...env },
      timeout: 60000,
    });
    if (result.status !== 0) fail(`staged backend failed to load (${label}):\n${result.stderr}`);
  };
  smoke({}, 'online mode');
  smoke({ KAPOMATIC_LAN_MODE: '1', KAPOMATIC_LAN_SECRET: 'STAGE-CHECK-SECRET' }, 'LAN mode');
  log('checks passed: no secrets or excluded files, backend loads in online and LAN mode');
}

checkInputs();
stageApp();
stageBackend();
validate();
