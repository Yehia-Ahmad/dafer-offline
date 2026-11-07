const express = require("express");
const { requirePermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/supplierAccount.controller");

const router = express.Router();

// Stage 20: a payment voucher is cancelled by whoever may pay suppliers.
router.post("/:id/cancel", requirePermission("suppliers.pay"), asyncHandler(controller.cancelPayment));

module.exports = router;
