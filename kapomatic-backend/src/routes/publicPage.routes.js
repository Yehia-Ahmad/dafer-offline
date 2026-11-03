const express = require("express");
const {
  getHeader,
  getHeaderLogo,
  getPublicHomePage,
} = require("../controllers/publicPage.controller");

const router = express.Router();

router.get("/header", getHeader);
router.get("/header/logo", getHeaderLogo);
router.get("/public/home-page", getPublicHomePage);

module.exports = router;
