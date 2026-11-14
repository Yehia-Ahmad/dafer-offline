// Stage 24: the license text format.
//
//   NOTA1.<base64url(payload JSON)>.<base64url(Ed25519 signature over the payload bytes)>
//
// The signature covers the exact payload bytes that are in the text, so changing any field (shop name,
// maxClients, machine) breaks it. The payload key order is fixed so the vendor tool and tests produce
// identical text for identical input.

const PREFIX = "NOTA1";
const KNOWN_VERSIONS = new Set([1]);
const KNOWN_TYPES = new Set(["lifetime"]); // other types (subscription, trial) may come later
const PAYLOAD_KEYS = ["v", "licenseId", "type", "shopName", "shopNameEn", "machineId", "maxClients", "issuedAt"];

const MACHINE_ID_PATTERN = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const fromB64u = (text) => Buffer.from(text, "base64url");

/** Canonical payload object: fixed key order, optional keys left out when empty. */
const canonicalPayload = (input) => {
  const out = {};
  for (const key of PAYLOAD_KEYS) {
    if (input[key] === undefined || input[key] === null) continue;
    if (key === "shopNameEn" && input[key] === "") continue;
    out[key] = input[key];
  }
  return out;
};

const encodePayload = (input) => Buffer.from(JSON.stringify(canonicalPayload(input)), "utf8");

/** Splits license text into its parts. Returns null when it is not shaped like a license. */
const parseText = (text) => {
  if (typeof text !== "string") return null;
  const parts = text.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  if (!parts[1] || !parts[2] || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const payloadBytes = fromB64u(parts[1]);
  const signature = fromB64u(parts[2]);
  let payload;
  try { payload = JSON.parse(payloadBytes.toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return { payload, payloadBytes, signature };
};

const buildText = (payloadBytes, signature) => `${PREFIX}.${b64u(payloadBytes)}.${b64u(signature)}`;

/** Shape check of a decoded payload (after the signature passed). Returns an error code or null. */
const payloadProblem = (p) => {
  if (!KNOWN_VERSIONS.has(p.v)) return "UNKNOWN_VERSION";
  if (!KNOWN_TYPES.has(p.type)) return "UNKNOWN_TYPE";
  if (typeof p.licenseId !== "string" || !p.licenseId) return "MALFORMED";
  if (typeof p.shopName !== "string" || !p.shopName.trim() || p.shopName.length > 150) return "MALFORMED";
  if (p.shopNameEn !== undefined && (typeof p.shopNameEn !== "string" || p.shopNameEn.length > 150)) return "MALFORMED";
  if (typeof p.machineId !== "string" || !MACHINE_ID_PATTERN.test(p.machineId)) return "MALFORMED";
  if (!Number.isInteger(p.maxClients) || p.maxClients < 0 || p.maxClients > 1000) return "MALFORMED";
  if (typeof p.issuedAt !== "string" || Number.isNaN(Date.parse(p.issuedAt))) return "MALFORMED";
  return null;
};

module.exports = { PREFIX, KNOWN_TYPES, KNOWN_VERSIONS, MACHINE_ID_PATTERN, canonicalPayload, encodePayload, parseText, buildText, payloadProblem, b64u };
