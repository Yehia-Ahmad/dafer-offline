// Stage 24: license state for this backend process.
//
// The file (<NOTA_LICENSE_DIR>/nota.lic) is the source of truth. It is verified at start and again whenever the license
// changes (activate / reload); the result is cached in memory, never recomputed per request. A copy of the text is kept
// in the database (Meta "license") so client PCs can show the license info. An invalid license never deletes or changes data.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { acceptedPublicKeys } = require("./keys");
const { parseText, payloadProblem } = require("./format");
const { getMachineId } = require("./machineId");

const FILE_NAME = "nota.lic";

// Reasons a license is not accepted.
const CODES = Object.freeze({
  NONE: "NO_LICENSE",
  MALFORMED: "MALFORMED",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  UNKNOWN_VERSION: "UNKNOWN_VERSION",
  UNKNOWN_TYPE: "UNKNOWN_TYPE",
  WRONG_MACHINE: "WRONG_MACHINE",
  NO_MACHINE_ID: "NO_MACHINE_ID",
});

const licenseDir = () => process.env.NOTA_LICENSE_DIR || path.join(process.cwd(), ".nota-license");
const licensePath = () => path.join(licenseDir(), FILE_NAME);

/** Checks license text against the compiled-in keys and this PC. Returns { ok, code, payload }. */
const verifyText = (text) => {
  const parsed = parseText(text);
  if (!parsed) return { ok: false, code: CODES.MALFORMED };
  const keys = acceptedPublicKeys();
  const signed = keys.some((key) => {
    try { return crypto.verify(null, parsed.payloadBytes, key, parsed.signature); } catch { return false; }
  });
  if (!signed) return { ok: false, code: CODES.BAD_SIGNATURE };
  const problem = payloadProblem(parsed.payload);
  if (problem) return { ok: false, code: problem };
  const machineId = getMachineId();
  if (!machineId) return { ok: false, code: CODES.NO_MACHINE_ID };
  if (parsed.payload.machineId !== machineId) return { ok: false, code: CODES.WRONG_MACHINE, payload: parsed.payload };
  return { ok: true, payload: parsed.payload };
};

// { loaded, ok, code, payload, text }
let state = { loaded: false, ok: false, code: CODES.NONE, payload: null, text: null };

const readFileText = () => {
  try { return fs.readFileSync(licensePath(), "utf8").trim() || null; } catch { return null; }
};

/** Re-reads and verifies the license file. Called at start and after the license changes. */
const reload = () => {
  const text = readFileText();
  if (!text) {
    state = { loaded: true, ok: false, code: CODES.NONE, payload: null, text: null };
    return state;
  }
  const result = verifyText(text);
  state = { loaded: true, ok: result.ok, code: result.ok ? null : result.code, payload: result.ok ? result.payload : null, text };
  return state;
};

const current = () => (state.loaded ? state : reload());
const isValid = () => current().ok === true;
const payload = () => (isValid() ? state.payload : null);

/** Public view (no signature). */
const summary = () => {
  const s = current();
  const p = s.ok ? s.payload : null;
  return {
    licensed: s.ok,
    code: s.ok ? null : s.code,
    machineId: getMachineId(),
    shopName: p ? p.shopName : null,
    ...(p ? { shopNameEn: p.shopNameEn || null } : {}),
  };
};

/** Full view for the owner. */
const details = () => {
  const s = current();
  const p = s.ok ? s.payload : null;
  return p ? { licenseId: p.licenseId, type: p.type, shopName: p.shopName, shopNameEn: p.shopNameEn || null, machineId: p.machineId, maxClients: p.maxClients, issuedAt: p.issuedAt } : null;
};

/**
 * Verifies and installs license text. Writes the file atomically and only after the text verified.
 * Returns { ok:true, payload } or { ok:false, code }. The old file stays when the new text is refused.
 */
const install = (text) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const result = verifyText(trimmed);
  if (!result.ok) return { ok: false, code: result.code };
  const dir = licenseDir();
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `${FILE_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(temp, trimmed, "utf8");
  fs.renameSync(temp, licensePath());
  reload();
  return { ok: true, payload: result.payload };
};

/** Tests only: forget the cached state so the next call re-reads the file. */
const resetForTests = () => { state = { loaded: false, ok: false, code: CODES.NONE, payload: null, text: null }; };

module.exports = { CODES, FILE_NAME, licenseDir, licensePath, verifyText, reload, isValid, payload, summary, details, install, resetForTests };
