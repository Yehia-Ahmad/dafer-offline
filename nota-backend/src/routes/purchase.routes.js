const express = require("express");
const { requirePermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/purchase.controller");
const { getPurchasePrintData } = require("../controllers/printData.controller");

const router = express.Router();

// Stage 20: purchases (permissions enforced only with NOTA_AUTH=1, like every other route).
router.get("/", requirePermission("purchases.view"), asyncHandler(controller.getPurchases));
router.post("/", requirePermission("purchases.create"), asyncHandler(controller.createPurchase));
router.get("/:id/print-data", requirePermission("purchases.view"), asyncHandler(getPurchasePrintData));
router.get("/:id", requirePermission("purchases.view"), asyncHandler(controller.getPurchase));
router.post("/:id/cancel", requirePermission("purchases.cancel"), asyncHandler(controller.cancelPurchase));
router.post("/:id/returns", requirePermission("purchases.create"), asyncHandler(controller.createPurchaseReturn));

module.exports = router;
