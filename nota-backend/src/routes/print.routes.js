const express = require("express");
const { getJournalRef, getNextCopy, logPrint } = require("../controllers/print.controller");
const { requireLogin } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Stage 23: the permission depends on the document (its number prefix) and is checked in the controller.
router.get("/next-copy", requireLogin(), asyncHandler(getNextCopy));
router.post("/log", requireLogin(), asyncHandler(logPrint));

router.get("/journal-ref/:number", requireLogin(), asyncHandler(getJournalRef));

module.exports = router;
