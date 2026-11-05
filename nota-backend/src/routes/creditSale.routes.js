const express = require("express");
const {
  createCreditSale,
  getCreditSales,
  getCreditSaleById,
  updateCreditSale,
  addCreditSalePayment,
  cancelCreditSale,
} = require("../controllers/creditSale.controller");
const CreditSale = require("../models/creditSale.model");
const { requireDiscountPermission, requirePermission } = require("../auth/middleware");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1).
router
  .route("/")
  .get(requirePermission("credit.view"), getCreditSales)
  .post(requirePermission("credit.create"), requireDiscountPermission(CreditSale), createCreditSale);
router.post(
  "/:id/payments",
  requirePermission("credit.collect"),
  addCreditSalePayment
);
router
  .route("/:id")
  .get(requirePermission("credit.view"), getCreditSaleById)
  .put(
    requirePermission("credit.edit"),
    requireDiscountPermission(CreditSale),
    updateCreditSale
  );
router.post("/:id/cancel", requirePermission("credit.delete"), cancelCreditSale);

module.exports = router;
