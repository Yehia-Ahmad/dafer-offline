// Online Stage 3: the public catalog (/api/store). Every JSON answer goes through src/store/whitelist.js.
const crypto = require("node:crypto");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const DeliveryZone = require("../models/deliveryZone.model");
const ShopProfile = require("../models/shopProfile.model");
const asyncHandler = require("../utils/asyncHandler");
const { parsePaginationInteger, buildPaginationMetadata } = require("../utils/pagination");
const { httpError } = require("../auth/middleware");
const catalog = require("../store/catalog");
const wl = require("../store/whitelist");

const MAX_PUBLIC_LIMIT = 48;
const DEFAULT_PUBLIC_LIMIT = 12;
const notFound = () => httpError(404, "NOT_FOUND", "غير موجود");

const getSettings = asyncHandler(async (_req, res) => {
  const [settings, shop, vat] = await Promise.all([catalog.loadWebsiteSettings(), catalog.loadShopProfile(), catalog.currentVat()]);
  if (!settings || !settings.enabled) return res.json(wl.publicSettings(settings, { shop }));

  const categoryIds = await catalog.visibleCategoryIds();
  const visible = new Set(categoryIds.map(String));
  const featuredCategories = (settings.featuredCategoryIds || []).filter((id) => visible.has(String(id)));
  const bannerLinks = new Set(categoryIds.map((id) => `category:${id}`));
  const productLinkIds = (settings.banners || []).filter((banner) => banner.linkType === "product" && banner.linkId).map((banner) => banner.linkId);
  if (productLinkIds.length) {
    const rows = await Product.find({ _id: { $in: productLinkIds }, ...catalog.visibleProductFilter(categoryIds) }).select("_id").lean();
    rows.forEach((row) => bannerLinks.add(`product:${row._id}`));
  }
  return res.json(wl.publicSettings(settings, { shop, featuredCategories, bannerLinks, vat }));
});

const getCategories = asyncHandler(async (_req, res) => {
  const categories = await Category.aggregate([
    { $match: { "website.visible": true } },
    { $project: { name: 1, updatedAt: 1, sortOrder: { $ifNull: ["$website.sortOrder", 0] }, hasImage: { $gt: [{ $strLenCP: { $ifNull: ["$image", ""] } }, 0] } } },
    { $sort: { sortOrder: 1, name: 1 } },
  ]).collation({ locale: "ar", strength: 2 });
  const counts = await Product.aggregate([
    { $match: catalog.visibleProductFilter(categories.map((category) => category._id)) },
    { $group: { _id: "$category", count: { $sum: 1 } } },
  ]);
  const countOf = new Map(counts.map((row) => [String(row._id), row.count]));
  res.json({ data: categories.map((category) => wl.publicCategory(category, countOf.get(String(category._id)) || 0)) });
});

const getProducts = asyncHandler(async (req, res) => {
  const query = req.query || {};
  const limit = parsePaginationInteger(query.limit, DEFAULT_PUBLIC_LIMIT, MAX_PUBLIC_LIMIT);
  const page = parsePaginationInteger(query.page, 1);
  const categoryId = typeof query.category === "string" && query.category ? query.category : undefined;
  if (categoryId && !catalog.isId(categoryId)) throw httpError(400, "INVALID_CATEGORY", "معرّف الفئة غير صالح");
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const sort = typeof query.sort === "string" ? query.sort : "newest";
  if (!["newest", "price-asc", "price-desc", "name"].includes(sort)) throw httpError(400, "INVALID_SORT", "ترتيب غير صالح");

  const [{ rows, total }, vat] = await Promise.all([
    catalog.findVisibleProducts({ categoryId, q, sort, skip: (page - 1) * limit, limit }),
    catalog.currentVat(),
  ]);
  const names = await catalog.categoryNames(rows);
  res.json({
    data: rows.map((row) => wl.publicProduct(row, names.get(String(row.category)) || "", vat)),
    pagination: buildPaginationMetadata({ page, limit, totalItems: total }),
  });
});

const getProduct = asyncHandler(async (req, res) => {
  const row = await catalog.findVisibleProduct(req.params.id);
  if (!row) throw notFound();
  const [names, vat] = await Promise.all([catalog.categoryNames([row]), catalog.currentVat()]);
  res.json(wl.publicProduct(row, names.get(String(row.category)) || "", vat));
});

const getDeliveryZones = asyncHandler(async (_req, res) => {
  const zones = await DeliveryZone.find({ isActive: true }).select("name fee estimatedTime").sort({ sortOrder: 1, name: 1 }).lean();
  res.json({ data: zones.map(wl.publicZone) });
});

// ---- images -------------------------------------------------------------------------------------------------------

const MIME_BY_MAGIC = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", null],
];
const SAFE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** { buffer, contentType } from a stored base64 image (raw or data URI), or null. Only raster types are ever served. */
const decodeImage = (stored) => {
  if (typeof stored !== "string" || !stored.trim()) return null;
  const trimmed = stored.trim();
  let declared = null;
  let base64 = trimmed;
  if (trimmed.startsWith("data:")) {
    const index = trimmed.indexOf(";base64,");
    if (index === -1) return null;
    declared = trimmed.slice(5, index).toLowerCase();
    base64 = trimmed.slice(index + 8);
  }
  const buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  if (!buffer.length) return null;
  let contentType = null;
  for (const [type, magic] of MIME_BY_MAGIC) {
    if (magic && magic.every((byte, i) => buffer[i] === byte)) contentType = type;
  }
  if (!contentType && buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") contentType = "image/webp";
  if (!contentType) contentType = declared && SAFE_MIME.has(declared) ? declared : null; // SVG and anything else is never served
  return contentType ? { buffer, contentType } : null;
};

const sendImage = (req, res, stored) => {
  const image = decodeImage(stored);
  if (!image) throw notFound();
  const etag = `"${crypto.createHash("sha1").update(image.buffer).digest("hex")}"`;
  res.set({
    "Content-Type": image.contentType,
    ETag: etag,
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.get("if-none-match") === etag) return res.status(304).end();
  return res.status(200).send(image.buffer);
};

const getProductImage = asyncHandler(async (req, res) => {
  const index = /^\d+$/.test(req.params.index) ? Number(req.params.index) : -1;
  if (!catalog.isId(req.params.id) || index < 0 || index > 4) throw notFound();
  const categoryIds = await catalog.visibleCategoryIds();
  const product = await Product.findOne({ _id: req.params.id, ...catalog.visibleProductFilter(categoryIds) }).select("image website.images").lean();
  if (!product) throw notFound();
  // Index 0 is the main image when the product has one; the extra website images follow in order.
  const images = [product.image, ...((product.website && product.website.images) || [])].filter((value) => typeof value === "string" && value.trim());
  return sendImage(req, res, images[index]);
});

const getCategoryImage = asyncHandler(async (req, res) => {
  if (!catalog.isId(req.params.id)) throw notFound();
  const category = await Category.findOne({ _id: req.params.id, "website.visible": true }).select("image").lean();
  if (!category) throw notFound();
  return sendImage(req, res, category.image);
});

const getBannerImage = asyncHandler(async (req, res) => {
  const settings = await catalog.loadWebsiteSettings();
  const banner = settings && (settings.banners || []).find((row) => String(row._id) === req.params.id);
  if (!banner) throw notFound();
  return sendImage(req, res, banner.image);
});

const getLogoImage = asyncHandler(async (_req, res) => {
  const profile = await ShopProfile.findOne({ key: "default" }).select("logo").lean();
  if (!profile) throw notFound();
  return sendImage(_req, res, profile.logo);
});

module.exports = {
  decodeImage,
  getBannerImage,
  getCategories,
  getCategoryImage,
  getDeliveryZones,
  getLogoImage,
  getProduct,
  getProductImage,
  getProducts,
  getSettings,
};
