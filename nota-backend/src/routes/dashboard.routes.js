const express = require("express");
const { getDashboardSummary, getMobileSummary } = require("../controllers/dashboard.controller");
const { requireLogin, requirePermission } = require("../auth/middleware");

const router = express.Router();

// Stage 12: read-only summary for the home dashboard. Stage 13: dashboard.view.
router.get("/summary", requirePermission("dashboard.view"), getDashboardSummary);
// Online Stage 6A: the phone home's extra numbers. Signed-in; every block is filtered inside by its own permission.
router.get("/mobile-summary", requireLogin(), getMobileSummary);

module.exports = router;
