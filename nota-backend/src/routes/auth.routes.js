const express = require("express");
const { createAuthController } = require("../controllers/auth.controller");
const { publicRoute, requireLogin } = require("../auth/middleware");

// Stage 13: /api/auth. Mounted only when NOTA_AUTH=1. `now` is for tests (lockout expiry).
function createAuthRouter({ secret, now } = {}) {
  const controller = createAuthController({ secret, now });
  const router = express.Router();

  router.get("/bootstrap", publicRoute(), controller.bootstrap);
  router.post("/setup-owner", publicRoute(), controller.setupOwner);
  router.post("/login", publicRoute(), controller.login);
  router.post("/recover", publicRoute(), controller.recover);

  router.get("/me", requireLogin(), controller.me);
  router.post("/change-password", requireLogin(), controller.changePassword);
  router.get("/permissions", requireLogin(), controller.permissionsCatalog);

  router.controller = controller;
  return router;
}

module.exports = { createAuthRouter };
