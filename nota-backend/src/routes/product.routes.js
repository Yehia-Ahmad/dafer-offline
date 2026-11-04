const express = require("express");
const {
  getProducts,
  searchProducts,
  getProductById,
  exportProductsExcel,
  getProductsProfitReport,
  getProductProfitReportById,
  syncProductPurchasePriceToInvoices,
  getYearProfitBarChart,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("../controllers/product.controller");

const router = express.Router();

router.route("/").get(getProducts).post(createProduct);
router.get("/search", searchProducts);
router.get("/export/excel", exportProductsExcel);
router.get("/profit-report", getProductsProfitReport);
router.get("/profit-bar", getYearProfitBarChart);
router.post("/:id/sync-purchase-price", syncProductPurchasePriceToInvoices);
router.get("/:id/profit-report", getProductProfitReportById);
router.route("/:id").get(getProductById).put(updateProduct).delete(deleteProduct);

module.exports = router;
