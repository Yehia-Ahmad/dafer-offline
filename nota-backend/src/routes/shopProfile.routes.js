const express = require("express");
const {
  getShopProfile,
  updateShopProfile,
} = require("../controllers/shopProfile.controller");

const router = express.Router();

router.route("/").get(getShopProfile).put(updateShopProfile);

module.exports = router;
