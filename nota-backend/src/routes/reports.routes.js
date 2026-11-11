const express = require("express");
const { requirePermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/reports.controller");

// Stage 22: the financial reports, read-only. One permission: reports.financial (owner, manager, accountant).
const router = express.Router();
const financial = requirePermission("reports.financial");
router.get("/income-statement", financial, asyncHandler(controller.getIncomeStatement));
router.get("/balance-sheet", financial, asyncHandler(controller.getBalanceSheet));
router.get("/trial-balance", financial, asyncHandler(controller.getTrialBalance));
router.get("/box-movements", financial, asyncHandler(controller.getBoxMovements));
router.get("/party-balances", financial, asyncHandler(controller.getPartyBalances));
module.exports = router;
