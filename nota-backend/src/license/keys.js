
// Stage 24: public keys used to verify Nota licenses.
// Compiled into the backend: do not load production verification keys from
// environment variables, settings, or external files.
//
// PRODUCTION: This public key matches the vendor's existing private.pem.
// Keep private.pem offline and never ship it with the application.
//
// TEST: The test key is accepted only when build-flags.js sets TEST_BUILD=true.
// The offline staging process must set TEST_BUILD=false and remove test-key.js.

const PLACEHOLDER_MARKER = "NOTA_PLACEHOLDER_REPLACE_WITH_PRODUCTION_PUBLIC_KEY";

const PRODUCTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+l/q3oNkhxlxHgjsSFvu4Ksq8S5AYNKQCE2MUSfXuek=
-----END PUBLIC KEY-----`;

// Capture the crypto function at module load time, as in the original design.
const { createPublicKey } = require("crypto");
const { TEST_BUILD } = require("./build-flags");

/** Public keys accepted by this build. Invalid or placeholder keys are skipped. */
const acceptedPublicKeys = () => {
  const pems = [PRODUCTION_PUBLIC_KEY_PEM];

  if (TEST_BUILD === true) {
    pems.push(require("./test-key").TEST_PUBLIC_KEY_PEM);
  }

  const keys = [];

  for (const pem of pems) {
    if (pem.includes(PLACEHOLDER_MARKER)) continue;

    try {
      keys.push(createPublicKey(pem));
    } catch {
      // Invalid key: fail closed by excluding it.
    }
  }

  return keys;
};

module.exports = {
  PLACEHOLDER_MARKER,
  PRODUCTION_PUBLIC_KEY_PEM,
  acceptedPublicKeys,
  isTestBuild: () => TEST_BUILD === true,
};
