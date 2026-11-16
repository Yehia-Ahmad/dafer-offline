const express = require("express");
const { requirePermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/cashbox.controller");

const router = express.Router();

// Stage 19: the devices (browsers) seen by the backend (for binding a drawer to a device).
router.get("/", requirePermission("cashbox.manage"), asyncHandler(controller.getDevices));

module.exports = router;
