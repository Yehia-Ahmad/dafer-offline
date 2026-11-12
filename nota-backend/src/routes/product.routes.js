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
  restoreProduct,
} = require("../controllers/product.controller");
const { requirePermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const { getStockPrintData } = require("../controllers/printData.controller");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1). Profit plus revenue reveals cost, so the
// profit reports need products.viewCost as well; the Excel export holds purchase prices too.
const profit = requirePermission("reports.profit", "products.viewCost");
router
  .route("/")
  .get(requirePermission("products.view"), getProducts)
  .post(requirePermission("products.manage", "products.viewCost"), createProduct); // Stage 14: creating a product needs its cost
router.get("/print-data", requirePermission("products.view"), asyncHandler(getStockPrintData)); // Stage 23: the stock count sheet
router.get("/search", requirePermission("products.view"), searchProducts);
router.get("/export/excel", requirePermission("products.importExport", "products.viewCost"), exportProductsExcel);
router.get("/profit-report", profit, getProductsProfitReport);
router.get("/profit-bar", profit, getYearProfitBarChart);
router.post(
  "/:id/sync-purchase-price",
  requirePermission("products.syncPrice"),
  syncProductPurchasePriceToInvoices
);
router.get("/:id/profit-report", profit, getProductProfitReportById);
router.post("/:id/restore", requirePermission("products.manage"), restoreProduct);
router
  .route("/:id")
  .get(requirePermission("products.view"), getProductById)
  .put(requirePermission("products.manage"), updateProduct)
  .delete(requirePermission("products.manage"), deleteProduct);

module.exports = router;
