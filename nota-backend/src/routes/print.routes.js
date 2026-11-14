const express = require("express");
const { confirmPrint, getJournalRef, releasePrint, reservePrint } = require("../controllers/print.controller");
const { requireLogin } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Stage 23: the permission depends on the document (its number prefix) and is checked in the controller.
router.post("/reserve", requireLogin(), asyncHandler(reservePrint));
router.post("/confirm", requireLogin(), asyncHandler(confirmPrint));
router.post("/release", requireLogin(), asyncHandler(releasePrint));

router.get("/journal-ref/:number", requireLogin(), asyncHandler(getJournalRef));

module.exports = router;
