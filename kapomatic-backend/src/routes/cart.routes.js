const express = require("express");
const { checkoutCart } = require("../controllers/selling.controller");

const router = express.Router();

router.post("/checkout", checkoutCart);

module.exports = router;
