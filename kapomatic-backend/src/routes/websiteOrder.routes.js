const express = require("express");
const {
  confirmWebsiteOrder,
  getAcceptedWebsiteOrders,
  getPendingWebsiteOrders,
  getRefundedWebsiteOrders,
  getWebsiteOrders,
  refundWebsiteOrder,
} = require("../controllers/websiteOrder.controller");

const router = express.Router();

router.get("/", getWebsiteOrders);
router.get("/pending", getPendingWebsiteOrders);
router.get("/accepted", getAcceptedWebsiteOrders);
router.get("/refunded", getRefundedWebsiteOrders);
router.post("/:id/confirm", confirmWebsiteOrder);
router.post("/:id/refund", refundWebsiteOrder);

module.exports = router;
