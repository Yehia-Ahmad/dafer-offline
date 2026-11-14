// Stage 24: the public keys a license is checked against. COMPILED IN: no env var, setting or file can replace them.
//
// PRODUCTION: the vendor's key. Until the vendor generates theirs (tools/license-gen/README.md) this is a marked
// placeholder that verifies nothing, and the Windows build refuses to run while the marker is still here.
//
// TEST: accepted only when build-flags.js says TEST_BUILD. That file is "true" in the source tree (dev and test runs)
// and `npm run offline:stage` rewrites the staged copy to "false" and deletes test-key.js, so a shipped backend has
// only the production key (a staging test checks both).

const PLACEHOLDER_MARKER = "NOTA_PLACEHOLDER_REPLACE_WITH_PRODUCTION_PUBLIC_KEY";

const PRODUCTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
${PLACEHOLDER_MARKER}
-----END PUBLIC KEY-----`;

// Captured at load (see index.js): later code cannot replace crypto.createPublicKey under the license check.
const { createPublicKey } = require("crypto");
const { TEST_BUILD } = require("./build-flags");

/** Public keys that may verify a license in this build. A placeholder or unparsable key is skipped (fails closed). */
const acceptedPublicKeys = () => {
  const pems = [PRODUCTION_PUBLIC_KEY_PEM];
  if (TEST_BUILD === true) pems.push(require("./test-key").TEST_PUBLIC_KEY_PEM);
  const keys = [];
  for (const pem of pems) {
    if (pem.includes(PLACEHOLDER_MARKER)) continue;
    try { keys.push(createPublicKey(pem)); } catch { /* skip */ }
  }
  return keys;
};

module.exports = { PLACEHOLDER_MARKER, PRODUCTION_PUBLIC_KEY_PEM, acceptedPublicKeys, isTestBuild: () => TEST_BUILD === true };
