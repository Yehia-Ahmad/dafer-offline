const express = require("express");
const { requirePermission } = require("../auth/middleware");
const controller = require("../controllers/supplier.controller");
const account = require("../controllers/supplierAccount.controller");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Stage 18: suppliers (permissions enforced only with NOTA_AUTH=1, like every other route).
router
  .route("/")
  .get(requirePermission("suppliers.view"), controller.getSuppliers)
  .post(requirePermission("suppliers.manage"), controller.createSupplier);
router
  .route("/:id")
  .get(requirePermission("suppliers.view"), controller.getSupplierById)
  .put(requirePermission("suppliers.manage"), controller.updateSupplier)
  .delete(requirePermission("suppliers.manage"), controller.deleteSupplier);

// Stage 20: statement, payments (PV) and refunds (SR).
router.get("/:id/statement", requirePermission("suppliers.view"), asyncHandler(account.getStatement));
router.get("/:id/payments", requirePermission("suppliers.view"), asyncHandler(account.getPayments));
router.post("/:id/payments", requirePermission("suppliers.pay"), asyncHandler(account.createPayment));
router.get("/:id/refunds", requirePermission("suppliers.view"), asyncHandler(account.getRefunds));
router.post("/:id/refunds", requirePermission("suppliers.pay"), asyncHandler(account.createRefund));

module.exports = router;
