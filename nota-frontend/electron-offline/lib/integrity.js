'use strict';

// Stage 24: tamper check for the installed backend.
//
// At build time scripts/offline/stage.js hashes EVERY file of the backend folder (src, node_modules, package.json, everything: all of it is
// loaded by the backend, or by the main process from there) into resources/backend/integrity.json and puts the
// SHA-256 of that manifest ("the seal") inside the app (lib/integrity-seal.json, in app.asar). The asar is protected by Electron's
// ASAR integrity fuse, so editing a backend file AND the manifest still fails: the manifest no longer matches the seal, and the
// seal cannot be changed without breaking the asar.
//
// At start the main process re-hashes the files. A mismatch (edited, added or removed file) = "the installation is damaged".

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_NAME = 'integrity.json';
// The manifest itself is the only file that is not hashed (it is sealed from inside the asar instead).

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function protectedFiles(backendDir) {
  const manifest = path.join(backendDir, MANIFEST_NAME);
  return listFiles(backendDir).filter((file) => file !== manifest);
}

/** { version, files: { "src/app.js": "<sha256>", ... } } with sorted keys (the same text for the same files). */
function buildManifest(backendDir) {
  const files = {};
  for (const file of protectedFiles(backendDir)) {
    files[path.relative(backendDir, file).split(path.sep).join('/')] = sha256(fs.readFileSync(file));
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
  return { version: 1, files: sorted };
}

const manifestText = (manifest) => `${JSON.stringify(manifest, null, 1)}\n`;

/** Writes integrity.json into the backend folder and returns the seal for the app. */
function writeManifest(backendDir) {
  const text = manifestText(buildManifest(backendDir));
  fs.writeFileSync(path.join(backendDir, MANIFEST_NAME), text);
  return { manifestSha256: sha256(Buffer.from(text, 'utf8')) };
}

/**
 * Checks the installed backend. `seal` = { manifestSha256 } from the app (null/undefined = not sealed = not trusted).
 * Returns { ok, problems: [string] } (at most 20 problems listed).
 */
// The manifest and the seal first (cheap). Returns { early } when the answer is already known, else { expected }.
function readExpected(backendDir, seal) {
  if (!seal || typeof seal.manifestSha256 !== 'string') return { early: { ok: false, problems: ['the app has no integrity seal'] } };
  let text;
  try {
    text = fs.readFileSync(path.join(backendDir, MANIFEST_NAME), 'utf8');
  } catch {
    return { early: { ok: false, problems: [`${MANIFEST_NAME} is missing`] } };
  }
  if (sha256(Buffer.from(text, 'utf8')) !== seal.manifestSha256) return { early: { ok: false, problems: [`${MANIFEST_NAME} does not match the seal`] } };
  try {
    return { expected: JSON.parse(text).files };
  } catch {
    return { early: { ok: false, problems: [`${MANIFEST_NAME} is unreadable`] } };
  }
}

const keyOf = (backendDir, file) => path.relative(backendDir, file).split(path.sep).join('/');

function compare(expected, actual, unreadable) {
  const problems = unreadable.map((key) => `cannot read ${key}`);
  for (const key of Object.keys(expected)) {
    if (!(key in actual)) problems.push(`missing: ${key}`);
    else if (actual[key] !== expected[key]) problems.push(`changed: ${key}`);
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) problems.push(`added: ${key}`);
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 20) };
}

/**
 * Checks the installed backend. `seal` = { manifestSha256 } from the app (null/undefined = not sealed = not trusted).
 * Returns { ok, problems: [string] } (at most 20 problems listed). Synchronous: build tools and tests.
 */
function verifyBackend({ backendDir, seal }) {
  const { early, expected } = readExpected(backendDir, seal);
  if (early) return early;
  const actual = {};
  const unreadable = [];
  for (const file of protectedFiles(backendDir)) {
    const key = keyOf(backendDir, file);
    try {
      actual[key] = sha256(fs.readFileSync(file));
    } catch {
      unreadable.push(key);
    }
  }
  return compare(expected, actual, unreadable);
}

// Reading thousands of small files one after another is slow on a cold disk cache (about 27 s for the 4,300 files of the staged backend on
// a test PC, the antivirus scanning each file on its first read); many reads at once take about 7 s there, and well under a second once warm.
const HASH_CONCURRENCY = 16;

/** The same check, reading files concurrently. This is what the app runs at start and before every backend start. */
async function verifyBackendAsync({ backendDir, seal, concurrency = HASH_CONCURRENCY }) {
  const { early, expected } = readExpected(backendDir, seal);
  if (early) return early;
  const files = protectedFiles(backendDir);
  const actual = {};
  const unreadable = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= files.length) return;
      const key = keyOf(backendDir, files[index]);
      try {
        actual[key] = sha256(await fs.promises.readFile(files[index]));
      } catch {
        unreadable.push(key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker));
  return compare(expected, actual, unreadable);
}

module.exports = { MANIFEST_NAME, HASH_CONCURRENCY, buildManifest, writeManifest, verifyBackend, verifyBackendAsync, sha256 };
