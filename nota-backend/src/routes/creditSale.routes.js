const express = require("express");
const {
  createCreditSale,
  getCreditSales,
  getCreditSaleById,
  updateCreditSale,
  addCreditSalePayment,
  deleteCreditSale,
} = require("../controllers/creditSale.controller");
const CreditSale = require("../models/creditSale.model");
const { requireDiscountPermission, requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1).
const paymentDetails = (req) => ({ amount: Number(req.body && req.body.amount) || undefined });

router
  .route("/")
  .get(requirePermission("credit.view"), getCreditSales)
  .post(requirePermission("credit.create"), requireDiscountPermission(CreditSale), createCreditSale);
router.post(
  "/:id/payments",
  requirePermission("credit.collect"),
  auditOnSuccess("credit.payment", "CreditSale", paymentDetails),
  addCreditSalePayment
);
router
  .route("/:id")
  .get(requirePermission("credit.view"), getCreditSaleById)
  .put(
    requirePermission("credit.edit"),
    requireDiscountPermission(CreditSale),
    auditOnSuccess("credit.updated", "CreditSale"),
    updateCreditSale
  )
  .delete(requirePermission("credit.delete"), auditOnSuccess("credit.deleted", "CreditSale"), deleteCreditSale);

module.exports = router;
