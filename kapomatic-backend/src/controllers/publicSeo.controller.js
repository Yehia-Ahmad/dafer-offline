const mongoose = require("mongoose");
const Category = require("../models/category.model");
const EcommerceSetting = require("../models/ecommerceSetting.model");
const GeneralSetting = require("../models/generalSetting.model");
const Product = require("../models/product.model");
const ShippingSetting = require("../models/shippingSetting.model");
const asyncHandler = require("../utils/asyncHandler");
const { buildPaginationMetadata, getPaginationParams } = require("../utils/pagination");
const { calculatePriceAfterDiscount, withProductPriceAfterDiscount } = require("../utils/productPricing");
const {
  LANGUAGES,
  assertLanguage,
  cacheGet,
  cacheSet,
  escapeRegex,
  getEntityImageUrl,
  getPublicApiOrigin,
  getWebsiteOrigin,
  hasObjectId,
  normalizeSlug,
  sendBase64Image,
} = require("../utils/seo");

const ENTITY_MODELS = {
  category: Category,
  product: Product,
};

const PRODUCT_PUBLIC_FIELDS =
  "name code image retailPrice discountPercentage inventoryCount category specifications translations seo slugAliases updatedAt createdAt";
const PRODUCT_SEARCH_FIELDS = [
  "name",
  "code",
  "translations.ar.name",
  "translations.en.name",
  "translations.ar.shortDescription",
  "translations.en.shortDescription",
  "translations.ar.description",
  "translations.en.description",
  "seo.ar.keywords",
  "seo.en.keywords",
  "slugAliases.slug",
];
const XML_CONTENT_TYPE = "application/xml; charset=utf-8";
const SITEMAP_URL_LIMIT = 50_000;
const HOME_CATEGORIES_DEFAULT_LIMIT = 12;
const HOME_CATEGORIES_MAX_LIMIT = 50;

const getLocalized = (entity, language) => entity?.translations?.[language] || {};
const hasTranslation = (entity, language) => Boolean(getLocalized(entity, language).name && getLocalized(entity, language).slug);
const allowArabicLegacyFallback = (entity, language) => language === "ar" && Boolean(entity?.name);
const hasPublicLocalizedValue = (entity, language) =>
  hasTranslation(entity, language) || allowArabicLegacyFallback(entity, language);
const hasAnyPublicLocalizedValue = (entity) => LANGUAGES.some((language) => hasPublicLocalizedValue(entity, language));
const getLocalizedName = (entity, language) =>
  getLocalized(entity, language).name || (language === "ar" ? entity.name : undefined);
const getResponseLanguage = (req) => (LANGUAGES.includes(req.params.language) ? req.params.language : "ar");
const getRobots = (seo = {}) =>
  `${seo.robotsIndex === false ? "noindex" : "index"},${seo.robotsFollow === false ? "nofollow" : "follow"}`;
const getCurrency = async () => {
  const setting = await ShippingSetting.findOne({ key: "default" }).select("currency").lean();
  return setting?.currency || "EGP";
};

const localizedUrl = (entityType, language, slug) =>
  slug ? `${getWebsiteOrigin()}/${language}/${entityType === "category" ? "categories" : "products"}/${slug}` : undefined;

const getLocalizedSlug = (entity, language) =>
  getLocalized(entity, language).slug || (language === "ar" ? String(entity._id) : undefined);

const getHomeCategoriesLimit = (value, res) => {
  if (value === undefined || value === "") return HOME_CATEGORIES_DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    res.status(400);
    throw new Error("قيمة limit غير صالحة");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    res.status(400);
    throw new Error("قيمة limit غير صالحة");
  }

  return Math.min(parsed, HOME_CATEGORIES_MAX_LIMIT);
};

const buildHomeProductCountsPipeline = (categoryIds, productIds) => [
  {
    $match: {
      _id: { $in: productIds },
      category: { $in: categoryIds },
    },
  },
  { $group: { _id: "$category", count: { $sum: 1 } } },
];

const orderHomeCategories = (categories, configuredCategoryIds) => {
  if (!configuredCategoryIds.length) return categories;

  const categoriesById = new Map(
    categories.map((category) => [String(category._id), category])
  );
  return configuredCategoryIds.flatMap((categoryId) => {
    const category = categoriesById.get(String(categoryId));
    return category ? [category] : [];
  });
};

const serializeHomeCategory = (req, category, language) => {
  const localized = getLocalized(category, language);
  const name = getLocalizedName(category, language);
  const imageUrl = getEntityImageUrl(req, "category", category);

  return {
    id: String(category._id),
    name,
    slug: getLocalizedSlug(category, language),
    localizedSlugs: {
      ar: getLocalizedSlug(category, "ar") || null,
      en: category.translations?.en?.slug || null,
    },
    image: imageUrl
      ? {
          url: imageUrl,
          alt: localized.imageAlt || name,
        }
      : null,
    productsCount: Number(category.productsCount || 0),
  };
};

const loadHomeCategories = async (language, limit) => {
  const [generalSetting, activeSettings] = await Promise.all([
    GeneralSetting.findOne({ key: "default" })
      .select("homePageCategoryIds")
      .lean(),
    EcommerceSetting.find({ showOnWebsite: true })
      .select("category selectedProducts")
      .lean(),
  ]);

  if (activeSettings.length === 0) return [];

  const activeSettingsByCategory = new Map(
    activeSettings.map((setting) => [String(setting.category), setting])
  );
  const categories = await Category.find({
    _id: { $in: activeSettings.map((setting) => setting.category) },
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  const localizedCategories = categories.filter((category) =>
    hasPublicLocalizedValue(category, language)
  );
  const configuredCategoryIds = generalSetting?.homePageCategoryIds || [];
  const orderedCategories = orderHomeCategories(
    localizedCategories,
    configuredCategoryIds
  ).slice(0, limit);

  if (orderedCategories.length === 0) return [];

  const categoryIds = orderedCategories.map((category) => category._id);
  const publicProductIds = orderedCategories.flatMap(
    (category) =>
      activeSettingsByCategory.get(String(category._id))?.selectedProducts || []
  );
  const productCounts =
    publicProductIds.length > 0
      ? await Product.aggregate(
          buildHomeProductCountsPipeline(categoryIds, publicProductIds)
        )
      : [];
  const productCountsByCategory = new Map(
    productCounts.map((row) => [String(row._id), Number(row.count || 0)])
  );

  return orderedCategories.map((category) => ({
    ...category,
    productsCount: productCountsByCategory.get(String(category._id)) || 0,
  }));
};

const getHomeCategories = asyncHandler(async (req, res) => {
  const { language } = req.params;
  assertLanguage(language, res);
  const limit = getHomeCategoriesLimit(req.query.limit, res);

  let categories;
  try {
    categories = await loadHomeCategories(language, limit);
  } catch (_error) {
    const error = new Error("تعذر تحميل فئات الصفحة الرئيسية");
    error.statusCode = 500;
    throw error;
  }

  res.set?.("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json({
    success: true,
    data: {
      categories: categories.map((category) =>
        serializeHomeCategory(req, category, language)
      ),
    },
  });
});

const alternates = (entity, entityType) => {
  const ar = getLocalizedSlug(entity, "ar");
  const en = entity.translations?.en?.slug;
  const urls = {};
  if (ar) urls.ar = localizedUrl(entityType, "ar", ar);
  if (en) urls.en = localizedUrl(entityType, "en", en);
  if (ar) urls.xDefault = urls.ar;
  return urls;
};

const xmlEscape = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const getSitemapRowLanguage = (row) => {
  if (row.language) return row.language;
  if (row.loc?.includes("/en/")) return "en";
  return "ar";
};

const sitemapRowsForLanguage = (rows, language) =>
  rows.filter((row) => getSitemapRowLanguage(row) === language);

const renderAlternateLinks = (alternates = {}) =>
  ["ar", "en", "xDefault"]
    .flatMap((key) => {
      const href = alternates[key];
      if (!href) return [];
      const hreflang = key === "xDefault" ? "x-default" : key;
      return [`    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${xmlEscape(href)}"/>`];
    })
    .join("\n");

const renderSitemapUrl = (row) => {
  const alternatesXml = renderAlternateLinks(row.alternates);
  return [
    "  <url>",
    `    <loc>${xmlEscape(row.loc)}</loc>`,
    row.lastmod ? `    <lastmod>${xmlEscape(row.lastmod)}</lastmod>` : undefined,
    row.changefreq ? `    <changefreq>${xmlEscape(row.changefreq)}</changefreq>` : undefined,
    row.priority !== undefined ? `    <priority>${xmlEscape(Number(row.priority).toFixed(1))}</priority>` : undefined,
    alternatesXml || undefined,
    "  </url>",
  ]
    .filter(Boolean)
    .join("\n");
};

const renderSitemapXml = (rows) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...rows.slice(0, SITEMAP_URL_LIMIT).map(renderSitemapUrl),
    "</urlset>",
  ].join("\n");

const renderImageSitemapUrl = (row) => {
  const alternatesXml = renderAlternateLinks(row.alternates);
  return [
    "  <url>",
    `    <loc>${xmlEscape(row.loc)}</loc>`,
    row.lastmod ? `    <lastmod>${xmlEscape(row.lastmod)}</lastmod>` : undefined,
    alternatesXml || undefined,
    "    <image:image>",
    `      <image:loc>${xmlEscape(row.image.loc)}</image:loc>`,
    row.image.title ? `      <image:title>${xmlEscape(row.image.title)}</image:title>` : undefined,
    "    </image:image>",
    "  </url>",
  ]
    .filter(Boolean)
    .join("\n");
};

const renderImageSitemapXml = (rows) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    ...rows.filter((row) => row.image?.loc).slice(0, SITEMAP_URL_LIMIT).map(renderImageSitemapUrl),
    "</urlset>",
  ].join("\n");

const renderSitemapIndexXml = (rows) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...rows.map((row) =>
      [
        "  <sitemap>",
        `    <loc>${xmlEscape(row.loc)}</loc>`,
        row.lastmod ? `    <lastmod>${xmlEscape(row.lastmod)}</lastmod>` : undefined,
        "  </sitemap>",
      ]
        .filter(Boolean)
        .join("\n")
    ),
    "</sitemapindex>",
  ].join("\n");

const sitemapChunks = (rows) => {
  const chunks = [];
  for (let index = 0; index < rows.length; index += SITEMAP_URL_LIMIT) {
    chunks.push(rows.slice(index, index + SITEMAP_URL_LIMIT));
  }
  return chunks.length > 0 ? chunks : [[]];
};

const sendXmlSitemap = (res, xml) => {
  res.status(200);
  res.set("Content-Type", XML_CONTENT_TYPE);
  res.set("Cache-Control", "public, max-age=300");
  res.send(xml);
};

const isIncludedInSitemap = (entity) =>
  entity?.seo?.robotsIndex !== false && entity?.seo?.includeInSitemap !== false;

const buildCategorySitemapRows = (categories, req) =>
  categories
    .filter(isIncludedInSitemap)
    .flatMap((category) =>
      LANGUAGES.flatMap((language) => {
        const slug = category.translations?.[language]?.slug;
        if (!slug || !hasTranslation(category, language)) return [];
        return [{
          loc: localizedUrl("category", language, slug),
          language,
          lastmod: category.updatedAt?.toISOString(),
          changefreq: category.seo?.sitemapChangeFrequency || "weekly",
          priority: category.seo?.sitemapPriority ?? 0.7,
          alternates: alternates(category, "category"),
          image: category.image ? { loc: getEntityImageUrl(req, "category", category), title: getLocalizedName(category, language) } : undefined,
        }];
      })
    );

const buildProductSitemapRows = (products, req) =>
  products
    .filter(isIncludedInSitemap)
    .flatMap((product) =>
      LANGUAGES.flatMap((language) => {
        const slug = product.translations?.[language]?.slug;
        if (!slug || !hasTranslation(product, language)) return [];
        return [{
          loc: localizedUrl("product", language, slug),
          language,
          lastmod: product.updatedAt?.toISOString(),
          changefreq: product.seo?.sitemapChangeFrequency || "weekly",
          priority: product.seo?.sitemapPriority ?? 0.8,
          alternates: alternates(product, "product"),
          image: product.image ? { loc: getEntityImageUrl(req, "product", product), title: getLocalizedName(product, language) } : undefined,
        }];
      })
    );

const buildSeo = ({ entity, entityType, language, imageUrl }) => {
  const localized = getLocalized(entity, language);
  const seo = entity.seo || {};
  const langSeo = seo[language] || {};
  const name = getLocalizedName(entity, language);
  const canonicalUrl =
    langSeo.canonicalOverride || localizedUrl(entityType, language, getLocalizedSlug(entity, language));
  const fallbackTitle =
    entityType === "category"
      ? language === "ar"
        ? `${name} في مصر | كابوماتيك`
        : `${name} in Egypt | Kapomatic`
      : language === "ar"
        ? `${name} | كابوماتيك`
        : `${name} | Kapomatic`;
  const description = langSeo.metaDescription || localized.description || localized.shortDescription || "";
  const title = langSeo.metaTitle || fallbackTitle;
  const ogTitle = langSeo.ogTitle || title;
  const ogDescription = langSeo.ogDescription || description;
  const ogImage = seo.ogImage && !seo.ogImage.startsWith("data:") ? seo.ogImage : imageUrl;

  return {
    title,
    description,
    canonicalUrl,
    alternateUrls: alternates(entity, entityType),
    robots: getRobots(seo),
    og: {
      title: ogTitle,
      description: ogDescription,
      image: ogImage,
      url: canonicalUrl,
      type: entityType === "product" ? "product" : "website",
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description: ogDescription,
      image: ogImage,
    },
    structuredData: [],
  };
};

const findActiveSettingForCategory = (categoryId) =>
  EcommerceSetting.findOne({ category: categoryId, showOnWebsite: true }).lean();

const getActiveProductIds = async () => {
  const settings = await EcommerceSetting.find({ showOnWebsite: true }).select("selectedProducts").lean();
  return [...new Set(settings.flatMap((setting) => (setting.selectedProducts || []).map(String)))];
};

const getPublicProductSearchTerm = (query, res) => {
  const searchTerm = String(query.q ?? query.search ?? "").trim();
  if (!searchTerm) {
    res.status(400);
    throw new Error("مطلوب معامل البحث q");
  }
  return searchTerm;
};

const normalizeArabicSearchText = (value) =>
  String(value)
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ـ/g, "");

const hasArabicCharacters = (value) => /\p{Script=Arabic}/u.test(value);

const arabicRegexCharacter = (character) => {
  const escapedCharacter = escapeRegex(character);
  if (character === "ا") return "[اأإآ]";
  if (character === "أ" || character === "إ" || character === "آ") return "[اأإآ]";
  return escapedCharacter;
};

const buildArabicSearchPattern = (value) =>
  normalizeArabicSearchText(value)
    .split("")
    .map(arabicRegexCharacter)
    .join("[ً-ٰٟـ]*");

const buildPublicProductSearchRegexes = (searchTerm) => {
  const regexes = [new RegExp(escapeRegex(searchTerm), "i")];
  if (hasArabicCharacters(searchTerm)) {
    const arabicPattern = buildArabicSearchPattern(searchTerm);
    if (arabicPattern && arabicPattern !== escapeRegex(searchTerm)) {
      regexes.push(new RegExp(arabicPattern, "i"));
    }
  }
  return regexes;
};

const buildPublicProductSearchQuery = (activeProductIds, searchTerm) => {
  const regexes = buildPublicProductSearchRegexes(searchTerm);
  return {
    _id: { $in: activeProductIds },
    $or: PRODUCT_SEARCH_FIELDS.flatMap((field) => regexes.map((regex) => ({ [field]: regex }))),
  };
};

const getProductSearchValues = (product) => [
  product.name,
  product.code,
  product.translations?.ar?.name,
  product.translations?.en?.name,
  product.translations?.ar?.shortDescription,
  product.translations?.en?.shortDescription,
  product.translations?.ar?.description,
  product.translations?.en?.description,
  ...(product.seo?.ar?.keywords || []),
  ...(product.seo?.en?.keywords || []),
  ...(product.slugAliases || []).map((alias) => alias.slug),
];

const normalizeComparableSearchValue = (value) => normalizeArabicSearchText(String(value || "")).toLowerCase();

const getPublicProductSearchRelevance = (product, searchTerm) => {
  const normalizedSearchTerm = normalizeComparableSearchValue(searchTerm);
  if (!normalizedSearchTerm) return 4;
  const values = getProductSearchValues(product).map(normalizeComparableSearchValue).filter(Boolean);
  if (values.some((value) => value === normalizedSearchTerm)) return 0;
  if (values.some((value) => value.startsWith(normalizedSearchTerm))) return 1;
  if (values.some((value) => value.includes(normalizedSearchTerm))) return 2;
  return 3;
};

const sortProductsByPublicSearchRelevance = (products, searchTerm) =>
  [...products].sort((left, right) => {
    const relevanceDiff =
      getPublicProductSearchRelevance(left, searchTerm) -
      getPublicProductSearchRelevance(right, searchTerm);
    if (relevanceDiff !== 0) return relevanceDiff;
    return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
  });

const parseSort = (sort) => {
  if (sort === "price_asc") return { retailPrice: 1, _id: 1 };
  if (sort === "price_desc") return { retailPrice: -1, _id: 1 };
  return { createdAt: -1, _id: -1 };
};

const productMatchesFilters = (product, query) => {
  const ignored = new Set(["page", "limit", "sort", "q", "search"]);
  const filters = Object.entries(query).filter(([key, value]) => !ignored.has(key) && value !== undefined && value !== "");
  if (filters.length === 0) return true;

  return filters.every(([key, value]) =>
    (product.specifications || []).some((specification) => {
      const name = String(specification.name ?? specification.title ?? specification.key ?? specification.label ?? "").trim();
      const rawValue = specification.value ?? specification.values;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      return name === key && values.map((item) => String(item)).includes(String(value));
    })
  );
};

const serializeProduct = (req, product, language, currency) => {
  const priced = withProductPriceAfterDiscount(product);
  const category = product.category;
  const imageUrl = getEntityImageUrl(req, "product", product);
  const ratingFields = {};
  if (product.rating !== undefined) ratingFields.rating = product.rating;
  if (product.averageRating !== undefined) ratingFields.averageRating = product.averageRating;
  if (product.reviewCount !== undefined) ratingFields.reviewCount = product.reviewCount;
  if (product.reviewsCount !== undefined) ratingFields.reviewsCount = product.reviewsCount;

  return {
    id: product._id,
    name: getLocalizedName(product, language),
    description: getLocalized(product, language).description,
    slug: getLocalizedSlug(product, language),
    imageAlt: getLocalized(product, language).imageAlt,
    code: product.code,
    translations: product.translations,
    slugAliases: product.slugAliases || [],
    category: category
      ? {
          id: category._id,
          name: getLocalizedName(category, language),
          slug: getLocalizedSlug(category, language),
        }
      : undefined,
    imageUrl,
    retailPrice: product.retailPrice,
    discountPercentage: Number(product.discountPercentage || 0),
    finalVisiblePrice:
      Number(product.discountPercentage || 0) > 0 ? priced.priceAfterDiscount : Number(product.retailPrice || 0),
    currency,
    availability:
      Number(product.inventoryCount || 0) > 0
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    specifications: product.specifications || [],
    ...ratingFields,
  };
};

const getSlugAvailability = asyncHandler(async (req, res) => {
  const { entityType, language, excludeId } = req.query;
  if (!ENTITY_MODELS[entityType]) {
    res.status(400);
    throw new Error("entityType غير صالح");
  }
  assertLanguage(language, res);
  const slug = normalizeSlug(req.query.slug, language);
  if (!slug) {
    res.status(400);
    throw new Error("slug مطلوب");
  }
  const query = { [`translations.${language}.slug`]: slug };
  if (excludeId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(String(excludeId))) {
      res.status(400);
      throw new Error("excludeId غير صالح");
    }
    query._id = { $ne: excludeId };
  }
  const existing = await ENTITY_MODELS[entityType].exists(query);
  res.json({ available: !existing });
});

const getLocalizedCategory = asyncHandler(async (req, res) => {
  const { language, slug } = req.params;
  assertLanguage(language, res);
  const normalizedSlug = normalizeSlug(slug, language);
  const isObjectIdLookup = mongoose.Types.ObjectId.isValid(slug);
  const cacheKey = `category:${language}:${isObjectIdLookup ? slug : normalizedSlug}:${req.originalUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const categoryQuery = isObjectIdLookup
    ? { _id: slug }
    : { [`translations.${language}.slug`]: normalizedSlug };
  const category = await Category.findOne(categoryQuery).lean();
  if (!category || !hasPublicLocalizedValue(category, language)) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }
  const setting = await findActiveSettingForCategory(category._id);
  if (!setting) {
    res.status(404);
    throw new Error("الفئة غير مفعلة في الموقع");
  }

  const imageUrl = getEntityImageUrl(req, "category", category);
  const response = {
    data: {
      id: category._id,
      name: getLocalizedName(category, language),
      description: getLocalized(category, language).description,
      slug: getLocalizedSlug(category, language),
      imageUrl,
      imageAlt: getLocalized(category, language).imageAlt,
      products: [],
      pagination: buildPaginationMetadata({ page: 1, limit: 0 || 1, totalItems: 0 }),
    },
    seo: buildSeo({ entity: category, entityType: "category", language, imageUrl }),
  };
  response.data.pagination.limit = 0;
  cacheSet(cacheKey, response);
  res.json(response);
});

const getLocalizedCategoryProducts = asyncHandler(async (req, res) => {
  const { language, slug } = req.params;
  assertLanguage(language, res);
  const normalizedSlug = normalizeSlug(slug, language);
  const isObjectIdLookup = mongoose.Types.ObjectId.isValid(slug);
  const { page, limit, skip } = getPaginationParams(req.query);

  const categoryQuery = isObjectIdLookup
    ? { _id: slug }
    : { [`translations.${language}.slug`]: normalizedSlug };
  const category = await Category.findOne(categoryQuery).lean();
  if (!category || !hasPublicLocalizedValue(category, language)) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }
  const setting = await findActiveSettingForCategory(category._id);
  if (!setting) {
    res.status(404);
    throw new Error("الفئة غير مفعلة في الموقع");
  }

  const products = await Product.find({ category: category._id })
    .select(PRODUCT_PUBLIC_FIELDS)
    .populate("category", "name image translations seo")
    .sort(parseSort(req.query.sort))
    .lean();
  const localizedProducts = products.filter((product) => hasPublicLocalizedValue(product, language) && productMatchesFilters(product, req.query));
  const totalItems = localizedProducts.length;
  const currency = await getCurrency();
  const response = {
    data: {
      id: category._id,
      name: getLocalizedName(category, language),
      description: getLocalized(category, language).description,
      slug: getLocalizedSlug(category, language),
      imageUrl: getEntityImageUrl(req, "category", category),
      imageAlt: getLocalized(category, language).imageAlt,
      products: localizedProducts.slice(skip, skip + limit).map((product) => serializeProduct(req, product, language, currency)),
      pagination: buildPaginationMetadata({ page, limit, totalItems }),
    },
    seo: buildSeo({
      entity: category,
      entityType: "category",
      language,
      imageUrl: getEntityImageUrl(req, "category", category),
    }),
  };
  res.json(response);
});

const getLocalizedProduct = asyncHandler(async (req, res) => {
  const { language, slug } = req.params;
  assertLanguage(language, res);
  const normalizedSlug = normalizeSlug(slug, language);
  const isObjectIdLookup = mongoose.Types.ObjectId.isValid(slug);
  const cacheKey = `product:${language}:${isObjectIdLookup ? slug : normalizedSlug}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const productQuery = isObjectIdLookup
    ? { _id: slug }
    : { [`translations.${language}.slug`]: normalizedSlug };
  const product = await Product.findOne(productQuery)
    .select(PRODUCT_PUBLIC_FIELDS)
    .populate("category", "name image translations seo")
    .lean();
  if (!product || !hasPublicLocalizedValue(product, language)) {
    res.status(404);
    throw new Error("المنتج غير موجود");
  }
  const setting = await findActiveSettingForCategory(product.category?._id);
  if (!setting || !hasObjectId(setting.selectedProducts || [], product._id)) {
    res.status(404);
    throw new Error("المنتج غير متاح في الموقع");
  }
  const currency = await getCurrency();
  const imageUrl = getEntityImageUrl(req, "product", product);
  const response = {
    data: serializeProduct(req, product, language, currency),
    seo: buildSeo({ entity: product, entityType: "product", language, imageUrl }),
  };
  response.seo.structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      name: response.data.name,
      sku: product.code,
      image: imageUrl ? [imageUrl] : undefined,
      description: response.seo.description || undefined,
      offers: {
        "@type": "Offer",
        priceCurrency: currency,
        price: response.data.finalVisiblePrice,
        availability: response.data.availability,
        url: response.seo.canonicalUrl,
      },
    },
  ];
  cacheSet(cacheKey, response);
  res.json(response);
});

const searchLocalizedProducts = asyncHandler(async (req, res) => {
  const language = getResponseLanguage(req);
  if (req.params.language) assertLanguage(req.params.language, res);
  const searchTerm = getPublicProductSearchTerm(req.query, res);
  const { page, limit, skip } = getPaginationParams(req.query);
  const activeProductIds = await getActiveProductIds();
  if (activeProductIds.length === 0) {
    return res.json({ success: true, products: [], pagination: buildPaginationMetadata({ page, limit, totalItems: 0 }) });
  }
  const products = await Product.find(buildPublicProductSearchQuery(activeProductIds, searchTerm))
    .select(PRODUCT_PUBLIC_FIELDS)
    .populate("category", "name image translations seo")
    .lean();
  const isLocalizedAlias = Boolean(req.params.language);
  const localizedProducts = sortProductsByPublicSearchRelevance(
    products.filter((product) =>
      isLocalizedAlias ? hasPublicLocalizedValue(product, language) : hasAnyPublicLocalizedValue(product)
    ),
    searchTerm
  );
  const currency = await getCurrency();
  const totalItems = localizedProducts.length;
  res.json({
    success: true,
    products: localizedProducts.slice(skip, skip + limit).map((product) => serializeProduct(req, product, language, currency)),
    pagination: buildPaginationMetadata({ page, limit, totalItems }),
  });
});

const resolveSlugAlias = asyncHandler(async (req, res) => {
  const { entityType, language, slug } = req.params;
  if (!ENTITY_MODELS[entityType]) {
    res.status(400);
    throw new Error("entityType غير صالح");
  }
  assertLanguage(language, res);
  const normalizedSlug = normalizeSlug(slug, language);
  const entity = await ENTITY_MODELS[entityType].findOne({
    slugAliases: { $elemMatch: { language, slug: normalizedSlug } },
  }).lean();
  if (!entity || !hasTranslation(entity, language)) {
    res.status(404);
    throw new Error("slug غير موجود");
  }
  if (entityType === "category") {
    const setting = await findActiveSettingForCategory(entity._id);
    if (!setting) {
      res.status(404);
      throw new Error("الفئة غير متاحة");
    }
  } else {
    const activeProductIds = await getActiveProductIds();
    if (!activeProductIds.includes(String(entity._id))) {
      res.status(404);
      throw new Error("المنتج غير متاح");
    }
  }
  res.json({
    redirect: true,
    statusCode: 301,
    location: localizedUrl(entityType, language, getLocalized(entity, language).slug),
  });
});

const sitemapRowsFor = async (entityType, req) => {
  if (entityType === "category") {
    const settings = await EcommerceSetting.find({ showOnWebsite: true }).select("category").lean();
    const ids = settings.map((setting) => setting.category);
    const categories = await Category.find({
      _id: { $in: ids },
      "seo.robotsIndex": { $ne: false },
      "seo.includeInSitemap": { $ne: false },
    }).lean();
    return buildCategorySitemapRows(categories, req);
  }

  const activeProductIds = await getActiveProductIds();
  const products = await Product.find({
    _id: { $in: activeProductIds },
    "seo.robotsIndex": { $ne: false },
    "seo.includeInSitemap": { $ne: false },
  }).lean();
  return buildProductSitemapRows(products, req);
};

const paginateRows = (rows, req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ data: rows.slice(skip, skip + limit), pagination: buildPaginationMetadata({ page, limit, totalItems: rows.length }) });
};

const getSitemapPages = asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({ data: [{ loc: getWebsiteOrigin(), lastmod: undefined, alternates: { ar: `${getWebsiteOrigin()}/ar`, en: `${getWebsiteOrigin()}/en` } }] });
});

const getSitemapCategories = asyncHandler(async (req, res) => paginateRows(await sitemapRowsFor("category", req), req, res));
const getSitemapProducts = asyncHandler(async (req, res) => paginateRows(await sitemapRowsFor("product", req), req, res));
const getSitemapImages = asyncHandler(async (req, res) => {
  const rows = [...(await sitemapRowsFor("category", req)), ...(await sitemapRowsFor("product", req))]
    .filter((row) => row.image)
    .map((row) => ({ loc: row.loc, lastmod: row.lastmod, alternates: row.alternates, image: row.image }));
  paginateRows(rows, req, res);
});

const pageSitemapRowsForLanguage = (language) => [
  {
    loc: `${getWebsiteOrigin()}/${language}`,
    language,
    lastmod: undefined,
    changefreq: "daily",
    priority: 1.0,
    alternates: {
      ar: `${getWebsiteOrigin()}/ar`,
      en: `${getWebsiteOrigin()}/en`,
      xDefault: `${getWebsiteOrigin()}/ar`,
    },
  },
];

const getSitemapXmlPages = (language) =>
  asyncHandler(async (_req, res) => {
    sendXmlSitemap(res, renderSitemapXml(pageSitemapRowsForLanguage(language)));
  });

const getSitemapXmlCategories = (language) =>
  asyncHandler(async (req, res) => {
    const rows = sitemapRowsForLanguage(await sitemapRowsFor("category", req), language);
    sendXmlSitemap(res, renderSitemapXml(rows));
  });

const getSitemapXmlProducts = (language) =>
  asyncHandler(async (req, res) => {
    const rows = sitemapRowsForLanguage(await sitemapRowsFor("product", req), language);
    sendXmlSitemap(res, renderSitemapXml(rows));
  });

const getSitemapChunk = (rows, req) => {
  const page = Math.max(1, Number.parseInt(req.params.page || "1", 10) || 1);
  return sitemapChunks(rows)[page - 1] || [];
};

const getSitemapXmlCategoriesChunk = (language) =>
  asyncHandler(async (req, res) => {
    const rows = sitemapRowsForLanguage(await sitemapRowsFor("category", req), language);
    sendXmlSitemap(res, renderSitemapXml(getSitemapChunk(rows, req)));
  });

const getSitemapXmlProductsChunk = (language) =>
  asyncHandler(async (req, res) => {
    const rows = sitemapRowsForLanguage(await sitemapRowsFor("product", req), language);
    sendXmlSitemap(res, renderSitemapXml(getSitemapChunk(rows, req)));
  });

const getSitemapXmlImages = asyncHandler(async (req, res) => {
  const rows = [...(await sitemapRowsFor("category", req)), ...(await sitemapRowsFor("product", req))]
    .filter((row) => row.image?.loc)
    .map((row) => ({ loc: row.loc, lastmod: row.lastmod, alternates: row.alternates, image: row.image }));
  sendXmlSitemap(res, renderImageSitemapXml(rows));
});

const getSitemapXmlImagesChunk = asyncHandler(async (req, res) => {
  const rows = [...(await sitemapRowsFor("category", req)), ...(await sitemapRowsFor("product", req))]
    .filter((row) => row.image?.loc)
    .map((row) => ({ loc: row.loc, lastmod: row.lastmod, alternates: row.alternates, image: row.image }));
  sendXmlSitemap(res, renderImageSitemapXml(getSitemapChunk(rows, req)));
});

const getSitemapXmlIndex = asyncHandler(async (req, res) => {
  const [categoryRows, productRows] = await Promise.all([
    sitemapRowsFor("category", req),
    sitemapRowsFor("product", req),
  ]);
  const imageRows = [...categoryRows, ...productRows].filter((row) => row.image?.loc);
  const sitemapEntries = [
    { name: "pages-ar", count: 1 },
    { name: "pages-en", count: 1 },
    { name: "categories-ar", count: sitemapRowsForLanguage(categoryRows, "ar").length },
    { name: "categories-en", count: sitemapRowsForLanguage(categoryRows, "en").length },
    { name: "products-ar", count: sitemapRowsForLanguage(productRows, "ar").length },
    { name: "products-en", count: sitemapRowsForLanguage(productRows, "en").length },
    { name: "images", count: imageRows.length },
  ].flatMap(({ name, count }) => {
    const chunkCount = Math.max(1, Math.ceil(count / SITEMAP_URL_LIMIT));
    return Array.from({ length: chunkCount }, (_item, index) => ({
      loc:
        chunkCount === 1
          ? `${getPublicApiOrigin(req)}/api/public/seo/sitemaps/${name}.xml`
          : `${getPublicApiOrigin(req)}/api/public/seo/sitemaps/${name}-${index + 1}.xml`,
      lastmod: new Date().toISOString(),
    }));
  });
  sendXmlSitemap(res, renderSitemapIndexXml(sitemapEntries));
});

const getCategoryImage = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id).select("image").lean();
  sendBase64Image(category, res, "صورة الفئة غير موجودة");
});

const getProductImage = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).select("image").lean();
  sendBase64Image(product, res, "صورة المنتج غير موجودة");
});

module.exports = {
  getSlugAvailability,
  getHomeCategories,
  getLocalizedCategory,
  getLocalizedCategoryProducts,
  getLocalizedProduct,
  searchLocalizedProducts,
  resolveSlugAlias,
  getSitemapPages,
  getSitemapCategories,
  getSitemapProducts,
  getSitemapImages,
  getSitemapXmlPagesAr: getSitemapXmlPages("ar"),
  getSitemapXmlPagesEn: getSitemapXmlPages("en"),
  getSitemapXmlCategoriesAr: getSitemapXmlCategories("ar"),
  getSitemapXmlCategoriesEn: getSitemapXmlCategories("en"),
  getSitemapXmlProductsAr: getSitemapXmlProducts("ar"),
  getSitemapXmlProductsEn: getSitemapXmlProducts("en"),
  getSitemapXmlCategoriesArChunk: getSitemapXmlCategoriesChunk("ar"),
  getSitemapXmlCategoriesEnChunk: getSitemapXmlCategoriesChunk("en"),
  getSitemapXmlProductsArChunk: getSitemapXmlProductsChunk("ar"),
  getSitemapXmlProductsEnChunk: getSitemapXmlProductsChunk("en"),
  getSitemapXmlImages,
  getSitemapXmlImagesChunk,
  getSitemapXmlIndex,
  getCategoryImage,
  getProductImage,
  _private: {
    buildHomeProductCountsPipeline,
    buildPublicProductSearchQuery,
    buildPublicProductSearchRegexes,
    buildCategorySitemapRows,
    buildProductSitemapRows,
    getPublicProductSearchTerm,
    getHomeCategoriesLimit,
    getPublicProductSearchRelevance,
    normalizeArabicSearchText,
    pageSitemapRowsForLanguage,
    renderImageSitemapXml,
    renderSitemapIndexXml,
    renderSitemapXml,
    sitemapChunks,
    sitemapRowsForLanguage,
    sortProductsByPublicSearchRelevance,
    loadHomeCategories,
    orderHomeCategories,
    serializeHomeCategory,
    xmlEscape,
  },
};
