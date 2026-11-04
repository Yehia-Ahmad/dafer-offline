const router = require("express").Router();
const {
  createReturn,
  getReturns,
  getReturnById,
  getReturnsSummary,
} = require("../controllers/returns.controller");
router.get("/summary", getReturnsSummary);
router.route("/").get(getReturns).post(createReturn);
router.get("/:id", getReturnById);
module.exports = router;
