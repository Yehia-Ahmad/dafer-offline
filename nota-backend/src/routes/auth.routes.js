const express = require("express");
const { createAuthController } = require("../controllers/auth.controller");
const { publicRoute, requireLogin } = require("../auth/middleware");

// Stage 13: /api/auth. `now` is for tests (lockout expiry). The owner is created and recovered on the
// server only (npm run create-owner / recover-owner), never over HTTP.
function createAuthRouter({ secret, now } = {}) {
  const controller = createAuthController({ secret, now });
  const router = express.Router();

  router.get("/bootstrap", publicRoute(), controller.bootstrap);
  router.post("/login", publicRoute(), controller.login);

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
