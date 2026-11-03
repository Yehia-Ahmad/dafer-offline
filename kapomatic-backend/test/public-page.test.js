process.env.NODE_ENV = "test";
process.env.DEFAULT_LOCALE = "ar";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Category = require("../src/models/category.model");
const EcommerceSetting = require("../src/models/ecommerceSetting.model");
const GeneralSetting = require("../src/models/generalSetting.model");
const WebsiteImage = require("../src/models/websiteImage.model");
const {
  getHeader,
  getPublicHomePage,
} = require("../src/controllers/publicPage.controller");
const errorHandler = require("../src/middlewares/error.middleware");
const publicPageRouter = require("../src/routes/publicPage.routes");
const app = require("../src/app");
const { clearPublicSeoCache } = require("../src/utils/seo");

const CATEGORY_ONE = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf1234");
const CATEGORY_TWO = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf5678");

const chain = (value) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  lean() {
    return value instanceof Promise ? value : Promise.resolve(value);
  },
});

const request = (query = {}) => ({
  query,
  protocol: "https",
  originalUrl: "/api/public/home-page",
  get(name) {
    return name.toLowerCase() === "host" ? "api.example.test" : undefined;
  },
});

const invoke = (handler, req) =>
  new Promise((resolve, reject) => {
    const headers = {};
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        headers[name.toLowerCase()] = value;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, headers, body });
        return this;
      },
    };
    handler(req, res, (error) => {
      if (!error) return reject(new Error("next called without an error"));
      return errorHandler(error, req, res, reject);
    });
  });

const category = (id, arName, enName) => ({
  _id: id,
  name: arName,
  localized: {
    name: arName,
    description: `${arName} description`,
    shortDescription: arName,
    slug: `${String(id)}-ar`,
    imageAlt: `${arName} image`,
  },
  slugAr: `${String(id)}-ar`,
  slugEn: `${String(id)}-en`,
  slugAliases: [{ language: "ar", slug: `${String(id)}-old` }],
  hasImage: true,
  enName,
});

const product = (index, categoryId, locale = "ar") => ({
  _id: new mongoose.Types.ObjectId(
    `67b0b7b5a8c197aa0adf${index.toString(16).padStart(4, "0")}`
  ),
  category: categoryId,
  name: `منتج ${index}`,
  localized: {
    name: locale === "en" ? `Product ${index}` : `منتج ${index}`,
    description: `Description ${index}`,
    shortDescription: `Short ${index}`,
    slug: `product-${index}`,
    imageAlt: `Product ${index} image`,
  },
  slugAr: `منتج-${index}`,
  slugEn: `product-${index}`,
  slugAliases: [],
  code: `P-${index}`,
  retailPrice: 100 + index,
  discountPercentage: 10,
  inventoryCount: index,
  hasImage: true,
});

const withHomeMocks = async (
  operation,
  {
    configuredIds = [CATEGORY_ONE, CATEGORY_TWO],
    categories,
    productRows,
    promotions = [],
    promotionError,
  } = {}
) => {
  clearPublicSeoCache();
  const originals = {
    generalFindOne: GeneralSetting.findOne,
    ecommerceFind: EcommerceSetting.find,
    ecommerceAggregate: EcommerceSetting.aggregate,
    categoryAggregate: Category.aggregate,
    websiteFind: WebsiteImage.find,
  };
  const calls = { total: 0, ecommerceAggregate: 0, pipelines: [] };
  const rawCategories =
    categories || [category(CATEGORY_ONE, "زيوت", "Oils"), category(CATEGORY_TWO, "فلاتر", "Filters")];
  const rawRows = productRows || Array.from({ length: 12 }, (_, index) => ({
    category: CATEGORY_ONE,
    productOrder: index,
    product: product(index + 1, CATEGORY_ONE),
  }));

  GeneralSetting.findOne = () => {
    calls.total += 1;
    return chain({ homePageCategoryIds: configuredIds });
  };
  EcommerceSetting.find = () => {
    calls.total += 1;
    return chain(
      configuredIds.map((id) => ({ category: id, selectedProducts: rawRows.map((row) => row.product._id) }))
    );
  };
  EcommerceSetting.aggregate = async (pipeline) => {
    calls.total += 1;
    calls.ecommerceAggregate += 1;
    calls.pipelines.push(pipeline);
    const limit = pipeline[1].$project.selectedProducts.$slice[1];
    return rawRows.filter((row) => configuredIds.some((id) => String(id) === String(row.category))).slice(0, limit);
  };
  Category.aggregate = async () => {
    calls.total += 1;
    return rawCategories;
  };
  WebsiteImage.find = () => {
    calls.total += 1;
    return chain(promotionError ? Promise.reject(promotionError) : promotions);
  };

  try {
    return await operation(calls);
  } finally {
    GeneralSetting.findOne = originals.generalFindOne;
    EcommerceSetting.find = originals.ecommerceFind;
    EcommerceSetting.aggregate = originals.ecommerceAggregate;
    Category.aggregate = originals.categoryAggregate;
    WebsiteImage.find = originals.websiteFind;
    clearPublicSeoCache();
  }
};

test("returns the exact dynamic Home envelope with localized URL-only cards in configured order", async () =>
  withHomeMocks(async (calls) => {
    const response = await invoke(
      getPublicHomePage,
      request({ locale: "ar", device: "desktop" })
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.data.sections.map((section) => section.type), [
      "categories",
      "products",
    ]);
    const categories = response.body.data.sections[0].settings.categories;
    assert.deepEqual(categories.map((item) => item.name), ["زيوت", "فلاتر"]);
    assert.match(categories[0].imageUrl, /\/api\/public\/images\/categories\//);
    assert.equal(JSON.stringify(response.body).includes("base64"), false);
    assert.equal(JSON.stringify(response.body).includes("purchasePrice"), false);
    assert.equal(calls.total, 5);
    assert.equal(calls.ecommerceAggregate, 1);
  }));

test("applies desktop and mobile limits before the Product lookup", async () => {
  await withHomeMocks(async () => {
    const desktop = await invoke(
      getPublicHomePage,
      request({ locale: "ar", device: "desktop" })
    );
    assert.equal(desktop.body.data.sections[1].settings.products.length, 10);
  });
  await withHomeMocks(async (calls) => {
    const mobile = await invoke(
      getPublicHomePage,
      request({ locale: "ar", device: "mobile" })
    );
    assert.equal(mobile.body.data.sections[1].settings.products.length, 6);
    assert.deepEqual(
      calls.pipelines[0][1].$project.selectedProducts.$slice,
      [{ $ifNull: ["$selectedProducts", []] }, 6]
    );
    assert.equal(calls.pipelines[0][1].$project.selectedProducts.$slice[1], 6);
    assert.ok(calls.pipelines[0].find((stage) => stage.$lookup));
  });
});

test("returns English localization and omits categories missing an English translation", async () =>
  withHomeMocks(
    async () => {
      const response = await invoke(
        getPublicHomePage,
        request({ locale: "en", device: "desktop" })
      );
      const categories = response.body.data.sections[0].settings.categories;
      assert.deepEqual(categories.map((item) => item.name), ["Oils"]);
      assert.equal(categories[0].slug, `${CATEGORY_ONE}-en`);
    },
    {
      categories: [
        {
          ...category(CATEGORY_ONE, "زيوت", "Oils"),
          localized: { name: "Oils", slug: `${CATEGORY_ONE}-en`, imageAlt: "Oils" },
        },
        { ...category(CATEGORY_TWO, "فلاتر", ""), localized: {} },
      ],
      productRows: [],
    }
  ));

test("returns an empty Home and validates locale/device before database work", async () => {
  await withHomeMocks(async () => {
    const empty = await invoke(
      getPublicHomePage,
      request({ locale: "ar", device: "desktop" })
    );
    assert.deepEqual(empty.body, { success: true, data: { sections: [] } });
  }, { configuredIds: [], categories: [], productRows: [] });

  await withHomeMocks(async (calls) => {
    const invalidLocale = await invoke(
      getPublicHomePage,
      request({ locale: "fr", device: "desktop" })
    );
    const invalidDevice = await invoke(
      getPublicHomePage,
      request({ locale: "ar", device: "tablet" })
    );
    assert.equal(invalidLocale.statusCode, 400);
    assert.equal(invalidDevice.statusCode, 400);
    assert.equal(calls.total, 0);
    assert.equal(invalidLocale.headers["cache-control"], "no-store");
  });
});

test("keeps valid Home sections when optional promotions fail and exposes only a safe issue", async () =>
  withHomeMocks(
    async () => {
      const response = await invoke(
        getPublicHomePage,
        request({ locale: "ar", device: "desktop" })
      );
      assert.ok(response.body.data.sections.length > 0);
      assert.deepEqual(response.body.data.issues, [
        { region: "promotions", code: "SECTION_UNAVAILABLE" },
      ]);
      assert.equal(JSON.stringify(response.body).includes("credentials"), false);
    },
    { promotionError: new Error("mongodb credentials are secret") }
  ));

test("Header localizes projected active categories and returns an empty navigation", async () => {
  clearPublicSeoCache();
  const originals = {
    generalFindOne: GeneralSetting.findOne,
    ecommerceFind: EcommerceSetting.find,
    categoryFind: Category.find,
  };
  let categoryFindCalls = 0;
  GeneralSetting.findOne = () => chain({ mainLogo: "data:image/png;base64,AAAA" });
  EcommerceSetting.find = () => chain([{ category: CATEGORY_ONE }]);
  Category.find = () => {
    categoryFindCalls += 1;
    return chain([
      {
        _id: CATEGORY_ONE,
        name: "زيوت",
        translations: {
          ar: { name: "زيوت", slug: "زيوت" },
          en: { name: "Oils", slug: "oils" },
        },
      },
    ]);
  };
  try {
    const english = await invoke(getHeader, request({ locale: "en" }));
    assert.equal(english.body.data.navigation[0].label, "Oils");
    assert.equal(english.body.data.navigation[0].url, "/en/categories/oils");
    assert.match(english.body.data.settings.logoUrl, /\/api\/header\/logo$/);
    assert.equal(JSON.stringify(english.body).includes("base64"), false);

    clearPublicSeoCache();
    const defaultLocale = await invoke(getHeader, request());
    assert.equal(defaultLocale.body.data.navigation[0].url, "/ar/categories/زيوت");

    clearPublicSeoCache();
    EcommerceSetting.find = () => chain([]);
    const empty = await invoke(getHeader, request({ locale: "ar" }));
    assert.deepEqual(empty.body.data.navigation, []);
    const invalid = await invoke(getHeader, request({ locale: "fr" }));
    assert.equal(invalid.statusCode, 400);
    assert.equal(categoryFindCalls, 2);
  } finally {
    GeneralSetting.findOne = originals.generalFindOne;
    EcommerceSetting.find = originals.ecommerceFind;
    Category.find = originals.categoryFind;
    clearPublicSeoCache();
  }
});

test("registers Home and Header without authentication middleware", () => {
  const home = publicPageRouter.stack.find((layer) => layer.route?.path === "/public/home-page");
  const header = publicPageRouter.stack.find((layer) => layer.route?.path === "/header");
  assert.ok(home);
  assert.ok(header);
  assert.equal(home.route.stack.length, 1);
  assert.equal(header.route.stack.length, 1);
});

test("keeps Express ETags enabled for conditional public requests", () => {
  assert.equal(app.get("etag"), "weak");
});
