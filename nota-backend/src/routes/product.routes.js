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
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1). Profit plus revenue reveals cost, so the
// profit reports need products.viewCost as well; the Excel export holds purchase prices too.
const profit = requirePermission("reports.profit", "products.viewCost");
const syncDetails = (_req, body) => ({
  dateFrom: body && body.dateFrom,
  dateTo: body && body.dateTo,
  updatedInvoices: body && body.updatedInvoices,
});

router
  .route("/")
  .get(requirePermission("products.view"), getProducts)
  .post(requirePermission("products.manage"), createProduct);
router.get("/search", requirePermission("products.view"), searchProducts);
router.get("/export/excel", requirePermission("products.importExport", "products.viewCost"), exportProductsExcel);
router.get("/profit-report", profit, getProductsProfitReport);
router.get("/profit-bar", profit, getYearProfitBarChart);
router.post(
  "/:id/sync-purchase-price",
  requirePermission("products.syncPrice"),
  auditOnSuccess("product.sync_purchase_price", "Product", syncDetails),
  syncProductPurchasePriceToInvoices
);
router.get("/:id/profit-report", profit, getProductProfitReportById);
router
  .route("/:id")
  .get(requirePermission("products.view"), getProductById)
  .put(requirePermission("products.manage"), updateProduct)
  .delete(requirePermission("products.manage"), auditOnSuccess("product.deleted", "Product"), deleteProduct);

module.exports = router;
