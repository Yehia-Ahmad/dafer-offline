const mongoose = require("mongoose");
const Category = require("../models/category.model");
const Product = require("../models/product.model");
const isBase64Image = require("../utils/isBase64Image");
const {
  createCategoryWorkbook,
  readCategoryAndProductWorkbook,
} = require("../helpers/categoryWorkbook.helper");

const MAX_CATEGORY_NAME_LENGTH = 120;
const MAX_PRODUCT_NAME_LENGTH = 200;
const MAX_PRODUCT_CODE_LENGTH = 100;

const normalizeStringCell = (value) => String(value ?? "").trim();

// Reassemble values that the exporter split to respect Excel's 32,767-character
// cell limit. Regular user-created files with only the base column still work.
const readChunkedCell = (values, baseHeader) =>
  Object.entries(values)
    .map(([header, value]) => {
      if (header === baseHeader) return { index: 1, value };

      const match = header.match(new RegExp(`^${baseHeader}_(\\d+)$`));
      if (!match || Number(match[1]) < 2) return null;
      return { index: Number(match[1]), value };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)
    .map(({ value }) => String(value ?? ""))
    .join("");

const parseSpecifications = (value) => {
  const serializedValue = normalizeStringCell(value);
  if (!serializedValue) return [];

  let specifications;
  try {
    specifications = JSON.parse(serializedValue);
  } catch (_error) {
    throw new Error("Specifications must be valid JSON");
  }

  if (!Array.isArray(specifications)) {
    throw new Error("Specifications must be a JSON array");
  }

  return specifications.map((specification, index) => {
    if (
      !specification ||
      typeof specification !== "object" ||
      Array.isArray(specification)
    ) {
      throw new Error(`Specification ${index + 1} must be an object`);
    }

    // The current Mongoose schema stores mixed specification objects, and
    // existing records use more than one shape. Preserve valid objects exactly
    // so an exported workbook can always be imported without data loss.
    return { ...specification };
  });
};

const validateImportRow = ({ rowNumber, values }) => {
  const name = normalizeStringCell(values.Name);
  if (!name) throw new Error("Name is required");
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    throw new Error(`Name cannot exceed ${MAX_CATEGORY_NAME_LENGTH} characters`);
  }

  const image = normalizeStringCell(readChunkedCell(values, "ImageBase64"));
  if (image && !isBase64Image(image)) {
    throw new Error("ImageBase64 must contain a valid base64 image");
  }

  return {
    rowNumber,
    category: {
      name,
      ...(image ? { image } : {}),
      specifications: parseSpecifications(
        readChunkedCell(values, "Specifications")
      ),
    },
  };
};

const parseRequiredNonNegativeNumber = (value, fieldName) => {
  const serializedValue = normalizeStringCell(value);
  const parsedValue = Number(serializedValue);

  if (!serializedValue || !Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }

  return parsedValue;
};

const parseOptionalNonNegativeNumber = (value, fieldName, defaultValue = 0) => {
  const serializedValue = normalizeStringCell(value);
  if (!serializedValue) return defaultValue;

  const parsedValue = Number(serializedValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }

  return parsedValue;
};

const parseOptionalDate = (value, fieldName) => {
  const serializedValue = normalizeStringCell(value);
  if (!serializedValue) return undefined;

  const parsedDate = new Date(serializedValue);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }

  return parsedDate;
};

const validateProductImportRow = ({ rowNumber, values }) => {
  const name = normalizeStringCell(values.Name);
  const code = normalizeStringCell(values.Code);
  const categoryName = normalizeStringCell(values.CategoryName);
  const productId = normalizeStringCell(values.ProductId);

  if (!name) throw new Error("Name is required");
  if (name.length > MAX_PRODUCT_NAME_LENGTH) {
    throw new Error(`Name cannot exceed ${MAX_PRODUCT_NAME_LENGTH} characters`);
  }
  if (!code) throw new Error("Code is required");
  if (code.length > MAX_PRODUCT_CODE_LENGTH) {
    throw new Error(`Code cannot exceed ${MAX_PRODUCT_CODE_LENGTH} characters`);
  }
  if (!categoryName) throw new Error("CategoryName is required");
  if (productId && !mongoose.Types.ObjectId.isValid(productId)) {
    throw new Error("ProductId must be a valid MongoDB ObjectId");
  }

  const inventoryCount = parseRequiredNonNegativeNumber(
    values.InventoryCount,
    "InventoryCount"
  );
  const wholesalePrice = parseRequiredNonNegativeNumber(
    values.WholesalePrice,
    "WholesalePrice"
  );
  const purchasePrice = parseOptionalNonNegativeNumber(
    values.PurchasePrice,
    "PurchasePrice"
  );
  const retailPrice = parseRequiredNonNegativeNumber(
    values.RetailPrice,
    "RetailPrice"
  );
  const soldItemCount = parseRequiredNonNegativeNumber(
    values.SoldItemCount,
    "SoldItemCount"
  );

  if (retailPrice < wholesalePrice) {
    throw new Error("RetailPrice cannot be less than WholesalePrice");
  }
  if (purchasePrice > wholesalePrice || purchasePrice > retailPrice) {
    throw new Error("PurchasePrice cannot exceed WholesalePrice or RetailPrice");
  }

  const image = normalizeStringCell(readChunkedCell(values, "ImageBase64"));
  if (image && !isBase64Image(image)) {
    throw new Error("ImageBase64 must contain a valid base64 image");
  }

  return {
    rowNumber,
    productId,
    categoryName,
    product: {
      ...(productId ? { _id: productId } : {}),
      name,
      code,
      inventoryCount,
      ...(image ? { image } : {}),
      wholesalePrice,
      purchasePrice,
      retailPrice,
      soldItemCount,
      specifications: parseSpecifications(
        readChunkedCell(values, "Specifications")
      ),
      createdAt: parseOptionalDate(values.CreatedAt, "CreatedAt"),
      updatedAt: parseOptionalDate(values.UpdatedAt, "UpdatedAt"),
    },
  };
};

const exportCategories = async () => {
  // Fetch categories and products in parallel, then group in memory to avoid
  // issuing one product query per category.
  const [categories, products] = await Promise.all([
    Category.find()
      .select("name image specifications")
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    Product.find()
      .select("-__v")
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ]);

  const categoryNamesById = new Map(
    categories.map((category) => [category._id.toString(), category.name])
  );
  const exportedProducts = products.map((product) => {
    const categoryId = product.category?.toString() || "";

    return {
      productId: product._id.toString(),
      categoryId,
      categoryName: categoryNamesById.get(categoryId) || "Uncategorized",
      name: product.name,
      code: product.code,
      inventoryCount: product.inventoryCount,
      imageBase64: product.image || "",
      wholesalePrice: product.wholesalePrice,
      purchasePrice: product.purchasePrice,
      retailPrice: product.retailPrice,
      soldItemCount: product.soldItemCount,
      specifications: product.specifications || [],
      createdAt: product.createdAt?.toISOString?.() || product.createdAt || "",
      updatedAt: product.updatedAt?.toISOString?.() || product.updatedAt || "",
    };
  });

  return createCategoryWorkbook(categories, exportedProducts);
};

const importCategories = async (buffer) => {
  const { categoryRows: workbookRows, productRows } =
    readCategoryAndProductWorkbook(buffer);
  const errors = [];
  const validatedRows = [];

  for (const row of workbookRows) {
    try {
      validatedRows.push(validateImportRow(row));
    } catch (error) {
      errors.push({ row: row.rowNumber, message: error.message });
    }
  }

  // Check existing names in one query instead of issuing one database query per row.
  const candidateNames = [
    ...new Set(validatedRows.map(({ category }) => category.name)),
  ];
  const existingCategories = candidateNames.length
    ? await Category.find({ name: { $in: candidateNames } }).select("name").lean()
    : [];
  const usedNames = new Set(existingCategories.map((category) => category.name));
  const rowsToInsert = [];

  for (const row of validatedRows) {
    if (usedNames.has(row.category.name)) {
      errors.push({
        row: row.rowNumber,
        message: `Duplicate category name: ${row.category.name}`,
      });
      continue;
    }

    // Adding immediately also detects duplicate names within the same workbook.
    usedNames.add(row.category.name);
    rowsToInsert.push(row);
  }

  let importedCount = 0;

  if (rowsToInsert.length > 0) {
    try {
      const insertedCategories = await Category.insertMany(
        rowsToInsert.map(({ category }) => category),
        { ordered: false }
      );
      importedCount = insertedCategories.length;
    } catch (error) {
      // A concurrent request can create a category after the duplicate lookup.
      // Unordered insertion retains successful rows and maps failed writes back
      // to their source rows.
      if (!Array.isArray(error.writeErrors)) throw error;

      const failedIndexes = new Set();
      for (const writeError of error.writeErrors) {
        const failedIndex = writeError.index ?? writeError.err?.index;
        if (!Number.isInteger(failedIndex) || !rowsToInsert[failedIndex]) {
          throw error;
        }

        failedIndexes.add(failedIndex);
        errors.push({
          row: rowsToInsert[failedIndex].rowNumber,
          message:
            writeError.code === 11000
              ? `Duplicate category name: ${rowsToInsert[failedIndex].category.name}`
              : writeError.errmsg || writeError.message || "Database insert failed",
        });
      }

      importedCount = rowsToInsert.length - failedIndexes.size;
    }
  }

  const productErrors = [];
  const validatedProductRows = [];

  for (const row of productRows) {
    try {
      validatedProductRows.push(validateProductImportRow(row));
    } catch (error) {
      productErrors.push({ row: row.rowNumber, message: error.message });
    }
  }

  const productCategoryNames = [
    ...new Set(validatedProductRows.map((row) => row.categoryName)),
  ];
  const productCategories = productCategoryNames.length
    ? await Category.find({ name: { $in: productCategoryNames } })
        .select("name")
        .lean()
    : [];
  const categoriesByName = new Map(
    productCategories.map((category) => [category.name, category._id])
  );

  const candidateProductIds = validatedProductRows
    .map((row) => row.productId)
    .filter(Boolean);
  const existingProducts = candidateProductIds.length
    ? await Product.find({ _id: { $in: candidateProductIds } }).select("_id").lean()
    : [];
  const usedProductIds = new Set(
    existingProducts.map((product) => product._id.toString())
  );
  const productRowsToInsert = [];

  for (const row of validatedProductRows) {
    const categoryId = categoriesByName.get(row.categoryName);
    if (!categoryId) {
      productErrors.push({
        row: row.rowNumber,
        message: `Category not found: ${row.categoryName}`,
      });
      continue;
    }

    if (row.productId && usedProductIds.has(row.productId)) {
      productErrors.push({
        row: row.rowNumber,
        message: `Duplicate product ID: ${row.productId}`,
      });
      continue;
    }

    if (row.productId) usedProductIds.add(row.productId);
    row.product.category = categoryId;
    productRowsToInsert.push(row);
  }

  let productImportedCount = 0;
  if (productRowsToInsert.length > 0) {
    try {
      const insertedProducts = await Product.insertMany(
        productRowsToInsert.map((row) => row.product),
        { ordered: false }
      );
      productImportedCount = insertedProducts.length;
    } catch (error) {
      if (!Array.isArray(error.writeErrors)) throw error;

      const failedIndexes = new Set();
      for (const writeError of error.writeErrors) {
        const failedIndex = writeError.index ?? writeError.err?.index;
        if (!Number.isInteger(failedIndex) || !productRowsToInsert[failedIndex]) {
          throw error;
        }

        failedIndexes.add(failedIndex);
        productErrors.push({
          row: productRowsToInsert[failedIndex].rowNumber,
          message:
            writeError.code === 11000
              ? `Duplicate product ID: ${productRowsToInsert[failedIndex].product._id}`
              : writeError.errmsg || writeError.message || "Database insert failed",
        });
      }

      productImportedCount = productRowsToInsert.length - failedIndexes.size;
    }
  }

  return {
    success: true,
    importedCount,
    skippedCount: workbookRows.length - importedCount,
    errors: errors.sort((left, right) => left.row - right.row),
    productImportedCount,
    productSkippedCount: productRows.length - productImportedCount,
    productErrors: productErrors.sort((left, right) => left.row - right.row),
  };
};

module.exports = {
  exportCategories,
  importCategories,
};
