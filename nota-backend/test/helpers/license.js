// Stage 24 test helper: signs licenses with the TEST key and installs one for a test run.
//
// The test private key is NOT stored anywhere: it is derived at runtime from a fixed seed, so the repo has no key file or
// PEM block (a test scans for those). Its public half is src/license/test-key.js, which only a test build contains.
// The production key set never contains it (src/license/keys.js), and the staged backend has the flag off.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { encodePayload, buildText } = require("../../src/license/format");
const { getMachineId } = require("../../src/license/machineId");

const SEED = crypto.createHash("sha256").update("nota-test-license-seed-v1 (test builds only, not a secret)").digest();
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const testPrivateKey = () => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, SEED]), format: "der", type: "pkcs8" });

/** Any other key pair: used to prove a license signed by someone else is refused. */
const otherPrivateKey = () => crypto.generateKeyPairSync("ed25519").privateKey;

let counter = 0;
const defaults = () => ({
  v: 1, licenseId: `TEST-${process.pid}-${++counter}`, type: "lifetime", shopName: "محل الاختبار", machineId: getMachineId(),
  maxClients: 100, issuedAt: "2026-01-01T00:00:00.000Z",
});

/** License text for `overrides`, signed with `privateKey` (the test key by default). */
const issueTestLicense = (overrides = {}, privateKey = testPrivateKey()) => {
  const payloadBytes = encodePayload({ ...defaults(), ...overrides });
  return buildText(payloadBytes, crypto.sign(null, payloadBytes, privateKey));
};

// Stage 24: the main PC is a loopback request that carries the per-start main-PC token (src/auth/mainPc.js). A test's fetch() plays the
// main PC's own window, so it adds the token to every request, unless the call sets the marker header "x-test-no-main-token"
// (a request that must behave like a client PC or a TCP forwarder on the main PC). Installed once, with the first test license.
const NO_MAIN_TOKEN = "x-test-no-main-token";
const actAsMainWindow = () => {
  if (globalThis.fetch.__mainWindow) return;
  const { mainPcToken, HEADER } = require("../../src/auth/mainPc");
  const real = globalThis.fetch;
  const wrapped = (input, init = {}) => {
    const headers = new Headers(init.headers || (input && input.headers) || {});
    if (headers.has(NO_MAIN_TOKEN)) headers.delete(NO_MAIN_TOKEN);
    else headers.set(HEADER, mainPcToken());
    return real(input, { ...init, headers });
  };
  wrapped.__mainWindow = true;
  wrapped.__real = real; // a script that is not a test (the smoke test) puts the real fetch back and sends its own token
  globalThis.fetch = wrapped;
};

/** Points the license folder at a fresh temp dir and (unless `text === null`) writes a valid test license there. */
const installTestLicense = (overrides = {}, text) => {
  actAsMainWindow();
  const license = require("../../src/license");
  const dir = process.env.NOTA_LICENSE_DIR && process.env.NOTA_LICENSE_DIR.startsWith(path.join(os.tmpdir(), "nota-test-license-"))
    ? process.env.NOTA_LICENSE_DIR
    : fs.mkdtempSync(path.join(os.tmpdir(), "nota-test-license-"));
  process.env.NOTA_LICENSE_DIR = dir;
  fs.rmSync(path.join(dir, license.FILE_NAME), { force: true });
  if (text !== null) fs.writeFileSync(path.join(dir, license.FILE_NAME), text || issueTestLicense(overrides), "utf8");
  license.resetForTests();
  license.reload();
  return dir;
};

const removeTestLicenseDir = () => {
  const dir = process.env.NOTA_LICENSE_DIR;
  if (dir && dir.startsWith(path.join(os.tmpdir(), "nota-test-license-"))) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NOTA_LICENSE_DIR;
  require("../../src/license").resetForTests();
};

module.exports = { NO_MAIN_TOKEN, actAsMainWindow, issueTestLicense, installTestLicense, removeTestLicenseDir, testPrivateKey, otherPrivateKey };
