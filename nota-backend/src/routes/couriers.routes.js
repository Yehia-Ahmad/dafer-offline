// Online Stage 4: couriers. Writes need website.manage AND customers.manage (a courier is also a customer account);
// reading them (the dispatch dialog, the orders list) needs orders.view or website.manage.
const express = require("express");
const c = require("../controllers/couriers.controller");
const { requirePermission, requireAnyPermission } = require("../auth/middleware");

const router = express.Router();
const read = requireAnyPermission("orders.view", "website.manage");
const write = requirePermission("website.manage", "customers.manage");

router.route("/").get(read, c.list).post(write, c.create);
router.route("/:id").get(read, c.getOne).put(write, c.update);

module.exports = router;
