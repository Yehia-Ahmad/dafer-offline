// Online Stage 3: what the customer website may see. Every read here selects named fields only (no base64, no cost, no stock number
// beyond what the whitelist turns into availability / maxOrderQty / remaining).
// Online Stage 5A: WHICH products show depends on the website's `productVisibility` mode and the products' / categories' `website.visibility`:
//   "marked" (default): only "show".   "all": everything except "hide".   Archived products and products of a hidden category never show.
// With stock.showOutOfStock = false, products with no available stock (inventory minus reserved by orders) are hidden too.
const mongoose = require("mongoose");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const ShopProfile = require("../models/shopProfile.model");
const WebsiteSettings = require("../models/websiteSettings.model");
const WebOrder = require("../models/webOrder.model");
const { loadVatSettings, vatContext, today } = require("../accounting/vat");
const { withAvailableStock } = require("./reservations");

const isId = (value) => typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value.toLowerCase();

const loadWebsiteSettings = (session) => WebsiteSettings.findOne({ key: "default" }).session(session || null).lean();

const DEFAULT_REMAINING_THRESHOLD = 5;
const DEFAULT_ATTRIBUTION_DAYS = 7;
const DEFAULT_HEARD_FROM = ["فيسبوك", "إنستجرام", "تيك توك", "صديق أو قريب", "جوجل", "زرت المحل", "أخرى"];

/**
 * The settings with their documented defaults applied (a settings document saved before Stage 5A has none of the new fields).
 * Pure: `settings` may be null. Payment methods are `enabled` only when they are complete (address / number and a box).
 */
const effectiveSettings = (settings) => {
  const s = settings || {};
  const payments = s.payments || {};
  const instapay = payments.instapay || {};
  const vodafone = payments.vodafoneCash || {};
  const stock = s.stock || {};
  const remaining = stock.showRemaining || {};
  const marketing = s.marketing || {};
  const options = Array.isArray(marketing.heardFromOptions) ? marketing.heardFromOptions.filter(Boolean) : DEFAULT_HEARD_FROM;
  return {
    // Online Stage 7A.
    marketing: {
      metaPixelId: marketing.metaPixelId || "",
      tiktokPixelId: marketing.tiktokPixelId || "",
      requireConsent: marketing.requireConsent !== false,
      attributionDays: Number.isInteger(marketing.attributionDays) && marketing.attributionDays >= 1 ? marketing.attributionDays : DEFAULT_ATTRIBUTION_DAYS,
      askHeardFrom: marketing.askHeardFrom !== false,
      heardFromOptions: options,
    },
    fulfillment: { delivery: !(s.fulfillment && s.fulfillment.delivery === false), pickup: Boolean(s.fulfillment && s.fulfillment.pickup === true) },
    payments: {
      cod: { enabled: !(payments.cod && payments.cod.enabled === false) },
      instapay: { enabled: instapay.enabled === true && Boolean(instapay.address) && Boolean(instapay.boxId), address: instapay.address || "", boxId: instapay.boxId || null },
      vodafone_cash: { enabled: vodafone.enabled === true && Boolean(vodafone.number) && Boolean(vodafone.boxId), number: vodafone.number || "", boxId: vodafone.boxId || null },
    },
    stock: {
      showOutOfStock: stock.showOutOfStock !== false,
      showRemaining: { enabled: remaining.enabled !== false, threshold: Number.isFinite(Number(remaining.threshold)) && remaining.threshold >= 1 ? Number(remaining.threshold) : DEFAULT_REMAINING_THRESHOLD },
    },
    productVisibility: s.productVisibility === "all" ? "all" : "marked",
  };
};

/** { rate, included } when the shop's VAT applies today (same rule as a cash sale), else null. */
const currentVat = async (session) => vatContext(await loadVatSettings(session), today());

/** The $match fragment on a `website.visibility` path for the mode. */
const visibilityMatch = (mode) => (mode === "all" ? { "website.visibility": { $ne: "hide" } } : { "website.visibility": "show" });

const visibleCategoryIds = async (session, mode = "marked") => {
  const rows = await Category.find(visibilityMatch(mode)).select("_id").session(session || null).lean();
  return rows.map((row) => row._id);
};

/**
 * Ids of products with nothing left to sell on the website (inventory minus reserved <= 0): the products reserved by orders whose
 * reservation covers the whole stock. Products with inventoryCount <= 0 are matched directly by the caller.
 */
const fullyReservedProductIds = async (session) => {
  const rows = await WebOrder.aggregate([
    { $match: { status: { $in: WebOrder.RESERVING_STATUSES } } },
    { $unwind: "$items" },
    { $group: { _id: "$items.productId", qty: { $sum: "$items.qty" } } },
  ]).session(session || null);
  if (!rows.length) return [];
  const products = await Product.find({ _id: { $in: rows.map((row) => row._id) } }).select("inventoryCount").session(session || null).lean();
  const stock = new Map(products.map((product) => [String(product._id), Number(product.inventoryCount || 0)]));
  return rows.filter((row) => (stock.get(String(row._id)) || 0) - row.qty <= 0).map((row) => row._id);
};

/** The $match of every public product read, for the already-loaded category ids and the effective settings. */
const visibleProductFilter = (categoryIds, rules = effectiveSettings(null), { hiddenIds = [] } = {}) => ({
  ...visibilityMatch(rules.productVisibility),
  isArchived: { $ne: true },
  category: { $in: categoryIds },
  ...(rules.stock.showOutOfStock ? {} : { inventoryCount: { $gt: 0 }, _id: { $nin: hiddenIds } }),
});

/** Everything a public read needs: the settings, their effective rules, the visible categories and the product filter. */
const storeScope = async ({ session } = {}) => {
  const settings = await loadWebsiteSettings(session);
  const rules = effectiveSettings(settings);
  const categoryIds = await visibleCategoryIds(session, rules.productVisibility);
  const hiddenIds = rules.stock.showOutOfStock ? [] : await fullyReservedProductIds(session);
  return { settings, rules, categoryIds, filter: visibleProductFilter(categoryIds, rules, { hiddenIds }) };
};

const FINAL_PRICE = {
  $round: [
    { $multiply: ["$retailPrice", { $subtract: [1, { $divide: [{ $min: [100, { $max: [0, { $ifNull: ["$discountPercentage", 0] }] }] }, 100] }] }] },
    2,
  ],
};

// Only these fields leave the database for a product read. imageCount: the main image (index 0) plus website.images.
// Stage 5A: code (never for archived: the filter excludes them), specifications (the whitelist keeps label/value strings only),
// createdAt (only to compute the "new" badge).
const PRODUCT_PROJECTION = {
  name: 1,
  code: 1,
  category: 1,
  retailPrice: 1,
  discountPercentage: 1,
  finalPrice: 1,
  inventoryCount: 1,
  lowStockThreshold: 1,
  vatExempt: 1,
  specifications: 1,
  createdAt: 1,
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

// bestselling sorts by soldItemCount, which is never projected (the number never leaves the server).
const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  "price-asc": { finalPrice: 1, _id: 1 },
  "price-desc": { finalPrice: -1, _id: 1 },
  name: { name: 1, _id: 1 },
  bestselling: { soldItemCount: -1, _id: 1 },
};

/** Visible products as lean rows (with finalPrice), plus the total for pagination. */
const findVisibleProducts = async ({ categoryId, q, sort, skip, limit, scope }) => {
  const { categoryIds, rules, filter } = scope || (await storeScope());
  if (!categoryIds.length) return { rows: [], total: 0, rules };
  const match = { ...filter };
  if (categoryId) {
    if (!categoryIds.some((id) => String(id) === categoryId)) return { rows: [], total: 0, rules };
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
  return { rows: await withAvailableStock(rows), total, rules };
};

/** One visible product by id (lean row with finalPrice) or null. */
const findVisibleProduct = async (id, scope) => {
  if (!isId(id)) return null;
  const { categoryIds, filter, rules } = scope || (await storeScope());
  if (!categoryIds.length) return null;
  const [row] = await Product.aggregate([
    { $match: { ...filter, _id: new mongoose.Types.ObjectId(id) } },
    { $addFields: { finalPrice: FINAL_PRICE } },
    { $project: PRODUCT_PROJECTION },
  ]);
  if (!row) return null;
  const [withStock] = await withAvailableStock([row]);
  // The id match above replaced the "fully reserved" exclusion of the filter, so the same rule is applied here.
  if (!rules.stock.showOutOfStock && withStock.inventoryCount <= 0) return null;
  return { row: withStock, rules };
};

const RELATED_LIMIT = 8;
/** Up to 8 other visible products of the same category, in stock first (stock = inventory minus reserved), then newest. */
const findRelatedProducts = async (id, scope) => {
  if (!isId(id)) return null;
  const { categoryIds, filter, rules } = scope || (await storeScope());
  if (!categoryIds.length) return null;
  const base = await Product.findOne({ _id: id, ...filter }).select("category").lean();
  if (!base) return null;
  const candidates = await Product.aggregate([
    { $match: { ...filter, category: base.category, _id: { $ne: base._id, ...(filter._id || {}) } } },
    { $addFields: { finalPrice: FINAL_PRICE, inStock: { $cond: [{ $gt: ["$inventoryCount", 0] }, 1, 0] } } },
    { $sort: { inStock: -1, createdAt: -1, _id: -1 } },
    { $limit: RELATED_LIMIT * 5 },
    { $project: PRODUCT_PROJECTION },
  ]);
  const rows = (await withAvailableStock(candidates)).map((row, index) => ({ row, index }));
  rows.sort((a, b) => (Number(b.row.inventoryCount > 0) - Number(a.row.inventoryCount > 0)) || (a.index - b.index));
  return { rows: rows.slice(0, RELATED_LIMIT).map((entry) => entry.row), rules };
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
  effectiveSettings,
  findRelatedProducts,
  findVisibleProduct,
  findVisibleProducts,
  isId,
  loadShopProfile,
  loadWebsiteSettings,
  storeScope,
  visibleCategoryIds,
  visibleProductFilter,
  visibilityMatch,
};
