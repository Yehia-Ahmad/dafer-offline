const Category = require("../models/category.model");
const EcommerceSetting = require("../models/ecommerceSetting.model");
const GeneralSetting = require("../models/generalSetting.model");
const WebsiteImage = require("../models/websiteImage.model");
const {
  hasLocalizedPublicValue,
  loadConfiguredHomeCatalog,
  serializeCategory,
  serializeProduct,
} = require("../services/publicCatalog.service");
const asyncHandler = require("../utils/asyncHandler");
const isBase64Image = require("../utils/isBase64Image");
const { createPublicPerformance } = require("../utils/publicPerformance");
const {
  LANGUAGES,
  absoluteApiUrl,
  cacheGet,
  cacheSet,
  getPublicApiOrigin,
  getWebsiteImageAssetUrl,
  sendBase64Image,
} = require("../utils/seo");

const DEVICES = new Set(["desktop", "mobile"]);
const DEFAULT_LOCALE = LANGUAGES.includes(process.env.DEFAULT_LOCALE)
  ? process.env.DEFAULT_LOCALE
  : "ar";
const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

const validateLocale = (value, res, fallback) => {
  const locale = value === undefined || value === "" ? fallback : value;
  if (!LANGUAGES.includes(locale)) {
    res.status(400);
    throw new Error("قيمة locale غير صالحة");
  }
  return locale;
};

const validateDevice = (value, res) => {
  if (!DEVICES.has(value)) {
    res.status(400);
    throw new Error("قيمة device غير صالحة");
  }
  return value;
};

const collectionSettings = (itemsKey, items, viewAllUrl = "") => ({
  layout: "grid",
  columns: { desktop: 5, tablet: 3, mobile: 2 },
  imageShape: "rounded",
  imageBorderRadius: 14,
  showCategoryName: true,
  viewAll: {
    enabled: Boolean(viewAllUrl),
    url: viewAllUrl,
    label: "",
  },
  [itemsKey]: items,
});

const loadPromotionSlides = async (req, database) => {
  const promotions = await database(() =>
    WebsiteImage.find({ isActive: true })
      .select("_id title createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .lean()
  );

  return promotions.map((promotion) => {
    const imageUrl = getWebsiteImageAssetUrl(req, promotion._id);
    return {
      id: String(promotion._id),
      desktopImage: imageUrl,
      mobileImage: imageUrl,
      altText: promotion.title || "",
      title: promotion.title || "",
      subtitle: "",
      slideUrl: "",
      openInNewTab: false,
      button: { enabled: false },
    };
  });
};

const buildHomeSections = (req, locale, catalog, slides) => {
  const serializedCategories = catalog.categories.map((category) => {
    const { _id: _legacyId, ...serialized } = serializeCategory(
      req,
      category,
      locale
    );
    return serialized;
  });
  const sections = [];

  if (slides.length > 0) {
    sections.push({
      id: "legacy-promotions",
      type: "offers_slider",
      title: "",
      subtitle: "",
      fullWidth: true,
      backgroundColor: "",
      settings: {
        slides,
        autoplay: false,
        autoplayDelay: 5000,
        loop: true,
        pauseOnHover: true,
        showNavigation: true,
        showPagination: true,
        imageFit: "cover",
      },
    });
  }

  if (serializedCategories.length > 0) {
    sections.push({
      id: "legacy-categories",
      type: "categories",
      title: "",
      subtitle: "",
      fullWidth: false,
      backgroundColor: "",
      settings: collectionSettings("categories", serializedCategories),
    });
  }

  serializedCategories.forEach((category) => {
    const rawProducts = catalog.productsByCategory.get(category.id) || [];
    const products = rawProducts.map((product) => {
      const { _id: _legacyId, category: _legacyCategory, ...serialized } =
        serializeProduct(req, product, locale, category);
      return serialized;
    });
    if (products.length === 0) return;

    sections.push({
      id: `legacy-products-${category.id}`,
      type: "products",
      title: category.name,
      subtitle: "",
      fullWidth: false,
      backgroundColor: "",
      settings: collectionSettings(
        "products",
        products,
        category.slug ? `/${locale}/categories/${category.slug}` : ""
      ),
    });
  });

  return sections;
};

const countHomeItems = (sections) => ({
  categoryCount:
    sections.find((section) => section.type === "categories")?.settings.categories
      .length || 0,
  productCount: sections
    .filter((section) => section.type === "products")
    .reduce((count, section) => count + section.settings.products.length, 0),
});

const getPublicHomePage = asyncHandler(async (req, res) => {
  const locale = validateLocale(req.query.locale, res);
  const device = validateDevice(req.query.device, res);
  const performance = createPublicPerformance("GET /api/public/home-page");
  const cacheKey = `public-home:${locale}:${device}:${getPublicApiOrigin(req)}`;
  const cached = cacheGet(cacheKey);
  res.set("Cache-Control", PUBLIC_CACHE_CONTROL);
  if (cached) {
    const counts = countHomeItems(cached.data.sections);
    return res.json(performance.finish(res, cached, counts, true));
  }

  let catalog;
  let promotionResult;
  try {
    [catalog, promotionResult] = await Promise.all([
      loadConfiguredHomeCatalog({
        locale,
        device,
        database: (operation) => performance.database(operation),
      }),
      loadPromotionSlides(req, (operation) => performance.database(operation)).then(
        (slides) => ({ slides, failed: false }),
        () => ({ slides: [], failed: true })
      ),
    ]);
  } catch (_error) {
    const error = new Error("تعذر تحميل الصفحة الرئيسية");
    error.statusCode = 500;
    throw error;
  }
  const sections = buildHomeSections(req, locale, catalog, promotionResult.slides);
  const issues = [];
  if (catalog.productIssue) {
    issues.push({ region: "products", code: "SECTION_UNAVAILABLE" });
  }
  if (promotionResult.failed) {
    issues.push({ region: "promotions", code: "SECTION_UNAVAILABLE" });
  }
  const response = {
    success: true,
    data: {
      sections,
      ...(issues.length > 0 ? { issues } : {}),
    },
  };
  if (issues.length === 0) cacheSet(cacheKey, response);
  return res.json(performance.finish(res, response, countHomeItems(sections)));
});

const getHeader = asyncHandler(async (req, res) => {
  const locale = validateLocale(req.query.locale, res, DEFAULT_LOCALE);
  const performance = createPublicPerformance("GET /api/header");
  const cacheKey = `public-header:${locale}:${getPublicApiOrigin(req)}`;
  const cached = cacheGet(cacheKey);
  res.set("Cache-Control", PUBLIC_CACHE_CONTROL);
  if (cached) {
    return res.json(
      performance.finish(
        res,
        cached,
        { categoryCount: cached.data.navigation.length, productCount: 0 },
        true
      )
    );
  }

  let generalSetting;
  let settings;
  try {
    [generalSetting, settings] = await Promise.all([
      performance.database(() =>
        GeneralSetting.findOne({ key: "default" }).select("mainLogo").lean()
      ),
      performance.database(() =>
        EcommerceSetting.find({ showOnWebsite: true })
          .select("category")
          .sort({ createdAt: 1, _id: 1 })
          .lean()
      ),
    ]);
  } catch (_error) {
    const error = new Error("تعذر تحميل بيانات الترويسة");
    error.statusCode = 500;
    throw error;
  }
  const categoryIds = settings.map((setting) => setting.category);
  let categories;
  try {
    categories =
      categoryIds.length > 0
        ? await performance.database(() =>
            Category.find({ _id: { $in: categoryIds } })
              .select(
                "_id name translations.ar.name translations.ar.slug translations.en.name translations.en.slug slugAliases"
              )
              .lean()
          )
        : [];
  } catch (_error) {
    const error = new Error("تعذر تحميل بيانات الترويسة");
    error.statusCode = 500;
    throw error;
  }
  const categoriesById = new Map(
    categories.map((category) => [String(category._id), category])
  );
  const navigation = categoryIds.flatMap((categoryId) => {
    const category = categoriesById.get(String(categoryId));
    if (!category) return [];
    const shapedCategory = {
      ...category,
      localized: category.translations?.[locale],
    };
    if (!hasLocalizedPublicValue(shapedCategory, locale)) return [];
    const localized = category.translations?.[locale] || {};
    const label = localized.name || category.name;
    const slug = localized.slug || (locale === "ar" ? String(category._id) : "");
    if (!label || !slug) return [];
    return [
      {
        id: `category-${category._id}`,
        label,
        slug,
        url: `/${locale}/categories/${slug}`,
        external: false,
        openInNewTab: false,
        children: [],
      },
    ];
  });
  const mainLogo = generalSetting?.mainLogo || "";
  const logoUrl = isBase64Image(mainLogo)
    ? absoluteApiUrl(req, "/api/header/logo")
    : /^https?:\/\//i.test(mainLogo)
      ? mainLogo
      : "";
  const response = {
    success: true,
    data: {
      settings: {
        isEnabled: true,
        isSticky: true,
        showSearch: true,
        showCart: true,
        showLanguageSwitcher: true,
        showMobileMenu: true,
        showTopBar: false,
        logoUrl,
        mobileLogoUrl: logoUrl,
        logoAltText: "",
        topBar: {},
        contact: {},
      },
      navigation,
      actions: [],
    },
  };
  cacheSet(cacheKey, response);
  return res.json(
    performance.finish(res, response, {
      categoryCount: navigation.length,
      productCount: 0,
    })
  );
});

const getHeaderLogo = asyncHandler(async (_req, res) => {
  const setting = await GeneralSetting.findOne({ key: "default" })
    .select("mainLogo")
    .lean();
  sendBase64Image(
    setting?.mainLogo ? { image: setting.mainLogo } : null,
    res,
    "الشعار غير موجود"
  );
});

module.exports = {
  getHeader,
  getHeaderLogo,
  getPublicHomePage,
  _private: {
    buildHomeSections,
    countHomeItems,
    loadPromotionSlides,
    validateDevice,
    validateLocale,
  },
};
