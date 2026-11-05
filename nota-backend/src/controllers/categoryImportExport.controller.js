const asyncHandler = require("../utils/asyncHandler");
const {
  exportCategories,
  importCategories,
} = require("../services/categoryImportExport.service");
const {
  CategoryWorkbookValidationError,
} = require("../helpers/categoryWorkbook.helper");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");

const exportCategoriesExcel = asyncHandler(async (_req, res) => {
  const workbookBuffer = await exportCategories();
  const date = new Date().toISOString().slice(0, 10);

  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="categories-${date}.xlsx"`,
    "Content-Length": workbookBuffer.length,
  });
  res.send(workbookBuffer);
});

const importCategoriesExcel = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error("An .xlsx file is required in the 'file' form-data field");
  }

  try {
    const result = await withTransaction(async (session) => {
      const imported = await importCategories(req.file.buffer, session);
      if (imported.errors.length || imported.productErrors.length) {
        const error = new Error("تعذر استيراد الملف. لم يتم حفظ أي صف.");
        error.statusCode = 400;
        error.responseData = {
          ...imported,
          success: false,
          code: "CATEGORY_IMPORT_FAILED",
          importedCount: 0,
          productImportedCount: 0,
        };
        throw error;
      }
      await audit(req, { action: "category.import", entity: "Category", details: imported, session, strict: true });
      return imported;
    });
    res.json(result);
  } catch (error) {
    if (error instanceof CategoryWorkbookValidationError) {
      res.status(400);
    }
    throw error;
  }
});

module.exports = {
  exportCategoriesExcel,
  importCategoriesExcel,
};
