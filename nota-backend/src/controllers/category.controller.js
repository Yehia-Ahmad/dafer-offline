const Category = require("../models/category.model");
const Product = require("../models/product.model");
const asyncHandler = require("../utils/asyncHandler");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");

const getSpecificationsFromBody = (body) =>
  body.specifications !== undefined ? body.specifications : body.Specifications;

const validateSpecifications = (specifications, res) => {
  if (specifications === undefined) return undefined;

  if (
    !Array.isArray(specifications) ||
    specifications.some(
      (specification) =>
        !specification ||
        typeof specification !== "object" ||
        Array.isArray(specification)
    )
  ) {
    res.status(400);
    throw new Error("يجب أن تكون المواصفات مصفوفة من الكائنات");
  }

  return specifications;
};

const getCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find().sort({ createdAt: 1 });
  // Stage 12 (additive): number of products in each category.
  const counts = await Product.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }]);
  const countByCategory = new Map(counts.map((entry) => [String(entry._id), entry.count]));
  res.json(
    categories.map((category) => ({
      ...category.toJSON(),
      productCount: countByCategory.get(String(category._id)) || 0,
    }))
  );
});

const getCategoryById = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  res.json(category);
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, image, imageBase64 } = req.body;
  const normalizedImage = imageBase64 !== undefined ? imageBase64 : image;
  const specifications = validateSpecifications(
    getSpecificationsFromBody(req.body),
    res
  );

  const categoryData = {
    name,
  };

  if (normalizedImage !== undefined) {
    categoryData.image = normalizedImage;
  }

  if (specifications !== undefined) {
    categoryData.specifications = specifications;
  }

  const category = await Category.create(categoryData);

  res.status(201).json(category);
});

const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  if (req.body.name !== undefined) category.name = req.body.name;
  if (req.body.imageBase64 !== undefined) {
    category.image = req.body.imageBase64;
  } else if (req.body.image !== undefined) {
    category.image = req.body.image;
  }
  const specifications = validateSpecifications(
    getSpecificationsFromBody(req.body),
    res
  );
  if (specifications !== undefined) category.specifications = specifications;

  const updatedCategory = await category.save();
  res.json(updatedCategory);
});

const deleteCategory = asyncHandler(async (req, res) => {
  await withTransaction(async (session) => {
    const category = await Category.findById(req.params.id).session(session);
    if (!category) { const error = new Error("الفئة غير موجودة"); error.statusCode = 404; throw error; }
    if (await Product.exists({ category: category._id }).session(session)) {
      const error = new Error("لا يمكن حذف فئة تحتوي على منتجات");
      error.statusCode = 409; error.responseData = { code: "CATEGORY_NOT_EMPTY" }; throw error;
    }
    await category.deleteOne({ session });
    await audit(req, { action: "category.deleted", entity: "Category", entityId: category._id, session, strict: true });
  });
  res.json({ message: "Category deleted successfully" });
});

module.exports = {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
};
