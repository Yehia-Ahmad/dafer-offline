const express = require("express");
const { requirePermission, requireAnyPermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/vat.controller");

const router = express.Router();

// Stage 21: the monthly VAT return. Viewing needs vat.file or accounting.view; filing, paying and unfiling need vat.file
// (unfiling is also owner only, checked in the handler).
const seesVat = requireAnyPermission("vat.file", "accounting.view");
router.get("/returns", seesVat, asyncHandler(controller.listReturns));
router.get("/returns/:period", seesVat, asyncHandler(controller.getReturn));
router.get("/returns/:period/export", seesVat, asyncHandler(controller.exportReturn));
router.post("/returns/:period/file", requirePermission("vat.file"), asyncHandler(controller.fileReturn));
router.post("/returns/:period/pay", requirePermission("vat.file"), asyncHandler(controller.payReturn));
router.post("/returns/:period/unfile", requirePermission("vat.file"), asyncHandler(controller.unfileReturn));

module.exports = router;
