const router = require("express").Router();
const {
  createReturn,
  getReturns,
  getReturnById,
  getReturnsSummary,
} = require("../controllers/returns.controller");
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

// Stage 13: permissions (enforced only with NOTA_AUTH=1). createReturn sets req.params.id to the
// invoice id, so the audit entry names the invoice.
const returnDetails = (req) => ({ returnType: req.body && req.body.returnType });

router.get("/summary", requirePermission("returns.view"), getReturnsSummary);
router
  .route("/")
  .get(requirePermission("returns.view"), getReturns)
  .post(requirePermission("returns.create"), auditOnSuccess("return.created", "Return", returnDetails), createReturn);
router.get("/:id", requirePermission("returns.view"), getReturnById);
module.exports = router;
