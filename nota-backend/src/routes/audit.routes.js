const express = require("express");
const { listAudit } = require("../controllers/audit.controller");
const { requirePermission } = require("../auth/middleware");

// Stage 13: /api/audit.
const router = express.Router();

router.get("/", requirePermission("audit.view"), listAudit);

module.exports = router;
