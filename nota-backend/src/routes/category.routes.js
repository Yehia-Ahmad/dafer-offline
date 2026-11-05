const express = require("express");
const {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("../controllers/category.controller");
const {
  exportCategoriesExcel,
  importCategoriesExcel,
} = require("../controllers/categoryImportExport.controller");
const uploadCategoryWorkbook = require("../middlewares/categoryImportUpload.middleware");
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();

// Stage 13: permissions (enforced only with NOTA_AUTH=1). The import result's counts go in the audit log.
const importCounts = (_req, body) =>
  Object.fromEntries(Object.entries(body || {}).filter(([, value]) => typeof value === "number"));

router
  .route("/")
  .get(requirePermission("products.view"), getCategories)
  .post(requirePermission("categories.manage"), createCategory);
// Static import/export routes must be registered before /:id.
// The workbook holds purchase prices: exporting needs products.viewCost too.
router.get("/export", requirePermission("products.importExport", "products.viewCost"), exportCategoriesExcel);
router.post(
  "/import",
  requirePermission("products.importExport", "categories.manage"),
  uploadCategoryWorkbook,
  importCategoriesExcel
);
router
  .route("/:id")
  .get(requirePermission("products.view"), getCategoryById)
  .put(requirePermission("categories.manage"), updateCategory)
  // Deleting a category also deletes all of its products.
  .delete(requirePermission("categories.manage", "products.manage"), deleteCategory);

module.exports = router;
