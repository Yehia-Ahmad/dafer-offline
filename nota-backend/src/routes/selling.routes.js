const express = require("express");
const {
  createSelling,
  getSellings,
  getSellingById,
  updateSelling,
  cancelSelling,
} = require("../controllers/selling.controller");
const Selling = require("../models/selling.model");
const { requireDiscountPermission, requirePermission } = require("../auth/middleware");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1).
router
  .route("/")
  .get(requirePermission("sales.view"), getSellings)
  .post(requirePermission("sales.create"), requireDiscountPermission(Selling), createSelling);
router
  .route("/:id")
  .get(requirePermission("sales.view"), getSellingById)
  .put(requirePermission("sales.edit"), requireDiscountPermission(Selling), updateSelling);
router.post("/:id/cancel", requirePermission("sales.delete"), cancelSelling);

module.exports = router;
