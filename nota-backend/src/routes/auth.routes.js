const express = require("express");
const { createAuthController } = require("../controllers/auth.controller");
const { localOnly, publicRoute, requireLogin } = require("../auth/middleware");

// Stage 13: /api/auth. Mounted only when NOTA_AUTH=1. `now` is for tests (lockout expiry).
function createAuthRouter({ secret, now } = {}) {
  const controller = createAuthController({ secret, now });
  const router = express.Router();

  router.get("/bootstrap", publicRoute(), controller.bootstrap);
  // Stage 14: only from the main PC itself (a client PC must not claim the owner or recover it).
  router.post("/setup-owner", publicRoute(), localOnly(), controller.setupOwner);
  router.post("/login", publicRoute(), controller.login);
  router.post("/recover", publicRoute(), localOnly(), controller.recover);

  router.get("/me", requireLogin(), controller.me);
  router.post("/change-password", requireLogin(), controller.changePassword);
  // Stage 15: lock screen / restore password check, and the 12-hour token refresh.
  router.post("/verify-password", requireLogin(), controller.verifyPassword);
  router.post("/refresh", requireLogin(), controller.refresh);
  router.get("/permissions", requireLogin(), controller.permissionsCatalog);

  router.controller = controller;
  return router;
}

module.exports = { createAuthRouter };
