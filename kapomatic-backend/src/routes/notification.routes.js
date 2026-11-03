const express = require("express");
const {
  registerDevice,
  unregisterDevice,
} = require("../controllers/notification.controller");
const { requireNotificationsApiKey } = require("../middlewares/notificationsApiKey.middleware");

const router = express.Router();

router.use(requireNotificationsApiKey);

router.post("/devices", registerDevice);
router.delete("/devices/:token", unregisterDevice);

module.exports = router;
