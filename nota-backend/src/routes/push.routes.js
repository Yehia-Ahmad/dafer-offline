const express = require("express");
const { requireLogin } = require("../auth/middleware");
const controller = require("../controllers/push.controller");

const router = express.Router();

// Online Stage 6A: Web Push subscriptions. Any signed-in user, own subscriptions only.
router.get("/public-key", requireLogin(), controller.getPublicKey);
router.post("/subscribe", requireLogin(), controller.subscribe);
router.delete("/subscribe", requireLogin(), controller.unsubscribe);

module.exports = router;
