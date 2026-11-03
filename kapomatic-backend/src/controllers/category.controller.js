const Category = require("../models/category.model");
const EcommerceSetting = require("../models/ecommerceSetting.model");
const Product = require("../models/product.model");
const asyncHandler = require("../utils/asyncHandler");
const {
  addSlugAliasesForChangedSlugs,
  checkDuplicateSlug,
  clearPublicSeoCache,
  normalizeSeoInput,
} = require("../utils/seo");

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
  res.json(categories);
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

  Object.assign(
    categoryData,
    normalizeSeoInput({
      body: req.body,
      legacyName: name,
      entityType: "category",
      res,
    })
  );
  await checkDuplicateSlug({
    Model: Category,
    entityType: "category",
    translations: categoryData.translations,
    res,
  });

  const category = await Category.create(categoryData);
  clearPublicSeoCache();

  res.status(201).json(category);
});

const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  const nextName = req.body.name !== undefined ? req.body.name : category.name;
  const seoUpdate = normalizeSeoInput({
    body: req.body,
    legacyName: category.translations?.ar?.name ? undefined : nextName,
    entityType: "category",
    existing: category,
    res,
  });
  await checkDuplicateSlug({
    Model: Category,
    entityType: "category",
    translations: seoUpdate.translations,
    excludeId: category._id,
    res,
  });
  if (seoUpdate.translations) {
    addSlugAliasesForChangedSlugs(category, seoUpdate.translations);
    category.translations = seoUpdate.translations;
  }
  if (seoUpdate.seo) category.seo = seoUpdate.seo;

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
  clearPublicSeoCache();
  res.json(updatedCategory);
});

const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  await EcommerceSetting.deleteOne({ category: category._id });
  await Product.deleteMany({ category: category._id });

  await category.deleteOne();
  clearPublicSeoCache();
  res.json({ message: "Category deleted successfully" });
});

module.exports = {
  getCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
};
