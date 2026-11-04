const express = require("express");
const { getDashboardSummary } = require("../controllers/dashboard.controller");

const router = express.Router();

// Stage 12: read-only summary for the home dashboard.
router.get("/summary", getDashboardSummary);

module.exports = router;
