const express = require("express");
const { getDashboardSummary } = require("../controllers/dashboard.controller");
const { requirePermission } = require("../auth/middleware");

const router = express.Router();

// Stage 12: read-only summary for the home dashboard. Stage 13: dashboard.view.
router.get("/summary", requirePermission("dashboard.view"), getDashboardSummary);

module.exports = router;
