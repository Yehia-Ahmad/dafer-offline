#!/usr/bin/env node
// Stage 25: npm run release:win -- the whole release in one command, on the release manager's Windows PC.
//
//   NOTA_RELEASE_PUBLIC_KEY_FILE=D:\nota-keys\public.pem   (required: the PUBLIC key of your license key pair; the repo's keys.js keeps its placeholder)
//   CSC_LINK / CSC_KEY_PASSWORD                           (optional: a code signing certificate; unset = an unsigned installer, SmartScreen will warn)
//   npm run release:win
//
// What it does, in order, and stops at the first failure:
//   1. checks the key file (public, Ed25519, not the placeholder, not the test key) and that CHANGELOG.md has a section for this version
//   2. backend `npm test` (0 skipped) and `npm run test:legacy-migration`, frontend `ng test`
//   3. build:offline, offline:vendor, offline:stage (with the release key swapped into the STAGED backend only)
//   4. test:offline and smoke:offline against that stage
//   5. build-guard (the stage carries a real key and is releasable), then electron-builder (NSIS)
//   6. release-offline/<version>/: Nota-Setup-<version>.exe, its SHA-256, the source maps of the backend bundle (never inside the installer) and
//      release-note.md (version, build number, key fingerprint, size, tests, signing, the changelog)
//
// Flags (development of this script, never for a real release):
//   --skip-tests   leaves step 2 and 4 out; the release note says so in capitals
//   --stage-only   stops after the stage and build-guard (what the release-script tests use)
// The version is nota-frontend/package.json "version"; the build number is stamped by offline:stage.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { npmCommand } = require('./npm-cli');
const releaseKey = require('./release-key');
const { parseChangelog } = require('../../electron-offline/lib/whats-new');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_SOURCE = path.resolve(process.env.NOTA_BACKEND_DIR || path.join(ROOT, '..', 'nota-backend'));
const STAGE = path.join(ROOT, 'offline-stage');
const RELEASE_ROOT = path.join(ROOT, 'release-offline');

// Variables that must never reach a release build: they exist only for development verification.
const FORBIDDEN_ENV = ['NOTA_ALLOW_PLACEHOLDER_KEY', 'NOTA_NO_BUNDLE', 'NOTA_ALLOW_SKIP'];

const log = (message) => console.log(`[release] ${message}`);
class ReleaseError extends Error {}
const fail = (message) => { throw new ReleaseError(message); };

function parseArgs(argv) {
  const known = new Set(['--skip-tests', '--stage-only']);
  const flags = new Set();
  for (const arg of argv) {
    if (!known.has(arg)) fail(`unknown argument ${arg} (known: ${[...known].join(', ')})`);
    flags.add(arg);
  }
  return { skipTests: flags.has('--skip-tests'), stageOnly: flags.has('--stage-only') };
}

/** Everything that can be checked before a minute of building is spent. Returns { key, version, entry }. */
function preflight({ env = process.env, rootDir = ROOT, backendDir = BACKEND_SOURCE, releaseRoot = RELEASE_ROOT } = {}) {
  for (const name of FORBIDDEN_ENV) {
    if (env[name]) fail(`${name} is set: it is for development verification only and is refused by release:win. Unset it.`);
  }
  let key;
  try {
    key = releaseKey.readReleaseKey(env.NOTA_RELEASE_PUBLIC_KEY_FILE, { backendDir });
  } catch (error) {
    fail(error.message);
  }
  const version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version "${version}" is not a plain x.y.z`);
  const entries = parseChangelog(fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8'));
  const entry = entries.find((candidate) => candidate.version === version);
  if (!entry || !entry.ar.length || !entry.en.length) fail(`CHANGELOG.md has no section for ${version} with both an Arabic and an English list (the "what's new" window shows it)`);
  if (fs.existsSync(path.join(releaseRoot, version)) && env.NOTA_RELEASE_OVERWRITE !== '1') {
    fail(`${path.relative(rootDir, path.join(releaseRoot, version))} already exists: a released version is never overwritten. Raise the version in package.json (or set NOTA_RELEASE_OVERWRITE=1 for a rebuild of an unreleased version)`);
  }
  return { key, version, entry };
}

/** electron-builder arguments. Code signing is switched on only when a certificate is configured (CSC_LINK); without one the build still succeeds, unsigned. */
function builderArgs({ env = process.env, outputDir }) {
  const args = ['--win', 'nsis', '--config', 'electron-builder.offline.json', `--config.directories.output=${outputDir}`];
  if (env.CSC_LINK) args.push('--config.win.signAndEditExecutable=true');
  return args;
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of FORBIDDEN_ENV) delete env[name];
  return env;
}

function run(label, command, args, options = {}) {
  log(label);
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed (exit ${result.status})`);
  return Math.round((Date.now() - started) / 1000);
}

const npmRun = (label, script, cwd, env) => run(label, ...npmCommand(['run', script]), { cwd, env });
const ngBin = path.join(ROOT, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');

/** The text of release-note.md. */
function releaseNote({ version, build, key, installer, sha256, size, tests, signed, entry, builtAt }) {
  return `# Nota ${version} (build ${build})

- Built: ${builtAt}
- Installer: \`${installer}\` (${mb(size)})
- SHA-256: \`${sha256}\`
- Production public key fingerprint (SHA-256): \`${key.fingerprint}\`
- Code signing: ${signed ? 'signed with the configured certificate' : 'NOT signed (no CSC_LINK was set): Windows SmartScreen will warn; see docs/release/SMARTSCREEN_AR.md'}
- Tests: ${tests}

## What's new

### العربية
${entry.ar.map((line) => `- ${line}`).join('\n')}

### English
${entry.en.map((line) => `- ${line}`).join('\n')}

## Files next to this note
- \`${installer}.sha256\`: check it on the shop's PC with \`certutil -hashfile ${installer} SHA256\`
- \`sourcemaps/\`: the source maps and bundle text of the backend, to read a stack trace from a support file (\`node scripts/offline/decode-stack.js stack.txt release-offline/${version}/sourcemaps\`). They are NOT inside the installer. Keep them for as long as this version is in use.
`;
}

/** The installed program must not contain source maps or the maps folder. Returns problems. */
function packageProblems(unpackedDir) {
  const problems = [];
  const resources = path.join(unpackedDir, 'resources');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name === 'sourcemaps') problems.push(`${path.relative(unpackedDir, full)} (source maps folder)`); walk(full); }
      else if (/\.map$/i.test(entry.name)) problems.push(path.relative(unpackedDir, full));
    }
  };
  walk(resources);
  try {
    const asar = require('@electron/asar');
    for (const name of asar.listPackage(path.join(resources, 'app.asar'))) if (/\.map$/i.test(name) || /sourcemaps/.test(name)) problems.push(`app.asar${name}`);
  } catch (error) {
    problems.push(`could not list app.asar: ${error.message}`);
  }
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { key, version, entry } = preflight();
  log(`releasing Nota ${version}; production key ${key.fingerprint.slice(0, 16)}...`);
  const signed = Boolean(process.env.CSC_LINK);
  log(signed ? 'code signing: CSC_LINK is set, the installer will be signed' : 'code signing: CSC_LINK is not set, the installer will be UNSIGNED');
  const env = childEnv({ NOTA_RELEASE_PUBLIC_KEY_FILE: process.env.NOTA_RELEASE_PUBLIC_KEY_FILE });
  const timings = {};

  if (!options.skipTests) {
    timings.backend = npmRun('backend: npm test (0 skipped)', 'test', BACKEND_SOURCE, env);
    timings.legacy = npmRun('backend: npm run test:legacy-migration', 'test:legacy-migration', BACKEND_SOURCE, env);
    timings.ng = run('frontend: ng test', process.execPath, [ngBin, 'test', '--watch=false', '--browsers=ChromeHeadless'], { cwd: ROOT, env });
  } else {
    log('--skip-tests: the suites are NOT run (this must never be a real release)');
  }
  timings.build = run('frontend: ng build (offline)', process.execPath, [ngBin, 'build', '--configuration', 'offline'], { cwd: ROOT, env });
  npmRun('frontend: offline:vendor', 'offline:vendor', ROOT, env);
  timings.stage = npmRun('frontend: offline:stage (release key into the staged backend)', 'offline:stage', ROOT, env);
  if (!options.skipTests) {
    timings.electron = npmRun('frontend: test:offline (the Electron tests, on the real stage)', 'test:offline', ROOT, env);
    // The smoke test runs against the staged bytecode bundle, and a stage with the REAL key cannot be licensed by a test: so the same pipeline stages a
    // second, throwaway VERIFICATION stage (verification key, non-releasable, deleted right after) and the smoke test runs against that bundle.
    const verifyStage = path.join(ROOT, 'offline-stage-verify');
    const verifyEnv = { ...env, NOTA_STAGE_DIR: verifyStage, NOTA_ALLOW_PLACEHOLDER_KEY: '1' };
    delete verifyEnv.NOTA_RELEASE_PUBLIC_KEY_FILE;
    try {
      npmRun('frontend: offline:stage (a throwaway verification stage for the smoke test)', 'offline:stage', ROOT, verifyEnv);
      timings.smoke = npmRun('frontend: smoke:offline (against that staged bundle)', 'smoke:offline', ROOT, verifyEnv);
    } finally {
      fs.rmSync(verifyStage, { recursive: true, force: true });
    }
  }
  run('build-guard (the stage carries a real key and is releasable)', process.execPath, [path.join(__dirname, 'build-guard.js')], { cwd: ROOT, env });
  if (options.stageOnly) { log('--stage-only: stopping before the installer'); return; }

  const build = JSON.parse(fs.readFileSync(path.join(STAGE, 'build.json'), 'utf8'));
  const outputDir = path.join('release-offline', `.build-${version}`);
  fs.rmSync(path.join(ROOT, outputDir), { recursive: true, force: true });
  timings.installer = run('electron-builder: NSIS installer', process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), ...builderArgs({ env: process.env, outputDir })], { cwd: ROOT, env: childEnv({ CSC_LINK: process.env.CSC_LINK, CSC_KEY_PASSWORD: process.env.CSC_KEY_PASSWORD }) });

  const built = path.join(ROOT, outputDir);
  const installerName = `Nota-Setup-${version}.exe`;
  if (!fs.existsSync(path.join(built, installerName))) fail(`electron-builder did not produce ${installerName}`);
  const leaks = packageProblems(path.join(built, 'win-unpacked'));
  if (leaks.length) fail(`the program folder contains files that must not ship:\n  ${leaks.join('\n  ')}`);
  log('the program folder has no source maps');

  const finalDir = path.join(RELEASE_ROOT, version);
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.mkdirSync(finalDir, { recursive: true });
  fs.copyFileSync(path.join(built, installerName), path.join(finalDir, installerName));
  const sha256 = sha256File(path.join(finalDir, installerName));
  fs.writeFileSync(path.join(finalDir, `${installerName}.sha256`), `${sha256}  ${installerName}\n`);
  fs.cpSync(path.join(STAGE, 'sourcemaps'), path.join(finalDir, 'sourcemaps'), { recursive: true });
  const size = fs.statSync(path.join(finalDir, installerName)).size;
  const tests = options.skipTests ? 'SKIPPED (--skip-tests): NOT A REAL RELEASE' : `backend npm test + legacy migration, ng test, test:offline and smoke:offline all passed (${Object.entries(timings).filter(([name]) => ['backend', 'legacy', 'ng', 'electron', 'smoke'].includes(name)).map(([name, seconds]) => `${name} ${seconds}s`).join(', ')})`;
  fs.writeFileSync(path.join(finalDir, 'release-note.md'), releaseNote({ version, build: build.build, key, installer: installerName, sha256, size, tests, signed, entry, builtAt: new Date().toISOString() }));
  fs.rmSync(built, { recursive: true, force: true });
  log(`done: ${path.relative(ROOT, finalDir)}\\${installerName} (${mb(size)}), SHA-256 ${sha256}`);
}

module.exports = { FORBIDDEN_ENV, ReleaseError, builderArgs, packageProblems, parseArgs, preflight, releaseNote, sha256File };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[release] ERROR: ${error.message}`);
    process.exit(1);
  });
}
