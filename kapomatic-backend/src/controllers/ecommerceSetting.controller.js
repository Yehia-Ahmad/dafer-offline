const mongoose = require("mongoose");
const Category = require("../models/category.model");
const EcommerceSetting = require("../models/ecommerceSetting.model");
const GeneralSetting = require("../models/generalSetting.model");
const Product = require("../models/product.model");
const ShippingSetting = require("../models/shippingSetting.model");
const asyncHandler = require("../utils/asyncHandler");
const { buildPaginationMetadata, getPaginationParams } = require("../utils/pagination");
const { withProductPriceAfterDiscount } = require("../utils/productPricing");
const {
  loadBoundedActiveCategories,
} = require("../services/publicCatalog.service");
const { createPublicPerformance } = require("../utils/publicPerformance");
const {
  cacheGet,
  cacheSet,
  clearPublicSeoCache,
  getEntityImageAssetUrl,
  getEntityImageUrl,
  getPublicApiOrigin,
} = require("../utils/seo");

const ECOMMERCE_PRODUCT_FIELDS =
  "name code image retailPrice wholesalePrice discountPercentage inventoryCount category specifications rating averageRating reviewCount reviewsCount";

const ACTIVE_CATEGORY_PRODUCT_SORTS = new Set([
  "price_asc",
  "price_desc",
  "rating_desc",
]);

const withPricingForSetting = (setting) => ({
  ...setting,
  selectedProducts: (setting.selectedProducts || []).map(withProductPriceAfterDiscount),
  filters: (setting.filters || []).map((filter) => ({
    ...filter,
    products: (filter.products || []).map(withProductPriceAfterDiscount),
  })),
});

const populateSetting = (query) =>
  query
    .populate("category", "name image")
    .populate("selectedProducts", ECOMMERCE_PRODUCT_FIELDS)
    .populate("filters.products", ECOMMERCE_PRODUCT_FIELDS);

const populateSettingDocument = async (setting) => {
  await setting.populate("category", "name image");
  await setting.populate(
    "selectedProducts",
    ECOMMERCE_PRODUCT_FIELDS
  );
  await setting.populate(
    "filters.products",
    ECOMMERCE_PRODUCT_FIELDS
  );
  return setting;
};

const getSpecificationName = (specification) => {
  if (!specification || typeof specification !== "object") return "";
  return String(
    specification.name ?? specification.title ?? specification.key ?? specification.label ?? ""
  ).trim();
};

const getSpecificationValue = (specification) => {
  if (!specification || typeof specification !== "object") return undefined;
  return specification.value ?? specification.values;
};

const normalizeComparableValue = (value) =>
  String(value && typeof value === "object" ? JSON.stringify(value) : value)
    .trim()
    .toLowerCase();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const serializeUniqueValue = (value) =>
  value && typeof value === "object" ? JSON.stringify(value) : String(value);

const toArray = (value) => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const normalizeObjectIdsToStrings = (ids = []) => ids.map((id) => id.toString());

const getProductSpecificationValues = (product, specificationName) => {
  const normalizedSpecificationName = normalizeComparableValue(specificationName);

  return (product.specifications || []).flatMap((specification) => {
    if (
      normalizeComparableValue(getSpecificationName(specification)) !== normalizedSpecificationName
    ) {
      return [];
    }

    const value = getSpecificationValue(specification);
    return Array.isArray(value) ? value : [value];
  });
};

const parseSpecificationSearchFilters = (query, res) => {
  const names = toArray(query.specification ?? query.specificationName ?? query.name);
  const values = toArray(query.value);

  if (names.length === 0 && values.length === 0) return [];

  if (names.length === 0 || values.length === 0 || names.length !== values.length) {
    res.status(400);
    throw new Error("يجب إرسال specification و value بنفس العدد");
  }

  return names.map((name, index) => {
    const specificationName = String(name).trim();
    const value = String(values[index]).trim();

    if (!specificationName || !value) {
      res.status(400);
      throw new Error("قيم specification و value مطلوبة");
    }

    return { specificationName, value };
  });
};

const parseActiveCategoryProductSort = (query, res) => {
  const sort = query.sort ?? query.filter;

  if (sort === undefined || sort === "") return undefined;

  if (typeof sort !== "string" || !ACTIVE_CATEGORY_PRODUCT_SORTS.has(sort)) {
    res.status(400);
    throw new Error("قيمة sort غير صالحة");
  }

  return sort;
};

const getProductRating = (product) =>
  Number(product.rating ?? product.averageRating ?? product.reviewRating ?? 0) || 0;

const sortActiveCategoryProducts = (products, sort) => {
  if (!sort) return products;

  return [...products].sort((left, right) => {
    if (sort === "price_asc" || sort === "price_desc") {
      const leftPrice = Number(left.priceAfterDiscount ?? left.retailPrice ?? 0);
      const rightPrice = Number(right.priceAfterDiscount ?? right.retailPrice ?? 0);
      return sort === "price_asc" ? leftPrice - rightPrice : rightPrice - leftPrice;
    }

    return getProductRating(right) - getProductRating(left);
  });
};

const normalizeSearchTerm = (value, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error("مطلوب معامل البحث q");
  }

  return value.trim();
};

const getProductSearchRelevance = (product, searchTerm) => {
  const normalizedName = normalizeComparableValue(product.name);
  const normalizedSearchTerm = normalizeComparableValue(searchTerm);
  const matchIndex = normalizedName.indexOf(normalizedSearchTerm);

  if (normalizedName === normalizedSearchTerm) return 0;
  if (normalizedName.startsWith(normalizedSearchTerm)) return 1;
  if (normalizedName.split(/\s+/).some((word) => word.startsWith(normalizedSearchTerm))) return 2;
  if (matchIndex >= 0) return 3 + matchIndex / 1000;
  return Number.MAX_SAFE_INTEGER;
};

const sortProductsByNameSearchRelevance = (products, searchTerm) =>
  [...products].sort((left, right) => {
    const relevanceDifference =
      getProductSearchRelevance(left, searchTerm) -
      getProductSearchRelevance(right, searchTerm);

    if (relevanceDifference !== 0) return relevanceDifference;

    return String(left.name || "").localeCompare(String(right.name || ""), "ar");
  });

const productMatchesSpecificationSearchFilters = (product, filters) =>
  filters.every(({ specificationName, value }) => {
    const normalizedFilterValue = normalizeComparableValue(value);
    return getProductSpecificationValues(product, specificationName).some(
      (productValue) => normalizeComparableValue(productValue) === normalizedFilterValue
    );
  });

const buildCategorySpecificationFilters = (categorySpecifications = [], products = []) => {
  const valuesBySpecificationName = products.reduce((groupedValues, product) => {
    (product.specifications || []).forEach((specification) => {
      const specificationName = getSpecificationName(specification);
      if (!specificationName) return;

      const rawValue = getSpecificationValue(specification);
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];

      values.forEach((value) => {
        if (value === undefined || value === null || value === "") return;
        if (!groupedValues.has(specificationName)) groupedValues.set(specificationName, new Map());
        groupedValues.get(specificationName).set(serializeUniqueValue(value), value);
      });
    });

    return groupedValues;
  }, new Map());

  return categorySpecifications.map((specification) => {
    const specificationName = getSpecificationName(specification);
    const valuesMap = valuesBySpecificationName.get(specificationName);

    return {
      ...specification,
      values: valuesMap ? [...valuesMap.values()] : [],
    };
  });
};

const getFilterTitle = (filter) =>
  String(filter?.title ?? filter?.name ?? filter?.key ?? filter?.label ?? "").trim();

const buildFilterVisibilityByTitle = (filters = []) =>
  filters.reduce((visibilityByTitle, filter) => {
    const title = getFilterTitle(filter);
    if (title) visibilityByTitle.set(normalizeComparableValue(title), filter.isVisible);
    return visibilityByTitle;
  }, new Map());

const formatSpecificationFilterResponse = (specificationFilters = [], settingFilters = []) => {
  const visibilityByTitle = buildFilterVisibilityByTitle(settingFilters);

  return specificationFilters.map((filter) => {
    const title = getFilterTitle(filter);
    const savedVisibility = visibilityByTitle.get(normalizeComparableValue(title));

    return {
      title,
      isVisible: parseBoolean(savedVisibility, parseBoolean(filter.isVisible, true)),
      values: filter.values || [],
    };
  });
};

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined) return defaultValue;
  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "true" || normalizedValue === "1") return true;
    if (normalizedValue === "false" || normalizedValue === "0") return false;
  }

  return value === true || value === 1;
};

const parseNonNegativeNumber = (value, fieldLabel, res) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    res.status(400);
    throw new Error(`${fieldLabel} يجب أن يكون رقمًا غير سالب`);
  }

  return Number(parsed.toFixed(2));
};

const normalizeCurrency = (value, res) => {
  if (typeof value !== "string") {
    res.status(400);
    throw new Error("رمز العملة مطلوب");
  }

  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    res.status(400);
    throw new Error("يجب أن تكون العملة رمز ISO 4217 مكونًا من 3 أحرف مثل EGP");
  }

  return currency;
};

const normalizeRequiredText = (value, fieldLabel, res) => {
  if (typeof value !== "string" || !value.trim()) {
    res.status(400);
    throw new Error(`${fieldLabel} مطلوب`);
  }

  return value.trim();
};

const normalizeOptionalText = (value, fieldLabel, res, maxLength = 1000) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  if (typeof value !== "string") {
    res.status(400);
    throw new Error(`${fieldLabel} غير صالح`);
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.length > maxLength) {
    res.status(400);
    throw new Error(`${fieldLabel} يجب ألا يزيد عن ${maxLength} حرف`);
  }

  return trimmed;
};

const normalizeOptionalHttpUrl = (value, fieldLabel, res) => {
  const normalizedValue = normalizeOptionalText(value, fieldLabel, res, 2000);
  if (!normalizedValue) return normalizedValue;

  try {
    const url = new URL(normalizedValue);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return normalizedValue;
    }
  } catch (_error) {}

  res.status(400);
  throw new Error(`${fieldLabel} غير صالح`);
};

const normalizeStoreLocations = (value, res) => {
  if (!Array.isArray(value)) {
    res.status(400);
    throw new Error("يجب أن تكون storeLocations قائمة");
  }

  return value.map((location, index) => {
    if (!location || typeof location !== "object" || Array.isArray(location)) {
      res.status(400);
      throw new Error(`بيانات موقع المتجر رقم ${index + 1} غير صالحة`);
    }

    return {
      name: normalizeRequiredText(
        location.name ?? location.storeName,
        `اسم المتجر رقم ${index + 1}`,
        res
      ),
      detailedLocation: normalizeRequiredText(
        location.detailedLocation ?? location.location ?? location.address,
        `العنوان التفصيلي للمتجر رقم ${index + 1}`,
        res
      ),
      mapLink: normalizeRequiredText(
        location.mapLink ?? location.mapUrl,
        `رابط الخريطة للمتجر رقم ${index + 1}`,
        res
      ),
    };
  });
};

const normalizeSocialMediaLinks = (value, res) => {
  if (!Array.isArray(value)) {
    res.status(400);
    throw new Error("يجب أن تكون socialMediaLinks قائمة");
  }

  return value.map((socialMedia, index) => {
    if (!socialMedia || typeof socialMedia !== "object" || Array.isArray(socialMedia)) {
      res.status(400);
      throw new Error(`بيانات رابط التواصل الاجتماعي رقم ${index + 1} غير صالحة`);
    }

    return {
      name: normalizeRequiredText(
        socialMedia.name ?? socialMedia.platform,
        `اسم منصة التواصل الاجتماعي رقم ${index + 1}`,
        res
      ),
      link: normalizeRequiredText(
        socialMedia.link ?? socialMedia.url,
        `رابط منصة التواصل الاجتماعي رقم ${index + 1}`,
        res
      ),
    };
  });
};

const normalizeGovernmentShippingFees = (value, res) => {
  if (value === undefined) {
    res.status(400);
    throw new Error("قائمة مصاريف الشحن حسب المحافظة مطلوبة");
  }

  if (!Array.isArray(value)) {
    res.status(400);
    throw new Error("يجب أن تكون قيمة governmentFees قائمة");
  }

  const seenGovernments = new Set();

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      res.status(400);
      throw new Error(`بيانات الشحن رقم ${index + 1} غير صالحة`);
    }

    const government = String(item.government ?? item.governorate ?? "").trim();
    if (!government) {
      res.status(400);
      throw new Error(`اسم المحافظة مطلوب في بيانات الشحن رقم ${index + 1}`);
    }

    const normalizedGovernment = government.toLowerCase();
    if (seenGovernments.has(normalizedGovernment)) {
      res.status(400);
      throw new Error(`تم تكرار المحافظة ${government}`);
    }
    seenGovernments.add(normalizedGovernment);

    return {
      government,
      shippingFees: parseNonNegativeNumber(
        item.shippingFees ?? item.shippingFee ?? item.fees ?? item.fee,
        `قيمة الشحن للمحافظة ${government}`,
        res
      ),
    };
  });
};

const upsertShippingSetting = (update) =>
  ShippingSetting.findOneAndUpdate(
    { key: "default" },
    {
      $set: update,
      $setOnInsert: { key: "default" },
    },
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true }
  );

const ensureObjectId = (value, fieldLabel, res) => {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    res.status(400);
    throw new Error(`تنسيق ${fieldLabel} غير صالح`);
  }

  return value;
};

const normalizeObjectIdList = (value, fieldLabel, res) => {
  if (value === undefined) return [];

  if (!Array.isArray(value)) {
    res.status(400);
    throw new Error(`يجب أن تكون قيمة ${fieldLabel} قائمة`);
  }

  const uniqueIds = [];
  const seen = new Set();

  value.forEach((item, index) => {
    const id = ensureObjectId(String(item), `${fieldLabel}[${index}]`, res);
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  });

  return uniqueIds;
};

const validateProductsBelongToCategory = async (productIds, categoryId, res) => {
  if (productIds.length === 0) return;

  const productsCount = await Product.countDocuments({
    _id: { $in: productIds },
    category: categoryId,
  });

  if (productsCount !== productIds.length) {
    res.status(400);
    throw new Error("يجب أن تكون كل المنتجات المحددة تابعة للفئة نفسها");
  }
};

const normalizeFilters = (filters, res) => {
  if (filters === undefined) return [];

  if (!Array.isArray(filters)) {
    res.status(400);
    throw new Error("يجب أن تكون قيمة filters قائمة");
  }

  return filters.map((filter, index) => {
    const title = typeof filter?.title === "string" ? filter.title.trim() : "";
    if (!title) {
      res.status(400);
      throw new Error(`عنوان عنصر الفلترة رقم ${index + 1} مطلوب`);
    }

    return {
      title,
      products: normalizeObjectIdList(filter.products, `filters[${index}].products`, res),
      isVisible: parseBoolean(filter.isVisible, true),
    };
  });
};

const buildEcommerceSettingCategories = async (
  activeOnly = false,
  database = (operation) => operation()
) => {
  const [categories, products, settings] = await Promise.all([
    database(() => Category.find().sort({ createdAt: 1 }).lean()),
    database(() =>
      Product.find()
        .select(ECOMMERCE_PRODUCT_FIELDS)
        .sort({ createdAt: -1 })
        .lean()
    ),
    database(() =>
      EcommerceSetting.find(activeOnly ? { showOnWebsite: true } : {}).lean()
    ),
  ]);

  const productsByCategory = products.reduce((groupedProducts, product) => {
    const categoryId = product.category.toString();
    if (!groupedProducts.has(categoryId)) groupedProducts.set(categoryId, []);
    groupedProducts.get(categoryId).push(product);
    return groupedProducts;
  }, new Map());
  const settingsByCategory = new Map(
    settings.map((setting) => [setting.category.toString(), setting])
  );

  return categories
    .filter((category) => !activeOnly || settingsByCategory.has(category._id.toString()))
    .map((category) => {
      const categoryId = category._id.toString();
      const setting = settingsByCategory.get(categoryId);
      const categoryProducts = (productsByCategory.get(categoryId) || []).map(
        withProductPriceAfterDiscount
      );
      const specificationFilters = buildCategorySpecificationFilters(
        category.specifications || [],
        categoryProducts
      );
      const categoryWithSpecificationFilters = {
        ...category,
        specifications: specificationFilters,
        filters: specificationFilters,
      };

      return {
        category: categoryWithSpecificationFilters,
        products: categoryProducts,
        setting: setting || {
          category: category._id,
          showOnWebsite: false,
          selectedProducts: [],
          filters: [],
        },
      };
    });
};

const getEcommerceSettingCategories = asyncHandler(async (req, res) => {
  res.json(await buildEcommerceSettingCategories());
});

const getActiveEcommerceSettingCategories = asyncHandler(async (req, res) => {
  const performance = createPublicPerformance(
    "GET /api/ecommerce-settings/categories/active"
  );
  const bounded =
    req.query.projection === "storefront" || req.query.productLimit !== undefined;
  if (!bounded) {
    res.set("Cache-Control", "private, no-store");
    const rawResponse = await buildEcommerceSettingCategories(
      true,
      (operation) => performance.database(operation)
    );
    const response = rawResponse.map((row) => {
      const categoryImageUrl = getEntityImageUrl(req, "category", row.category);
      return {
        ...row,
        category: {
          ...row.category,
          image: categoryImageUrl || null,
          imageUrl: categoryImageUrl || null,
        },
        products: row.products.map((product) => {
          const imageUrl = getEntityImageUrl(req, "product", product);
          return { ...product, image: imageUrl || null, imageUrl: imageUrl || null };
        }),
      };
    });
    return res.json(
      performance.finish(res, response, {
        categoryCount: response.length,
        productCount: response.reduce(
          (count, category) => count + category.products.length,
          0
        ),
      })
    );
  }

  const rawLimit = req.query.productLimit ?? "10";
  if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit.trim())) {
    res.status(400);
    throw new Error("قيمة productLimit غير صالحة");
  }
  const productLimit = Number(rawLimit);
  if (!Number.isSafeInteger(productLimit) || productLimit < 1 || productLimit > 50) {
    res.status(400);
    throw new Error("يجب أن تكون قيمة productLimit بين 1 و50");
  }
  const locale = req.query.locale || "ar";
  if (locale !== "ar" && locale !== "en") {
    res.status(400);
    throw new Error("قيمة locale غير صالحة");
  }
  const cacheKey = `active-categories:storefront:${locale}:${productLimit}:${getPublicApiOrigin(req)}`;
  const cached = cacheGet(cacheKey);
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  if (cached) {
    return res.json(
      performance.finish(
        res,
        cached,
        {
          categoryCount: cached.length,
          productCount: cached.reduce(
            (count, category) => count + category.products.length,
            0
          ),
        },
        true
      )
    );
  }
  const response = await loadBoundedActiveCategories({
    req,
    locale,
    limit: productLimit,
    database: (operation) => performance.database(operation),
  });
  cacheSet(cacheKey, response);
  return res.json(
    performance.finish(res, response, {
      categoryCount: response.length,
      productCount: response.reduce(
        (count, category) => count + category.products.length,
        0
      ),
    })
  );
});

const getEcommerceCategoryFilters = asyncHandler(async (req, res) => {
  const categoryId = ensureObjectId(req.params.categoryId, "معرّف الفئة", res);
  const [category, products, setting] = await Promise.all([
    Category.findById(categoryId).lean(),
    Product.find({ category: categoryId })
      .select(ECOMMERCE_PRODUCT_FIELDS)
      .sort({ createdAt: -1 })
      .lean(),
    EcommerceSetting.findOne({ category: categoryId }).lean(),
  ]);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  const specificationFilters = buildCategorySpecificationFilters(
    category.specifications || [],
    products
  );

  res.json(formatSpecificationFilterResponse(specificationFilters, setting?.filters));
});

const getProductsByActiveEcommerceCategory = asyncHandler(async (req, res) => {
  const categoryId = ensureObjectId(req.params.categoryId, "معرّف الفئة", res);
  const { page, limit, skip } = getPaginationParams(req.query);
  const specificationSearchFilters = parseSpecificationSearchFilters(req.query, res);
  const productSort = parseActiveCategoryProductSort(req.query, res);
  const [category, setting] = await Promise.all([
    Category.findById(categoryId).lean(),
    EcommerceSetting.findOne({ category: categoryId, showOnWebsite: true }).lean(),
  ]);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  if (!setting) {
    res.status(404);
    throw new Error("الفئة غير مفعلة في إعدادات التجارة الإلكترونية");
  }

  const displayedProductIds = setting.selectedProducts || [];
  const products =
    displayedProductIds.length > 0
      ? await Product.find({ _id: { $in: displayedProductIds }, category: categoryId })
          .select(ECOMMERCE_PRODUCT_FIELDS)
          .sort({ createdAt: -1 })
          .lean()
      : [];

  const filteredProducts =
    specificationSearchFilters.length > 0
      ? products.filter((product) =>
          productMatchesSpecificationSearchFilters(product, specificationSearchFilters)
        )
      : products;
  const sortedProducts = sortActiveCategoryProducts(
    filteredProducts.map(withProductPriceAfterDiscount),
    productSort
  );
  const totalItems = sortedProducts.length;
  const paginatedProducts = sortedProducts.slice(skip, skip + limit);

  res.json({
    success: true,
    products: paginatedProducts,
    pagination: buildPaginationMetadata({ page, limit, totalItems }),
  });
});

const searchActiveEcommerceProducts = asyncHandler(async (req, res) => {
  const searchTerm = normalizeSearchTerm(req.query.q ?? req.query.search, res);
  const { page, limit, skip } = getPaginationParams(req.query);

  const settings = await EcommerceSetting.find({ showOnWebsite: true })
    .select("selectedProducts")
    .lean();
  const productIds = [
    ...new Set(
      settings.flatMap((setting) =>
        normalizeObjectIdsToStrings(setting.selectedProducts || [])
      )
    ),
  ];

  if (productIds.length === 0) {
    return res.json({
      success: true,
      products: [],
      pagination: buildPaginationMetadata({ page, limit, totalItems: 0 }),
    });
  }

  const products = await Product.find({
    _id: { $in: productIds },
    name: { $regex: escapeRegex(searchTerm), $options: "i" },
  })
    .select(ECOMMERCE_PRODUCT_FIELDS)
    .lean();
  const sortedProducts = sortProductsByNameSearchRelevance(
    products.map(withProductPriceAfterDiscount),
    searchTerm
  );
  const totalItems = sortedProducts.length;
  const paginatedProducts = sortedProducts.slice(skip, skip + limit);

  res.json({
    success: true,
    products: paginatedProducts,
    pagination: buildPaginationMetadata({ page, limit, totalItems }),
  });
});

const getProductByActiveEcommerceCategory = asyncHandler(async (req, res) => {
  const categoryId = ensureObjectId(req.params.categoryId, "معرّف الفئة", res);
  const productId = ensureObjectId(req.params.productId, "معرّف المنتج", res);
  const [category, setting] = await Promise.all([
    Category.findById(categoryId).lean(),
    EcommerceSetting.findOne({ category: categoryId, showOnWebsite: true }).lean(),
  ]);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  if (!setting) {
    res.status(404);
    throw new Error("الفئة غير مفعلة في إعدادات التجارة الإلكترونية");
  }

  if (!normalizeObjectIdsToStrings(setting.selectedProducts).includes(productId)) {
    res.status(404);
    throw new Error("المنتج غير معروض داخل هذه الفئة");
  }

  const product = await Product.findOne({ _id: productId, category: categoryId })
    .select(ECOMMERCE_PRODUCT_FIELDS)
    .lean();

  if (!product) {
    res.status(404);
    throw new Error("المنتج غير موجود داخل هذه الفئة");
  }

  const specificationFilters = buildCategorySpecificationFilters(
    category.specifications || [],
    [product]
  );

  res.json({
    category: {
      ...category,
      specifications: specificationFilters,
      filters: specificationFilters,
    },
    product: withProductPriceAfterDiscount(product),
    setting,
  });
});

const getEcommerceSettings = asyncHandler(async (req, res) => {
  const settings = await populateSetting(
    EcommerceSetting.find().sort({ createdAt: 1 })
  ).lean();
  res.json(settings.map(withPricingForSetting));
});

const getStorefrontSettings = asyncHandler(async (req, res) => {
  const settings = await populateSetting(
    EcommerceSetting.find({ showOnWebsite: true }).sort({ createdAt: 1 })
  ).lean();

  const visibleSettings = settings.map((setting) => {
    const pricedSetting = withPricingForSetting(setting);
    return {
      ...pricedSetting,
      filters: pricedSetting.filters.filter((filter) => filter.isVisible),
    };
  });

  res.json(visibleSettings);
});

const formatHomePageCategories = async (req, categoryIds = [], database = (operation) => operation()) => {
  if (categoryIds.length === 0) return { categoryIds: [], categories: [] };
  const categories = await database(() =>
    Category.aggregate([
      { $match: { _id: { $in: categoryIds } } },
      {
        $project: {
          _id: 1,
          name: 1,
          hasImage: { $ne: [{ $ifNull: ["$image", ""] }, ""] },
        },
      },
    ])
  );
  const byId = new Map(categories.map((category) => [String(category._id), category]));
  const orderedCategories = categoryIds.flatMap((categoryId) => {
    const category = byId.get(String(categoryId));
    if (!category) return [];
    const imageUrl = category.hasImage
      ? getEntityImageAssetUrl(req, "category", category._id)
      : null;
    return [{ _id: category._id, name: category.name, image: imageUrl, imageUrl }];
  });

  return { categoryIds, categories: orderedCategories };
};

const getHomePageCategories = asyncHandler(async (req, res) => {
  const performance = createPublicPerformance(
    "GET /api/ecommerce-settings/home-page/categories"
  );
  const setting = await performance.database(() =>
    GeneralSetting.findOne({ key: "default" })
      .select("homePageCategoryIds")
      .lean()
  );
  const response = await formatHomePageCategories(
    req,
    setting?.homePageCategoryIds || [],
    (operation) => performance.database(operation)
  );
  res.set("Cache-Control", "private, no-cache");
  res.json(
    performance.finish(res, response, {
      categoryCount: response.categories.length,
      productCount: 0,
    })
  );
});

const updateHomePageCategories = asyncHandler(async (req, res) => {
  const categoryInput = req.body.categoryIds ?? req.body.homePageCategoryIds;
  if (categoryInput === undefined) {
    res.status(400);
    throw new Error("قائمة فئات الصفحة الرئيسية مطلوبة");
  }

  const categoryIds = normalizeObjectIdList(
    categoryInput,
    "categoryIds",
    res
  );
  const categoryCount =
    categoryIds.length > 0
      ? await Category.countDocuments({ _id: { $in: categoryIds } })
      : 0;

  if (categoryCount !== categoryIds.length) {
    res.status(400);
    throw new Error("واحدة أو أكثر من فئات الصفحة الرئيسية غير موجودة");
  }

  const setting = await GeneralSetting.findOneAndUpdate(
    { key: "default" },
    {
      $set: { homePageCategoryIds: categoryIds },
      $setOnInsert: { key: "default" },
    },
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true }
  ).select("homePageCategoryIds");

  clearPublicSeoCache();
  res.set("Cache-Control", "no-store");
  res.json(await formatHomePageCategories(req, setting.homePageCategoryIds || []));
});

const formatGeneralSettings = (generalSetting, websiteSetting) => {
  const general = generalSetting?.toObject
    ? generalSetting.toObject()
    : generalSetting || {
        mainLogo: null,
        mainColor: "#000000",
        storeLocations: [],
        socialMediaLinks: [],
        walletPhone: null,
        instapayLink: null,
        homePageCategoryIds: [],
      };

  return {
    ...general,
    currencyCode: websiteSetting?.currency || "EGP",
    freeShippingMinimumAmount: websiteSetting?.freeShippingMinimumAmount || 0,
  };
};

const getGeneralSettings = asyncHandler(async (req, res) => {
  const [generalSetting, websiteSetting] = await Promise.all([
    GeneralSetting.findOne({ key: "default" }).lean(),
    ShippingSetting.findOne({ key: "default" })
      .select("currency freeShippingMinimumAmount")
      .lean(),
  ]);

  res.json(formatGeneralSettings(generalSetting, websiteSetting));
});

const updateGeneralSettings = asyncHandler(async (req, res) => {
  const generalUpdate = {};
  const websiteUpdate = {};
  const mainLogo =
    req.body.mainLogo !== undefined
      ? req.body.mainLogo
      : req.body.logo !== undefined
        ? req.body.logo
        : req.body.logoImage;

  if (
    req.body.mainLogo !== undefined ||
    req.body.logo !== undefined ||
    req.body.logoImage !== undefined
  ) {
    if (mainLogo !== null && typeof mainLogo !== "string") {
      res.status(400);
      throw new Error("الشعار الرئيسي غير صالح");
    }
    generalUpdate.mainLogo = mainLogo;
  }

  if (req.body.mainColor !== undefined) {
    if (typeof req.body.mainColor !== "string") {
      res.status(400);
      throw new Error("اللون الرئيسي غير صالح");
    }
    generalUpdate.mainColor = req.body.mainColor.trim().toUpperCase();
  }

  if (req.body.storeLocations !== undefined) {
    generalUpdate.storeLocations = normalizeStoreLocations(req.body.storeLocations, res);
  }

  if (req.body.socialMediaLinks !== undefined) {
    generalUpdate.socialMediaLinks = normalizeSocialMediaLinks(req.body.socialMediaLinks, res);
  }

  if (req.body.walletPhone !== undefined) {
    generalUpdate.walletPhone = normalizeOptionalText(
      req.body.walletPhone,
      "رقم المحفظة",
      res,
      30
    );
  }

  if (req.body.instapayLink !== undefined) {
    generalUpdate.instapayLink = normalizeOptionalHttpUrl(
      req.body.instapayLink,
      "رابط انستاباي",
      res
    );
  }

  if (req.body.currencyCode !== undefined || req.body.currency !== undefined) {
    websiteUpdate.currency = normalizeCurrency(
      req.body.currencyCode ?? req.body.currency,
      res
    );
  }

  if (req.body.freeShippingMinimumAmount !== undefined) {
    websiteUpdate.freeShippingMinimumAmount = parseNonNegativeNumber(
      req.body.freeShippingMinimumAmount,
      "الحد الأدنى للشحن المجاني",
      res
    );
  }

  const generalSetting = await GeneralSetting.findOneAndUpdate(
    { key: "default" },
    {
      $set: generalUpdate,
      $setOnInsert: { key: "default" },
    },
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true }
  );
  const websiteSetting =
    Object.keys(websiteUpdate).length > 0
      ? await upsertShippingSetting(websiteUpdate)
      : await ShippingSetting.findOne({ key: "default" });

  clearPublicSeoCache();
  res.json(formatGeneralSettings(generalSetting, websiteSetting));
});

const getGovernmentShippingFees = asyncHandler(async (req, res) => {
  const setting = await ShippingSetting.findOne({ key: "default" })
    .select("governmentFees freeShippingMinimumAmount")
    .lean();

  res.json({
    governmentFees: setting?.governmentFees || [],
    freeShippingMinimumAmount: setting?.freeShippingMinimumAmount || 0,
  });
});

const updateGovernmentShippingFees = asyncHandler(async (req, res) => {
  const governmentFees = normalizeGovernmentShippingFees(
    req.body.governmentFees ?? req.body.governments ?? req.body.shippingFees,
    res
  );

  const setting = await upsertShippingSetting({ governmentFees });
  res.json(setting);
});

const updateFreeShippingMinimumAmount = asyncHandler(async (req, res) => {
  const amount = parseNonNegativeNumber(
    req.body.freeShippingMinimumAmount ?? req.body.minimumAmount ?? req.body.amount,
    "الحد الأدنى للشحن المجاني",
    res
  );

  const setting = await upsertShippingSetting({
    freeShippingMinimumAmount: amount,
  });
  res.json(setting);
});

const getWebsiteCurrency = asyncHandler(async (req, res) => {
  const setting = await ShippingSetting.findOne({ key: "default" }).select("currency").lean();

  res.json({ currency: setting?.currency || "EGP" });
});

const updateWebsiteCurrency = asyncHandler(async (req, res) => {
  const currency = normalizeCurrency(req.body.currency ?? req.body.currencyCode, res);
  const setting = await upsertShippingSetting({ currency });

  res.json({ currency: setting.currency });
});

const getEcommerceSettingByCategory = asyncHandler(async (req, res) => {
  const categoryId = ensureObjectId(req.params.categoryId, "معرّف الفئة", res);
  const setting = await populateSetting(
    EcommerceSetting.findOne({ category: categoryId })
  ).lean();

  if (!setting) {
    res.status(404);
    throw new Error("إعدادات الفئة غير موجودة");
  }

  res.json(withPricingForSetting(setting));
});

const upsertEcommerceSetting = asyncHandler(async (req, res) => {
  const categoryId = ensureObjectId(req.params.categoryId, "معرّف الفئة", res);
  const category = await Category.findById(categoryId);

  if (!category) {
    res.status(404);
    throw new Error("الفئة غير موجودة");
  }

  const selectedProductInput =
    req.body.productIds ?? req.body.selectedProducts ?? req.body.selectedProductIds;
  const selectedProducts = normalizeObjectIdList(selectedProductInput, "productIds", res);
  const filters = normalizeFilters(req.body.filters, res);
  const filterProductIds = filters.flatMap((filter) => filter.products);
  const allProductIds = [...new Set([...selectedProducts, ...filterProductIds])];

  await validateProductsBelongToCategory(allProductIds, categoryId, res);

  const setting = await EcommerceSetting.findOneAndUpdate(
    { category: categoryId },
    {
      category: categoryId,
      showOnWebsite: parseBoolean(req.body.showOnWebsite, false),
      selectedProducts,
      filters,
    },
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true }
  );

  await populateSettingDocument(setting);
  clearPublicSeoCache();
  res.json(withPricingForSetting(setting.toObject()));
});

const resetEcommerceSetting = asyncHandler(async (req, res) => {
  const categoryId = ensureObjectId(req.params.categoryId, "معرّف الفئة", res);
  const setting = await EcommerceSetting.findOneAndDelete({ category: categoryId });

  if (!setting) {
    res.status(404);
    throw new Error("إعدادات الفئة غير موجودة");
  }

  clearPublicSeoCache();
  res.json({ message: "E-commerce setting reset successfully" });
});

module.exports = {
  getEcommerceSettingCategories,
  getActiveEcommerceSettingCategories,
  getEcommerceCategoryFilters,
  getProductsByActiveEcommerceCategory,
  searchActiveEcommerceProducts,
  getProductByActiveEcommerceCategory,
  getEcommerceSettings,
  getStorefrontSettings,
  getHomePageCategories,
  updateHomePageCategories,
  getGeneralSettings,
  updateGeneralSettings,
  getGovernmentShippingFees,
  getWebsiteCurrency,
  updateWebsiteCurrency,
  updateGovernmentShippingFees,
  updateFreeShippingMinimumAmount,
  getEcommerceSettingByCategory,
  upsertEcommerceSetting,
  resetEcommerceSetting,
};
