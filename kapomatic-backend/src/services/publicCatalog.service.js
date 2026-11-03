const Category = require("../models/category.model");
const EcommerceSetting = require("../models/ecommerceSetting.model");
const GeneralSetting = require("../models/generalSetting.model");
const { calculatePriceAfterDiscount } = require("../utils/productPricing");
const { getEntityImageAssetUrl } = require("../utils/seo");

const HOME_PRODUCT_LIMITS = Object.freeze({ desktop: 10, mobile: 6 });

const localizedProjection = (locale) => ({
  localized: `$translations.${locale}`,
  slugAr: "$translations.ar.slug",
  slugEn: "$translations.en.slug",
});

const categoryProjection = (locale) => ({
  _id: 1,
  name: 1,
  slugAliases: 1,
  hasImage: { $ne: [{ $ifNull: ["$image", ""] }, ""] },
  ...localizedProjection(locale),
});

const productProjection = (locale) => ({
  _id: 1,
  category: 1,
  name: 1,
  code: 1,
  retailPrice: 1,
  discountPercentage: 1,
  inventoryCount: 1,
  slugAliases: 1,
  createdAt: 1,
  hasImage: { $ne: [{ $ifNull: ["$image", ""] }, ""] },
  ...localizedProjection(locale),
});

const buildCategoryProjectionPipeline = (categoryIds, locale) => [
  { $match: { _id: { $in: categoryIds } } },
  { $project: categoryProjection(locale) },
];

const buildSelectedProductsPipeline = (categoryIds, limit, locale) => [
  {
    $match: {
      showOnWebsite: true,
      category: { $in: categoryIds },
    },
  },
  {
    $project: {
      category: 1,
      selectedProducts: {
        $slice: [{ $ifNull: ["$selectedProducts", []] }, limit],
      },
    },
  },
  {
    $unwind: {
      path: "$selectedProducts",
      includeArrayIndex: "productOrder",
    },
  },
  {
    $lookup: {
      from: "products",
      let: { productId: "$selectedProducts", categoryId: "$category" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ["$_id", "$$productId"] },
                { $eq: ["$category", "$$categoryId"] },
              ],
            },
          },
        },
        { $project: productProjection(locale) },
      ],
      as: "product",
    },
  },
  { $unwind: "$product" },
  { $sort: { category: 1, productOrder: 1 } },
  { $project: { _id: 0, category: 1, productOrder: 1, product: 1 } },
];

const hasLocalizedPublicValue = (entity, locale) =>
  Boolean(
    (entity.localized?.name && entity.localized?.slug) ||
      (locale === "ar" && entity.name)
  );

const localizedName = (entity, locale) =>
  entity.localized?.name || (locale === "ar" ? entity.name : undefined);

const localizedSlug = (entity, locale) =>
  entity.localized?.slug || (locale === "ar" ? String(entity._id) : undefined);

const localizedSlugs = (entity) => ({
  ar: entity.slugAr || String(entity._id),
  en: entity.slugEn || null,
});

const serializeCategory = (req, category, locale) => {
  const name = localizedName(category, locale);
  return {
    _id: String(category._id),
    id: String(category._id),
    name,
    description: category.localized?.description || "",
    shortDescription: category.localized?.shortDescription || "",
    slug: localizedSlug(category, locale),
    localizedSlugs: localizedSlugs(category),
    slugAliases: category.slugAliases || [],
    imageUrl: category.hasImage
      ? getEntityImageAssetUrl(req, "category", category._id)
      : null,
    imageAlt: category.localized?.imageAlt || name || "",
  };
};

const serializeProduct = (req, product, locale, category) => {
  const name = localizedName(product, locale);
  const discountPercentage = Number(product.discountPercentage || 0);
  const retailPrice = Number(product.retailPrice || 0);
  const priceAfterDiscount = calculatePriceAfterDiscount(
    retailPrice,
    discountPercentage
  );

  return {
    _id: String(product._id),
    id: String(product._id),
    categoryId: String(product.category),
    category: category
      ? {
          _id: category.id,
          id: category.id,
          name: category.name,
          slug: category.slug,
        }
      : { _id: String(product.category), id: String(product.category) },
    name,
    description: product.localized?.description || "",
    shortDescription: product.localized?.shortDescription || "",
    slug: localizedSlug(product, locale),
    translations: {
      ar: { slug: product.slugAr || null },
      en: { slug: product.slugEn || null },
    },
    slugAliases: product.slugAliases || [],
    code: product.code || "",
    imageUrl: product.hasImage
      ? getEntityImageAssetUrl(req, "product", product._id)
      : null,
    imageAlt: product.localized?.imageAlt || name || "",
    retailPrice,
    discountPercentage,
    priceAfterDiscount,
    inventoryCount: Number(product.inventoryCount || 0),
  };
};

const orderByConfiguredIds = (entities, ids) => {
  const byId = new Map(entities.map((entity) => [String(entity._id), entity]));
  return ids.flatMap((id) => {
    const entity = byId.get(String(id));
    return entity ? [entity] : [];
  });
};

const groupProductsByCategory = (rows) =>
  rows.reduce((grouped, row) => {
    const key = String(row.category);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.product);
    return grouped;
  }, new Map());

const loadConfiguredHomeCatalog = async ({ locale, device, database }) => {
  const [generalSetting, activeSettings] = await Promise.all([
    database(() =>
      GeneralSetting.findOne({ key: "default" })
        .select("homePageCategoryIds")
        .lean()
    ),
    database(() =>
      EcommerceSetting.find({ showOnWebsite: true })
        .select("category selectedProducts")
        .sort({ createdAt: 1, _id: 1 })
        .lean()
    ),
  ]);
  const configuredIds = generalSetting?.homePageCategoryIds || [];
  if (configuredIds.length === 0 || activeSettings.length === 0) {
    return { categories: [], productsByCategory: new Map(), productIssue: false };
  }

  const activeIds = new Set(activeSettings.map((setting) => String(setting.category)));
  const categoryIds = configuredIds.filter((id) => activeIds.has(String(id)));
  if (categoryIds.length === 0) {
    return { categories: [], productsByCategory: new Map(), productIssue: false };
  }

  const limit = HOME_PRODUCT_LIMITS[device];
  const [categories, productResult] = await Promise.all([
    database(() => Category.aggregate(buildCategoryProjectionPipeline(categoryIds, locale))),
    database(() =>
      EcommerceSetting.aggregate(buildSelectedProductsPipeline(categoryIds, limit, locale))
    ).then(
      (rows) => ({ rows, failed: false }),
      () => ({ rows: [], failed: true })
    ),
  ]);
  const localizedCategories = orderByConfiguredIds(categories, categoryIds).filter((category) =>
    hasLocalizedPublicValue(category, locale)
  );
  const allowedCategoryIds = new Set(localizedCategories.map((category) => String(category._id)));
  const localizedProductRows = productResult.rows.filter(
    (row) =>
      allowedCategoryIds.has(String(row.category)) &&
      hasLocalizedPublicValue(row.product, locale)
  );

  return {
    categories: localizedCategories,
    productsByCategory: groupProductsByCategory(localizedProductRows),
    productIssue: productResult.failed,
  };
};

const loadBoundedActiveCategories = async ({ req, locale, limit, database }) => {
  const activeSettings = await database(() =>
    EcommerceSetting.find({ showOnWebsite: true })
      .select("category selectedProducts showOnWebsite")
      .sort({ createdAt: 1, _id: 1 })
      .lean()
  );
  const categoryIds = activeSettings.map((setting) => setting.category);
  if (categoryIds.length === 0) return [];

  const [categories, productRows] = await Promise.all([
    database(() => Category.aggregate(buildCategoryProjectionPipeline(categoryIds, locale))),
    database(() =>
      EcommerceSetting.aggregate(buildSelectedProductsPipeline(categoryIds, limit, locale))
    ),
  ]);
  const categoryById = new Map(categories.map((category) => [String(category._id), category]));
  const productsByCategory = groupProductsByCategory(productRows);

  return activeSettings.flatMap((setting) => {
    const rawCategory = categoryById.get(String(setting.category));
    if (!rawCategory) return [];
    const category = serializeCategory(req, rawCategory, locale);
    const rawProducts = productsByCategory.get(String(setting.category)) || [];
    const products = rawProducts
      .filter((product) => hasLocalizedPublicValue(product, locale))
      .map((product) => serializeProduct(req, product, locale, category));

    return [
      {
        category: {
          ...category,
          image: category.imageUrl,
          specifications: [],
          filters: [],
        },
        products,
        setting: {
          ...setting,
          selectedProducts: products.map((product) => product._id),
        },
      },
    ];
  });
};

module.exports = {
  HOME_PRODUCT_LIMITS,
  buildCategoryProjectionPipeline,
  buildSelectedProductsPipeline,
  hasLocalizedPublicValue,
  loadBoundedActiveCategories,
  loadConfiguredHomeCatalog,
  serializeCategory,
  serializeProduct,
};
