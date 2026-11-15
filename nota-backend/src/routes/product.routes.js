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
  getProductByBarcode,
  generateProductBarcode,
  countProductsWithoutBarcode,
  generateMissingBarcodes,
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
// Stage 26: barcodes. The scan lookup has the same permission (and the same fields) as the POS search;
// generating barcodes is editing products.
router.get("/by-barcode/:code", requirePermission("products.view"), getProductByBarcode);
router.post("/barcodes/generate", requirePermission("products.manage"), generateProductBarcode);
router.get("/barcodes/missing-count", requirePermission("products.manage"), countProductsWithoutBarcode);
router.post("/barcodes/generate-missing", requirePermission("products.manage"), generateMissingBarcodes);
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
