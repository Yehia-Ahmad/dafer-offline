// Online Stage 3: what the customer website may see. A product shows only if website.visible, not archived, and its
// category exists and is website.visible. Every read here selects named fields only (no base64, no cost, no stock number
// beyond what the whitelist turns into availability / maxOrderQty).
const mongoose = require("mongoose");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const ShopProfile = require("../models/shopProfile.model");
const WebsiteSettings = require("../models/websiteSettings.model");
const { loadVatSettings, vatContext, today } = require("../accounting/vat");
const { withAvailableStock } = require("./reservations");

const isId = (value) => typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value.toLowerCase();

const loadWebsiteSettings = (session) => WebsiteSettings.findOne({ key: "default" }).session(session || null).lean();

/** { rate, included } when the shop's VAT applies today (same rule as a cash sale), else null. */
const currentVat = async (session) => vatContext(await loadVatSettings(session), today());

const visibleCategoryIds = async (session) => {
  const rows = await Category.find({ "website.visible": true }).select("_id").session(session || null).lean();
  return rows.map((row) => row._id);
};

/** The $match of every public product read. */
const visibleProductFilter = (categoryIds) => ({
  "website.visible": true,
  isArchived: { $ne: true },
  category: { $in: categoryIds },
});

const FINAL_PRICE = {
  $round: [
    { $multiply: ["$retailPrice", { $subtract: [1, { $divide: [{ $min: [100, { $max: [0, { $ifNull: ["$discountPercentage", 0] }] }] }, 100] }] }] },
    2,
  ],
};

// Only these fields leave the database for a product read. imageCount: the main image (index 0) plus website.images.
const PRODUCT_PROJECTION = {
  name: 1,
  category: 1,
  retailPrice: 1,
  discountPercentage: 1,
  finalPrice: 1,
  inventoryCount: 1,
  lowStockThreshold: 1,
  vatExempt: 1,
  updatedAt: 1,
  description: "$website.description",
  imageCount: {
    $add: [
      { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$image", ""] } }, 0] }, 1, 0] },
      { $size: { $ifNull: ["$website.images", []] } },
    ],
  },
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  "price-asc": { finalPrice: 1, _id: 1 },
  "price-desc": { finalPrice: -1, _id: 1 },
  name: { name: 1, _id: 1 },
};

/** Visible products as lean rows (with finalPrice), plus the total for pagination. */
const findVisibleProducts = async ({ categoryId, q, sort, skip, limit }) => {
  const categoryIds = await visibleCategoryIds();
  if (!categoryIds.length) return { rows: [], total: 0 };
  const match = visibleProductFilter(categoryIds);
  if (categoryId) {
    if (!categoryIds.some((id) => String(id) === categoryId)) return { rows: [], total: 0 };
    match.category = new mongoose.Types.ObjectId(categoryId);
  }
  if (q) match.name = { $regex: escapeRegex(q), $options: "i" };
  const [rows, total] = await Promise.all([
    Product.aggregate([
      { $match: match },
      { $addFields: { finalPrice: FINAL_PRICE } },
      { $sort: SORTS[sort] || SORTS.newest },
      { $skip: skip },
      { $limit: limit },
      { $project: PRODUCT_PROJECTION },
    ]).collation({ locale: "ar", strength: 2 }),
    Product.countDocuments(match),
  ]);
  // Online Stage 4: the website sells inventoryCount - reserved (confirmed/preparing orders).
  return { rows: await withAvailableStock(rows), total };
};

/** One visible product by id (lean row with finalPrice) or null. */
const findVisibleProduct = async (id) => {
  if (!isId(id)) return null;
  const categoryIds = await visibleCategoryIds();
  if (!categoryIds.length) return null;
  const [row] = await Product.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(id), ...visibleProductFilter(categoryIds) } },
    { $addFields: { finalPrice: FINAL_PRICE } },
    { $project: PRODUCT_PROJECTION },
  ]);
  return row ? (await withAvailableStock([row]))[0] : null;
};

const categoryNames = async (rows) => {
  const ids = [...new Set(rows.map((row) => String(row.category)))];
  const categories = await Category.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(categories.map((category) => [String(category._id), category.name]));
};

const loadShopProfile = () => ShopProfile.findOne({ key: "default" }).select("name address phones logo updatedAt").lean();

module.exports = {
  FINAL_PRICE,
  categoryNames,
  currentVat,
  findVisibleProduct,
  findVisibleProducts,
  isId,
  loadShopProfile,
  loadWebsiteSettings,
  visibleCategoryIds,
  visibleProductFilter,
};
