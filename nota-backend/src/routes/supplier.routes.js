const express = require("express");
const { requirePermission } = require("../auth/middleware");
const controller = require("../controllers/supplier.controller");

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

module.exports = router;
