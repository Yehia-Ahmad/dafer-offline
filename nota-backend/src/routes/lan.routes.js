const express = require("express");
const { getLanInfo } = require("../controllers/lan.controller");
const { publicRoute } = require("../auth/middleware");

const router = express.Router();

// Stage 13: no login needed (the LAN key still is). Client PCs call it before anyone signs in.
router.get("/info", publicRoute(), getLanInfo);

module.exports = router;
