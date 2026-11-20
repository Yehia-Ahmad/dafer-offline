// Online Stage 7A: campaigns. Reads need marketing.view, writes marketing.manage. Recording ad spend itself is the existing
// POST /api/expenses (expenses.create); only the category lookup lives here.
const express = require("express");
const c = require("../controllers/campaign.controller");
const metaLinks = require("../controllers/metaLinks.controller");
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();
const view = requirePermission("marketing.view");
const manage = requirePermission("marketing.manage");
const publishPermission = requirePermission("marketing.publish");
const metaPublish = require("../controllers/metaPublish.controller");

router.get("/", view, c.list);
router.post("/", manage, auditOnSuccess("campaign.created", "Campaign", (_req, body) => ({ name: body && body.name, code: body && body.code })), c.create);
// Fixed paths before /:id.
router.get("/results", view, c.results);
router.get("/ad-category", requirePermission("expenses.create", "marketing.view"), c.adCategory);
// Online Stage 7B: linking Meta campaigns (read-only data synced from Meta).
router.get("/meta-campaigns", manage, metaLinks.listMeta);
// Online Stage 7C: publishing and managing Facebook/Instagram campaigns (marketing.publish, owner only by default).
router.get("/meta-geo", publishPermission, metaPublish.geo);
router.get("/:id/publish/options", publishPermission, metaPublish.options);
router.post("/:id/publish", publishPermission, metaPublish.createDraft);
router.get("/:id/publish/:publishId", publishPermission, metaPublish.getOne);
router.post("/:id/publish/:publishId/preview", publishPermission, metaPublish.preview);
router.post("/:id/publish/:publishId/run", publishPermission, metaPublish.run);
router.post("/:id/publish/:publishId/cancel", publishPermission, metaPublish.cancel);
router.post("/:id/meta-links/:metaId/status", publishPermission, metaPublish.setStatus);
router.post("/:id/meta-links/:metaId/budget", publishPermission, metaPublish.setBudget);
router.post("/:id/meta-links/:metaId/end-time", publishPermission, metaPublish.setEndTime);
router.post("/:id/meta-links/:metaId/archive", publishPermission, metaPublish.archive);
router.post("/:id/meta-links/:metaId/refresh", publishPermission, metaPublish.refresh);
router.get("/:id", view, c.get);
router.get("/:id/meta-links", view, metaLinks.listLinks);
router.post("/:id/meta-links", manage, auditOnSuccess("campaign.meta.linked", "Campaign", (req) => ({ metaId: req.body && req.body.metaId })), metaLinks.link);
router.delete("/:id/meta-links/:metaId", manage, auditOnSuccess("campaign.meta.unlinked", "Campaign", (req) => ({ metaId: req.params.metaId })), metaLinks.unlink);
router.put("/:id", manage, auditOnSuccess("campaign.updated", "Campaign", (req) => ({ fields: Object.keys(req.body || {}) })), c.update);
router.get("/:id/results", view, c.campaignOnlyResults);
router.get("/:id/spend", view, c.spendList);

module.exports = router;
