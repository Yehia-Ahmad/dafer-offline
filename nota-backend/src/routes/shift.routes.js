const express = require("express");
const { requireAnyPermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/shift.controller");

const router = express.Router();

// Stage 19: shift.operate (your own shift) or shift.manage (every shift). The handlers apply the difference.
const shiftUser = requireAnyPermission("shift.operate", "shift.manage");
router.get("/", shiftUser, asyncHandler(controller.getShifts));
router.post("/", shiftUser, asyncHandler(controller.openShift));
router.get("/:id", shiftUser, asyncHandler(controller.getShift));
router.post("/:id/close", shiftUser, asyncHandler(controller.closeShift));

module.exports = router;
