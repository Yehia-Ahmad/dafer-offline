const express = require("express");
const { getLanInfo } = require("../controllers/lan.controller");

const router = express.Router();

router.get("/info", getLanInfo);

module.exports = router;
