const express = require("express");
const { requirePermission, requireAnyPermission } = require("../auth/middleware");
const asyncHandler = require("../utils/asyncHandler");
const controller = require("../controllers/expense.controller");

const router = express.Router();

// Stage 19: expenses.create records, expenses.manage cancels and manages categories.
const seesExpenses = requireAnyPermission("expenses.create", "expenses.manage", "cashbox.view");
router.get("/categories", seesExpenses, asyncHandler(controller.getCategories));
router.post("/categories", requirePermission("expenses.manage"), asyncHandler(controller.createCategory));
router.put("/categories/:id", requirePermission("expenses.manage"), asyncHandler(controller.updateCategory));
router.get("/", seesExpenses, asyncHandler(controller.getExpenses));
router.post("/", requirePermission("expenses.create"), asyncHandler(controller.createExpense));
router.post("/:id/cancel", requirePermission("expenses.manage"), asyncHandler(controller.cancelExpense));

module.exports = router;
