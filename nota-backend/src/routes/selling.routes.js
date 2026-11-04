const express = require("express");
const {
  createSelling,
  getSellings,
  getSellingById,
  updateSelling,
  deleteSelling,
} = require("../controllers/selling.controller");

const router = express.Router();

router.route("/").get(getSellings).post(createSelling);
router.route("/:id").get(getSellingById).put(updateSelling).delete(deleteSelling);

module.exports = router;
