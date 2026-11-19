const express = require("express");
const {
  customerByPhone,
  createSelling,
  getSellings,
  getSellingById,
  updateSelling,
  cancelSelling,
} = require("../controllers/selling.controller");
const Selling = require("../models/selling.model");
const { requireAnyPermission, requireDiscountPermission, requirePermission } = require("../auth/middleware");

const router = express.Router();

// Stage 13: permissions (always enforced).
router
  .route("/")
  .get(requirePermission("sales.view"), getSellings)
  .post(requirePermission("sales.create"), requireDiscountPermission(Selling), createSelling);
// Online Fixes 1: is this phone already a customer? (before "/:id")
router.get("/customer-by-phone", requireAnyPermission("sales.create", "credit.create"), customerByPhone);
router
  .route("/:id")
  .get(requirePermission("sales.view"), getSellingById)
  .put(requirePermission("sales.edit"), requireDiscountPermission(Selling), updateSelling);
router.post("/:id/cancel", requirePermission("sales.delete"), cancelSelling);

module.exports = router;
