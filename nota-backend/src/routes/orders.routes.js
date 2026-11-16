// Online Stage 4: website orders (admin). Dispatch, delivery and refusal also need the permission of the document they create
// (credit.create, credit.collect, returns.create): requirePermission needs ALL its keys, the same way the existing routes check them.
// Delivered with returned lines also needs returns.create (checked in the service, when the body has returns).
const express = require("express");
const c = require("../controllers/orders.controller");
const { requirePermission } = require("../auth/middleware");

const router = express.Router();

router.get("/", requirePermission("orders.view"), c.list);
router.get("/summary", requirePermission("orders.view"), c.summary);
router.get("/delivery-zones", requirePermission("orders.manage"), c.zones);
router.get("/:id", requirePermission("orders.view"), c.getOne);
router.put("/:id", requirePermission("orders.manage"), c.edit);
router.post("/:id/confirm", requirePermission("orders.manage"), c.confirm);
router.post("/:id/prepare", requirePermission("orders.manage"), c.prepare);
router.post("/:id/reject", requirePermission("orders.manage"), c.reject);
router.post("/:id/cancel", requirePermission("orders.manage"), c.cancel);
router.post("/:id/dispatch", requirePermission("orders.dispatch", "credit.create"), c.dispatch);
router.post("/:id/deliver", requirePermission("orders.dispatch", "credit.collect"), c.deliver);
router.post("/:id/refuse", requirePermission("orders.dispatch", "returns.create"), c.refuse);

module.exports = router;
