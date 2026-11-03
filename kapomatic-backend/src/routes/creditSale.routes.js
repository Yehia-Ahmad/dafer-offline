const express = require("express");
const {
  createCreditSale,
  getCreditSales,
  getCreditSaleById,
  updateCreditSale,
  addCreditSalePayment,
  deleteCreditSale,
} = require("../controllers/creditSale.controller");

const router = express.Router();

router.route("/").get(getCreditSales).post(createCreditSale);
router.post("/:id/payments", addCreditSalePayment);
router.route("/:id").get(getCreditSaleById).put(updateCreditSale).delete(deleteCreditSale);

module.exports = router;
