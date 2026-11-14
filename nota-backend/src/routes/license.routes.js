// Stage 24: license endpoints. Mounted BEFORE requireAuth (the activation screen has no session), so each route
// decides for itself:
//   GET  /status    public: licensed?, this PC's Machine ID, the shop name
//   POST /activate  no license installed: open, from this PC only (first run, before any owner exists);
//                   a valid license installed: only the signed-in owner with shop.manage may replace it
//   GET  /info      owner with shop.manage: the full license + how many client PCs are paired
const express = require("express");
const license = require("../license");
const service = require("../license/service");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth, requirePermission, localOnly, publicRoute } = require("../auth/middleware");
const { clientSlots, unpair, allow } = require("../license/clients");
const { resetDeviceThrottle } = require("../middlewares/device.middleware");

const httpError = (statusCode, code, message, extra = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code, ...extra };
  return error;
};

const ownerOnly = (req, _res, next) => {
  if (req.authEnabled && (!req.user || req.user.role !== "owner")) {
    return next(httpError(403, "FORBIDDEN", "تغيير الترخيص للمالك فقط"));
  }
  return next();
};

const runChain = (handlers, req, res, next) => {
  let index = 0;
  const step = (error) => {
    if (error) return next(error);
    const handler = handlers[index++];
    if (!handler) return next();
    return handler(req, res, step);
  };
  step();
};

const createLicenseRouter = ({ secret, sessionsValidAfter = 0 } = {}) => {
  const router = express.Router();
  const session = () => (secret ? [requireAuth(secret, { sessionsValidAfter })] : []);

  router.get("/status", publicRoute(), (_req, res) => res.json(license.summary()));

  // Tagged PUBLIC for the route-coverage test: with no license it needs no login. With one installed, the owner check below applies.
  router.post("/activate", publicRoute(), (req, res, next) => {
    if (!license.isValid()) return runChain([localOnly()], req, res, next);
    return runChain([...session(), requirePermission("shop.manage"), ownerOnly], req, res, next);
  }, asyncHandler(async (req, res) => {
    const text = req.body && typeof req.body.license === "string" ? req.body.license : "";
    const result = await service.activate(text, req.user);
    if (!result.ok) throw httpError(400, "LICENSE_INVALID", "الترخيص ده مش صالح لهذا الجهاز", { reason: result.code });
    res.json({ ...license.summary(), license: license.details() });
  }));

  router.get("/info", ...session(), requirePermission("shop.manage"), ownerOnly,
    asyncHandler(async (_req, res) => {
      const details = license.details();
      if (!details) throw httpError(402, "LICENSE_REQUIRED", "النسخة دي مش مفعّلة");
      res.json({ ...details, ...(await clientSlots(details.maxClients)) });
    }));

  // The owner lets a revoked (unpaired) PC pair again. It still needs a free slot and pairs itself the next time it signs in.
  router.post("/clients/:deviceId/allow", ...session(), requirePermission("shop.manage"), ownerOnly,
    asyncHandler(async (req, res) => {
      if (!(await allow(req.params.deviceId))) throw httpError(404, "NOT_FOUND", "الجهاز ده مش مفصول");
      resetDeviceThrottle();
      res.json({ allowed: true });
    }));

  // Frees one client PC's slot and revokes it: it cannot pair itself again until the owner allows it (above).
  router.delete("/clients/:deviceId", ...session(), requirePermission("shop.manage"), ownerOnly,
    asyncHandler(async (req, res) => {
      const done = await unpair(req.params.deviceId);
      if (!done) throw httpError(404, "NOT_FOUND", "الجهاز ده مش مقترن بالنسخة");
      resetDeviceThrottle();
      res.json({ unpaired: true });
    }));

  return router;
};

module.exports = { createLicenseRouter };
