const express = require("express");
const {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  addCustomerCreditSalePayment,
  deleteCustomer,
} = require("../controllers/customer.controller");

const router = express.Router();

router.route("/").get(getCustomers).post(createCustomer);
router.post("/:id/payments", addCustomerCreditSalePayment);
router.route("/:id").get(getCustomerById).put(updateCustomer).delete(deleteCustomer);

module.exports = router;
