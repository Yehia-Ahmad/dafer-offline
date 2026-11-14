'use strict';

// Stage 24: tamper check for the installed backend.
//
// At build time scripts/offline/stage.js hashes the protected backend files into resources/backend/integrity.json and puts the
// SHA-256 of that manifest ("the seal") inside the app (lib/integrity-seal.json, in app.asar). The asar is protected by Electron's
// ASAR integrity fuse, so editing a backend file AND the manifest still fails: the manifest no longer matches the seal, and the
// seal cannot be changed without breaking the asar.
//
// At start the main process re-hashes the files. A mismatch (edited, added or removed file) = "the installation is damaged".

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_NAME = 'integrity.json';
// What is hashed: all of src/ (stubs + bytecode), package.json and the bytecode loader.
const INCLUDE = ['src', 'package.json', path.join('node_modules', 'bytenode')];

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
  const files = [];
  for (const item of INCLUDE) {
    const full = path.join(backendDir, item);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
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
function verifyBackend({ backendDir, seal }) {
  const problems = [];
  if (!seal || typeof seal.manifestSha256 !== 'string') return { ok: false, problems: ['the app has no integrity seal'] };
  let text;
  try {
    text = fs.readFileSync(path.join(backendDir, MANIFEST_NAME), 'utf8');
  } catch {
    return { ok: false, problems: [`${MANIFEST_NAME} is missing`] };
  }
  if (sha256(Buffer.from(text, 'utf8')) !== seal.manifestSha256) return { ok: false, problems: [`${MANIFEST_NAME} does not match the seal`] };
  let expected;
  try {
    expected = JSON.parse(text).files;
  } catch {
    return { ok: false, problems: [`${MANIFEST_NAME} is unreadable`] };
  }
  const actual = {};
  for (const file of protectedFiles(backendDir)) {
    const key = path.relative(backendDir, file).split(path.sep).join('/');
    try {
      actual[key] = sha256(fs.readFileSync(file));
    } catch {
      problems.push(`cannot read ${key}`);
    }
  }
  for (const key of Object.keys(expected)) {
    if (!(key in actual)) problems.push(`missing: ${key}`);
    else if (actual[key] !== expected[key]) problems.push(`changed: ${key}`);
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) problems.push(`added: ${key}`);
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 20) };
}

module.exports = { MANIFEST_NAME, buildManifest, writeManifest, verifyBackend, sha256 };
