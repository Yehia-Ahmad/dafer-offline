'use strict';

// Stage 25: the key of a VERIFICATION stage. `NOTA_ALLOW_PLACEHOLDER_KEY=1 npm run offline:stage` used to build a stage that accepts no license at all, so
// nothing licensed could run against it. Now that stage carries this key instead, and the smoke test (scripts/offline/smoke-test.js) signs its
// licenses with it, so the SHIPPED bytecode bundle can be exercised end to end.
//
// Like the test key (backend/test/helpers/license.js) its private half is derived from a fixed seed at run time: there is no key file or PEM block
// anywhere, and it is not a secret. It is only ever compiled into a stage that is marked NON-RELEASABLE (build-guard and afterPack refuse it), and it is
// a different key from the test key, so a test-key license is still refused by such a stage.

const crypto = require('node:crypto');
const path = require('node:path');

const SEED = crypto.createHash('sha256').update('nota-verification-stage-seed-v1 (non-releasable verification stages only, not a secret)').digest();
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const verificationPrivateKey = () => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, SEED]), format: 'der', type: 'pkcs8' });
const verificationPublicPem = () => crypto.createPublicKey(verificationPrivateKey()).export({ type: 'spki', format: 'pem' }).toString().trim();

let counter = 0;

/** A license text signed with the verification key; `backendDir` is the nota-backend checkout (format and machine id come from its source). */
function issueVerificationLicense(overrides = {}, { backendDir }) {
  const { encodePayload, buildText } = require(path.join(backendDir, 'src', 'license', 'format'));
  const { getMachineId } = require(path.join(backendDir, 'src', 'license', 'machineId'));
  const payload = {
    v: 1, licenseId: `VERIFY-${process.pid}-${++counter}`, type: 'lifetime', shopName: 'محل الاختبار', machineId: getMachineId(),
    maxClients: 100, issuedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
  const bytes = encodePayload(payload);
  return buildText(bytes, crypto.sign(null, bytes, verificationPrivateKey()));
}

/** SHA-256 of the verification public key's DER (the same fingerprint release-key.js records). */
const verificationFingerprint = () => crypto.createHash('sha256').update(crypto.createPublicKey(verificationPrivateKey()).export({ type: 'spki', format: 'der' })).digest('hex');

module.exports = { verificationFingerprint, issueVerificationLicense, verificationPrivateKey, verificationPublicPem };
