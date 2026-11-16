const express = require("express");
const {
  getShopProfile,
  updateShopProfile,
} = require("../controllers/shopProfile.controller");
const { requireLogin, requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();

// Stage 13: every signed-in user may read it (all roles print invoices);
// changing it needs shop.manage.
router
  .route("/")
  .get(requireLogin(), getShopProfile)
  .put(requirePermission("shop.manage"), auditOnSuccess("shop.updated", "ShopProfile"), updateShopProfile);

module.exports = router;
