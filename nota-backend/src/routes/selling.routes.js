const express = require("express");
const {
  createSelling,
  getSellings,
  getSellingById,
  updateSelling,
  deleteSelling,
} = require("../controllers/selling.controller");
const Selling = require("../models/selling.model");
const { requireDiscountPermission, requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1).
router
  .route("/")
  .get(requirePermission("sales.view"), getSellings)
  .post(requirePermission("sales.create"), requireDiscountPermission(Selling), createSelling);
router
  .route("/:id")
  .get(requirePermission("sales.view"), getSellingById)
  .put(requirePermission("sales.edit"), requireDiscountPermission(Selling), auditOnSuccess("sale.updated", "Selling"), updateSelling)
  .delete(requirePermission("sales.delete"), auditOnSuccess("sale.deleted", "Selling"), deleteSelling);

module.exports = router;
