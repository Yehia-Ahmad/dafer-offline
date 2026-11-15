'use strict';

// Stage 25: the production public key of a RELEASE build comes from a file the release manager points to (NOTA_RELEASE_PUBLIC_KEY_FILE), so the
// real key never has to be committed: nota-backend/src/license/keys.js in the repo keeps its placeholder. scripts/offline/stage.js swaps the key
// into the STAGED copy only, checks it here, and records its fingerprint in offline-stage/release-key.json for build-guard.js and the release note.
//
// A file is refused when it is a private key, the placeholder, not an Ed25519 public key, or the test key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER_MARKER = 'NOTA_PLACEHOLDER_REPLACE_WITH_PRODUCTION_PUBLIC_KEY';
const RECORD = 'release-key.json';
const { verificationFingerprint } = require('./verification-key');

const fingerprintOf = (keyObject) => crypto.createHash('sha256').update(keyObject.export({ type: 'spki', format: 'der' })).digest('hex');

/** The fingerprint of the test key of this checkout (the one a source-tree/test build accepts), or null when the file is not there. */
function testKeyFingerprint(backendDir) {
  try {
    const { TEST_PUBLIC_KEY_PEM } = require(path.join(backendDir, 'src', 'license', 'test-key.js'));
    return fingerprintOf(crypto.createPublicKey(TEST_PUBLIC_KEY_PEM));
  } catch {
    return null;
  }
}

/**
 * Reads and checks a release public key file. Returns { pem, fingerprint }; throws an Error whose message says what to fix.
 * @param {string} file
 * @param {{ backendDir: string }} options
 */
function readReleaseKey(file, { backendDir }) {
  if (!file) throw new Error('NOTA_RELEASE_PUBLIC_KEY_FILE is not set: point it to the public key file (public.pem) of your license key pair');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the release public key file ${file}: ${error.code || error.message}`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error(`${file} holds a PRIVATE key. Give the PUBLIC key (public.pem): a private key must never go into a build`);
  if (text.includes(PLACEHOLDER_MARKER)) throw new Error(`${file} still holds the placeholder, not a public key`);
  let key;
  try {
    key = crypto.createPublicKey(text);
  } catch {
    throw new Error(`${file} is not a PEM public key (expected the public.pem written by: node tools/license-gen/license-gen.js keygen)`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is a ${key.asymmetricKeyType} key; licenses use an Ed25519 key`);
  const fingerprint = fingerprintOf(key);
  if (fingerprint === testKeyFingerprint(backendDir)) throw new Error(`${file} is the TEST key (the one development builds accept). A release needs your own production key`);
  if (fingerprint === verificationFingerprint()) throw new Error(`${file} is the VERIFICATION key (its private half is derived from a public seed, it is not a secret). A release needs your own production key`);
  return { pem: key.export({ type: 'spki', format: 'pem' }).toString().trim(), fingerprint };
}

/** The fingerprint of the PEM text of a staged keys.js literal, or null (placeholder / not Ed25519). */
function fingerprintOfLiteral(pem) {
  if (!pem || pem.includes('PLACEHOLDER')) return null;
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? fingerprintOf(key) : null;
  } catch {
    return null;
  }
}

function writeRecord(stageDir, record) {
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, RECORD), `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`);
}

/** What build-guard checks about the key of a STAGE. Empty = fine. */
function recordProblems(stageDir, { backendDir } = {}) {
  const file = path.join(stageDir, RECORD);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [`${path.basename(stageDir)}/${RECORD} is missing: run offline:stage first (a release needs NOTA_RELEASE_PUBLIC_KEY_FILE)`];
  }
  if (record.verification === true || record.fingerprint === verificationFingerprint()) return ['the production public key of this stage is the VERIFICATION key (a non-releasable verification stage); a release needs your own production key'];
  if (record.placeholder === true) return ['the production public key of this stage is still the placeholder: run offline:stage with NOTA_RELEASE_PUBLIC_KEY_FILE pointing to your public key (tools/license-gen/README.md, step 2)'];
  if (typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) return [`${RECORD} has no valid key fingerprint`];
  if (backendDir && record.fingerprint === testKeyFingerprint(backendDir)) return ['the production public key of this stage is the TEST key; a release needs your own production key'];
  return [];
}

module.exports = { PLACEHOLDER_MARKER, RECORD, fingerprintOf, fingerprintOfLiteral, readReleaseKey, recordProblems, testKeyFingerprint, writeRecord };
