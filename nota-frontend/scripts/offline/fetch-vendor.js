#!/usr/bin/env node
// Downloads the pinned MongoDB server and Database Tools zips (scripts/offline/vendor.lock.json),
// verifies their SHA-256, and extracts only the files the offline edition ships into
// vendor/mongodb. It also fetches the pinned Microsoft Visual C++ redistributable that
// mongod.exe needs into vendor/vcredist, and checks its Microsoft signature.
// Downloads are cached in vendor/downloads, so this needs internet only once.
//
//   node scripts/offline/fetch-vendor.js            (skips work when vendor/mongodb is current)
//   node scripts/offline/fetch-vendor.js --force    (re-extracts from the cached zips)
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK = require('./vendor.lock.json');
const DOWNLOADS = path.join(ROOT, 'vendor', 'downloads');
const OUT = path.join(ROOT, 'vendor', 'mongodb');
const STAMP = path.join(OUT, 'versions.json');
const VCREDIST = path.join(ROOT, 'vendor', 'vcredist', 'vc_redist.x64.exe');
const COMPONENTS = { mongodbServer: 'server', databaseTools: 'tools' };
const force = process.argv.includes('--force');

const log = (message) => console.log(`[offline:vendor] ${message}`);

function fail(message) {
  console.error(`[offline:vendor] ERROR: ${message}`);
  process.exit(1);
}

function expectedStamp() {
  return {
    ...Object.fromEntries(
      Object.keys(COMPONENTS).map((key) => [key, { version: LOCK[key].version, sha256: LOCK[key].sha256 }])
    ),
    vcRedist: { sha256: LOCK.vcRedist.sha256 },
  };
}

function isCurrent() {
  try {
    const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    return JSON.stringify(stamp.components) === JSON.stringify(expectedStamp()) && fs.existsSync(VCREDIST);
  } catch {
    return false;
  }
}

async function sha256OfFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(entry) {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const target = path.join(DOWNLOADS, path.basename(new URL(entry.url).pathname));

  if (fs.existsSync(target)) {
    if ((await sha256OfFile(target)) === entry.sha256) {
      log(`cached ${path.basename(target)}`);
      return target;
    }
    log(`cached ${path.basename(target)} has the wrong hash, downloading again`);
    fs.rmSync(target);
  }

  log(`downloading ${entry.url}`);
  const response = await fetch(entry.url);
  if (!response.ok || !response.body) fail(`download failed: HTTP ${response.status} for ${entry.url}`);

  const total = Number(response.headers.get('content-length')) || 0;
  const partial = `${target}.part`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let nextReport = 0.1;

  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    if (total && received / total >= nextReport) {
      log(`  ${Math.round((received / total) * 100)}% of ${(total / 1048576).toFixed(0)} MB`);
      nextReport += 0.1;
    }
  });
  await pipeline(body, fs.createWriteStream(partial));

  const actual = hash.digest('hex');
  if (actual !== entry.sha256) {
    fs.rmSync(partial, { force: true });
    fail(`SHA-256 mismatch for ${entry.url}\n  expected ${entry.sha256}\n  actual   ${actual}`);
  }
  fs.renameSync(partial, target);
  log(`verified ${path.basename(target)}`);
  return target;
}

// Windows 10+ ships bsdtar as System32\tar.exe, which reads zip files.
function tarCommand() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'bsdtar';
}

function runTar(args, options = {}) {
  const result = spawnSync(tarCommand(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) fail(`could not run ${tarCommand()}: ${result.error.message}`);
  if (result.status !== 0) fail(`tar ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function extract(zipFile, entry, prefix, workDir) {
  const members = runTar(['-tf', zipFile]).split(/\r?\n/).filter(Boolean);
  const topLevels = [...new Set(members.map((member) => member.split('/')[0]))];
  if (topLevels.length !== 1) fail(`unexpected layout in ${path.basename(zipFile)}: ${topLevels.join(', ')}`);
  const top = topLevels[0];

  const wanted = [...entry.binaries, ...entry.licenses].map((file) => `${top}/${file}`);
  const missing = wanted.filter((file) => !members.includes(file));
  if (missing.length) fail(`missing in ${path.basename(zipFile)}: ${missing.join(', ')}`);

  fs.mkdirSync(workDir, { recursive: true });
  runTar(['-xf', zipFile, '-C', workDir, ...wanted]);

  fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
  for (const file of entry.binaries) {
    fs.copyFileSync(path.join(workDir, top, file), path.join(OUT, 'bin', path.basename(file)));
  }
  for (const file of entry.licenses) {
    fs.copyFileSync(path.join(workDir, top, file), path.join(OUT, 'licenses', `${prefix}-${path.basename(file)}`));
  }
}

function checkVersion(entry) {
  const binary = path.join(OUT, 'bin', entry.versionCheck.binary);
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error || !output.includes(entry.versionCheck.expect)) {
    fail(
      `${entry.versionCheck.binary} --version did not report "${entry.versionCheck.expect}" ` +
        `(exit ${result.status}${result.error ? `, ${result.error.message}` : ''}):\n${output}`
    );
  }
  log(`${entry.versionCheck.binary} runs: ${entry.versionCheck.expect}`);
}

// The hash pins the exact file; the signature check also confirms it is Microsoft's.
function checkSignature(file, expectedSigner) {
  if (process.platform !== 'win32') {
    log('warning: cannot check the Authenticode signature outside Windows');
    return;
  }
  const script =
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; ` +
    "Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const [status = '', subject = ''] = (result.stdout || '').split(/\r?\n/).map((line) => line.trim());
  if (status !== 'Valid' || !subject.includes(expectedSigner)) {
    fail(`signature check failed for ${path.basename(file)}: status "${status}", signer "${subject}"`);
  }
  log(`${path.basename(file)} signature is valid (${expectedSigner})`);
}

async function main() {
  if (process.platform !== 'win32') log('warning: the bundled binaries are Windows-only and cannot be checked here');

  if (!force && isCurrent()) {
    log(`vendor/mongodb is current (server ${LOCK.mongodbServer.version}, tools ${LOCK.databaseTools.version})`);
    return;
  }

  const zips = {};
  for (const key of Object.keys(COMPONENTS)) zips[key] = await download(LOCK[key]);
  const vcRedist = await download(LOCK.vcRedist);
  checkSignature(vcRedist, LOCK.vcRedist.signer);

  fs.rmSync(OUT, { recursive: true, force: true });
  const workRoot = fs.mkdtempSync(path.join(ROOT, 'vendor', '.extract-'));
  try {
    for (const [key, prefix] of Object.entries(COMPONENTS)) {
      extract(zips[key], LOCK[key], prefix, path.join(workRoot, prefix));
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }

  if (process.platform === 'win32') {
    for (const key of Object.keys(COMPONENTS)) checkVersion(LOCK[key]);
  }

  fs.rmSync(path.dirname(VCREDIST), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(VCREDIST), { recursive: true });
  fs.copyFileSync(vcRedist, VCREDIST);

  fs.writeFileSync(STAMP, `${JSON.stringify({ components: expectedStamp() }, null, 2)}\n`);
  log(`ready: ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, VCREDIST)}`);
}

main().catch((error) => fail(error.stack || error.message));
