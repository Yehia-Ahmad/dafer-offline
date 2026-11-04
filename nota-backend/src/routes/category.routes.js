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

const router = express.Router();

router.route("/").get(getCategories).post(createCategory);
// Static import/export routes must be registered before /:id.
router.get("/export", exportCategoriesExcel);
router.post("/import", uploadCategoryWorkbook, importCategoriesExcel);
router.route("/:id").get(getCategoryById).put(updateCategory).delete(deleteCategory);

module.exports = router;
