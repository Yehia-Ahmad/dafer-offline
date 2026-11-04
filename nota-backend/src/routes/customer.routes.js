const express = require("express");
const {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  addCustomerCreditSalePayment,
  deleteCustomer,
} = require("../controllers/customer.controller");
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1).
const paymentDetails = (req) => ({ amount: Number(req.body && req.body.amount) || undefined });

router
  .route("/")
  .get(requirePermission("customers.view"), getCustomers)
  .post(requirePermission("customers.manage"), createCustomer);
router.post(
  "/:id/payments",
  requirePermission("credit.collect"),
  auditOnSuccess("credit.payment", "Customer", paymentDetails),
  addCustomerCreditSalePayment
);
router
  .route("/:id")
  .get(requirePermission("customers.view"), getCustomerById)
  .put(requirePermission("customers.manage"), updateCustomer)
  .delete(requirePermission("customers.manage"), deleteCustomer);

module.exports = router;
