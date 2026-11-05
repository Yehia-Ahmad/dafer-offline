// Stage 13: writes AuditLog entries. Only when auth is on for this request (req.authEnabled, set
// by app.js); with auth off there is no user to name and nothing is written.
// Never stores passwords, hashes, tokens, secrets or recovery codes: details go through `safeDetails`.
const AuditLog = require("../models/auditLog.model");

const SECRET_KEY = /pass|hash|token|secret|recovery|authorization/i;
const MAX_STRING = 200;
const MAX_DEPTH = 3;

/** A small copy of `details` without secret-looking keys (any depth), long strings cut. */
const safeDetails = (value, depth = 0) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  if (typeof value.toHexString === "function") return value.toHexString();
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeDetails(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      const safe = safeDetails(item, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return undefined;
};

/**
 * Records one action. `user` defaults to req.user. Failures are logged and swallowed: an audit
 * problem must never break the request it describes.
 */
async function audit(req, { action, entity, entityId, details, user, session, strict = false } = {}) {
  if (!req || !req.authEnabled) return;
  const actor = user || (req && req.user) || null;
  try {
    const entry = {
      at: new Date(),
      userId: actor ? actor._id : undefined,
      userName: actor ? actor.name : undefined,
      action,
      entity,
      entityId: entityId === undefined || entityId === null ? undefined : String(entityId),
      details: safeDetails(details),
      ip: req ? req.ip : undefined,
    };
    if (session) await AuditLog.create([entry], { session });
    else await AuditLog.create(entry);
  } catch (error) {
    if (strict) throw error;
    console.error(`audit log failed for ${action}: ${error.message}`);
  }
}

const idOf = (body) => {
  if (!body || typeof body !== "object") return undefined;
  const candidate = body._id || body.id || (body.data && (body.data._id || body.data.id));
  return candidate === undefined ? undefined : String(candidate);
};

/**
 * Route middleware: after a successful (2xx) response, record `action` on `entity`.
 * detailsFn(req, responseBody) returns a small details object (optional).
 */
const auditOnSuccess = (action, entity, detailsFn) => (req, res, next) => {
  if (!req.authEnabled) return next();
  let responseBody;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };
  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    let details;
    try {
      details = detailsFn ? detailsFn(req, responseBody) : undefined;
    } catch {
      details = undefined;
    }
    audit(req, { action, entity, entityId: req.params.id || idOf(responseBody), details });
  });
  return next();
};

module.exports = { audit, auditOnSuccess, safeDetails };
