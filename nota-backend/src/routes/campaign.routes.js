// Online Stage 7A: campaigns. Reads need marketing.view, writes marketing.manage. Recording ad spend itself is the existing
// POST /api/expenses (expenses.create); only the category lookup lives here.
const express = require("express");
const c = require("../controllers/campaign.controller");
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();
const view = requirePermission("marketing.view");
const manage = requirePermission("marketing.manage");

router.get("/", view, c.list);
router.post("/", manage, auditOnSuccess("campaign.created", "Campaign", (_req, body) => ({ name: body && body.name, code: body && body.code })), c.create);
// Fixed paths before /:id.
router.get("/results", view, c.results);
router.get("/ad-category", requirePermission("expenses.create", "marketing.view"), c.adCategory);
router.get("/:id", view, c.get);
router.put("/:id", manage, auditOnSuccess("campaign.updated", "Campaign", (req) => ({ fields: Object.keys(req.body || {}) })), c.update);
router.get("/:id/results", view, c.campaignOnlyResults);
router.get("/:id/spend", view, c.spendList);

module.exports = router;
