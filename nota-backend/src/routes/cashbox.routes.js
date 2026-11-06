const express = require("express");
const { requirePermission, requireLogin } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/cashbox.controller");

const router = express.Router();

// Stage 19: cash boxes, transfers and owner drawings (permissions enforced only with NOTA_AUTH=1).
router.get("/payment-boxes", requireLogin(), asyncHandler(controller.getPaymentBoxes));
router.get("/boxes", requirePermission("cashbox.view"), asyncHandler(controller.getBoxes));
router.post("/boxes", requirePermission("cashbox.manage"), asyncHandler(controller.createBox));
router.get("/boxes/:id", requirePermission("cashbox.view"), asyncHandler(controller.getBox));
router.put("/boxes/:id", requirePermission("cashbox.manage"), asyncHandler(controller.updateBox));
router.delete("/boxes/:id", requirePermission("cashbox.manage"), asyncHandler(controller.deleteBox));
router.get("/boxes/:id/ledger", requirePermission("cashbox.view"), asyncHandler(controller.getBoxLedger));
router.get("/transfers", requirePermission("cashbox.view"), asyncHandler(controller.getTransfers));
router.post("/transfers", requirePermission("cashbox.manage"), asyncHandler(controller.createTransfer));
router.post("/transfers/:id/cancel", requirePermission("cashbox.manage"), asyncHandler(controller.cancelTransfer));
router.get("/drawings", requirePermission("owner.drawings"), asyncHandler(controller.getDrawings));
router.post("/drawings", requirePermission("owner.drawings"), asyncHandler(controller.createDrawing));
router.post("/drawings/:id/cancel", requirePermission("owner.drawings"), asyncHandler(controller.cancelDrawing));

module.exports = router;
