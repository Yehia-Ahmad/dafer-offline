// Stage 24: the lock. Mounted on /api right after the LAN guard. With no valid license every route answers
// 402 LICENSE_REQUIRED, except the two license routes the activation screen needs (the health check `GET /` is not under /api).
// The result comes from the in-memory cache in ./index, never recomputed per request.
const license = require("./index");

const ALLOWED = new Set(["/license/status", "/license/activate"]);

const licenseRequiredError = () => {
  const error = new Error("النسخة دي مش مفعّلة. فعّل الترخيص الأول");
  error.statusCode = 402;
  error.responseData = { code: "LICENSE_REQUIRED", reason: license.summary().code };
  return error;
};

const requireLicense = () => (req, _res, next) => {
  if (req.method === "OPTIONS" || ALLOWED.has(req.path) || license.isValid()) return next();
  return next(licenseRequiredError());
};

module.exports = { requireLicense, licenseRequiredError };
