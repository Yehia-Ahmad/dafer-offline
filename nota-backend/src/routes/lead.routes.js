// Online Stage 7A: leads. Reads: leads.manage or marketing.view. Writes and import: leads.manage.
const express = require("express");
const c = require("../controllers/lead.controller");
const { requirePermission, requireAnyPermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();
const view = requireAnyPermission("leads.manage", "marketing.view");
const manage = requirePermission("leads.manage");

router.get("/", view, c.list);
router.post("/", manage, auditOnSuccess("lead.created", "Lead", (_req, body) => ({ source: body && body.source })), c.create);
// Fixed paths before /:id.
router.post("/import/mapping", manage, c.importMapping);
router.post("/import/preview", manage, c.importPreview);
router.post("/import", manage, auditOnSuccess("lead.imported", "Lead", (_req, body) => ({ imported: body && body.imported, updated: body && body.updated, skipped: body && body.skipped, invalid: body && body.invalid })), c.importCommit);
router.get("/:id", view, c.get);
router.put("/:id", manage, auditOnSuccess("lead.updated", "Lead", (req) => ({ fields: Object.keys(req.body || {}) })), c.update);
router.post("/:id/notes", manage, c.addNote);

module.exports = router;
