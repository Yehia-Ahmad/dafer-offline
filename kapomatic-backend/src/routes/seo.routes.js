const express = require("express");
const { getSlugAvailability } = require("../controllers/publicSeo.controller");

const router = express.Router();

router.get("/slug-availability", getSlugAvailability);

module.exports = router;
