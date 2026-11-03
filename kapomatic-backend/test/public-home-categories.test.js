const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Category = require("../src/models/category.model");
const EcommerceSetting = require("../src/models/ecommerceSetting.model");
const GeneralSetting = require("../src/models/generalSetting.model");
const Product = require("../src/models/product.model");
const {
  getHomeCategories,
  _private: {
    buildHomeProductCountsPipeline,
    getHomeCategoriesLimit,
    serializeHomeCategory,
  },
} = require("../src/controllers/publicSeo.controller");
const errorHandler = require("../src/middlewares/error.middleware");
const publicRouter = require("../src/routes/publicSeo.routes");

const CATEGORY_ID = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf1234");
const SECOND_CATEGORY_ID = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf5678");
const THIRD_CATEGORY_ID = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf9012");
const PRODUCT_ID = new mongoose.Types.ObjectId("67b0b7b5a8c197aa0adf1234");
const WRONG_CATEGORY_PRODUCT_ID = new mongoose.Types.ObjectId(
  "67b0b7b5a8c197aa0adf5678"
);
const UNSELECTED_PRODUCT_ID = new mongoose.Types.ObjectId(
  "67b0b7b5a8c197aa0adf9012"
);

const BASE_CATEGORY = {
  _id: CATEGORY_ID,
  name: "قطع غيار ناقل الحركة",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  translations: {
    ar: {
      name: "قطع غيار ناقل الحركة",
      slug: "قطع-غيار-ناقل-الحركة",
      imageAlt: "صورة قطع غيار ناقل الحركة",
    },
    en: {
      name: "Transmission Parts",
      slug: "transmission-parts",
      imageAlt: "Transmission parts image",
    },
  },
  image: "data:image/png;base64,iVBORw0KGgo=",
};

const makeCategory = (id, name, createdAt) => ({
  ...BASE_CATEGORY,
  _id: id,
  name,
  createdAt: new Date(createdAt),
  translations: {
    ar: { name, slug: `${String(id)}-ar` },
    en: { name: `${name} EN`, slug: `${String(id)}-en` },
  },
});

const matchesAnyId = (id, ids = []) =>
  ids.some((candidate) => String(candidate) === String(id));

const queryResult = (value) => ({
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

const invokeHomeCategories = async ({
  language = "ar",
  limit,
  generalSetting = { homePageCategoryIds: [CATEGORY_ID] },
  categories = [BASE_CATEGORY],
  settings = [
    {
      category: CATEGORY_ID,
      showOnWebsite: true,
      selectedProducts: [PRODUCT_ID],
    },
  ],
  products = [{ _id: PRODUCT_ID, category: CATEGORY_ID }],
  databaseError,
} = {}) => {
  const originals = {
    categoryFind: Category.find,
    ecommerceFind: EcommerceSetting.find,
    generalFindOne: GeneralSetting.findOne,
    productAggregate: Product.aggregate,
    productFind: Product.find,
  };
  const calls = {
    categoryFind: 0,
    ecommerceFind: 0,
    generalFindOne: 0,
    productAggregate: 0,
    productFind: 0,
  };

  GeneralSetting.findOne = (query) => {
    calls.generalFindOne += 1;
    calls.generalQuery = query;
    return queryResult(databaseError ? Promise.reject(databaseError) : generalSetting);
  };
  EcommerceSetting.find = (query) => {
    calls.ecommerceFind += 1;
    calls.ecommerceQuery = query;
    return queryResult(
      settings.filter(
        (setting) => !query.showOnWebsite || setting.showOnWebsite === true
      )
    );
  };
  Category.find = (query) => {
    calls.categoryFind += 1;
    calls.categoryQuery = query;
    const matched = categories
      .filter((category) => matchesAnyId(category._id, query._id.$in))
      .sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
          String(left._id).localeCompare(String(right._id))
      );
    return queryResult(matched);
  };
  Product.aggregate = async (pipeline) => {
    calls.productAggregate += 1;
    calls.productPipeline = pipeline;
    const match = pipeline[0].$match;
    const counts = new Map();
    products
      .filter(
        (product) =>
          matchesAnyId(product._id, match._id.$in) &&
          matchesAnyId(product.category, match.category.$in)
      )
      .forEach((product) => {
        const key = String(product.category);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    return [...counts].map(([id, count]) => ({
      _id: new mongoose.Types.ObjectId(id),
      count,
    }));
  };
  Product.find = () => {
    calls.productFind += 1;
    throw new Error("Unexpected Product.find call");
  };

  const req = {
    params: { language },
    query: limit === undefined ? {} : { limit },
    protocol: "https",
    get(header) {
      return header.toLowerCase() === "host" ? "api.example.test" : undefined;
    },
  };

  try {
    const response = await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ statusCode: this.statusCode, body });
          return this;
        },
      };

      getHomeCategories(req, res, (error) => {
        if (!error) return reject(new Error("Endpoint called next without an error"));
        return errorHandler(error, req, res, reject);
      });
    });

    return { ...response, calls };
  } finally {
    Category.find = originals.categoryFind;
    EcommerceSetting.find = originals.ecommerceFind;
    GeneralSetting.findOne = originals.generalFindOne;
    Product.aggregate = originals.productAggregate;
    Product.find = originals.productFind;
  }
};

test("returns a legacy Arabic Category without optional visibility or translation fields", async () => {
  const legacyCategory = {
    _id: CATEGORY_ID,
    name: "فلاتر",
    image: BASE_CATEGORY.image,
    createdAt: BASE_CATEGORY.createdAt,
  };
  const { statusCode, body } = await invokeHomeCategories({
    categories: [legacyCategory],
  });

  assert.equal(statusCode, 200);
  assert.equal(body.data.categories[0].name, "فلاتر");
  assert.equal(body.data.categories[0].slug, String(CATEGORY_ID));
  assert.equal(body.data.categories[0].localizedSlugs.ar, String(CATEGORY_ID));
});

test("uses the established showOnWebsite policy and excludes inactive Categories", async () => {
  const inactive = makeCategory(
    SECOND_CATEGORY_ID,
    "Inactive",
    "2024-01-02T00:00:00.000Z"
  );
  const { body, calls } = await invokeHomeCategories({
    generalSetting: { homePageCategoryIds: [] },
    categories: [BASE_CATEGORY, inactive],
    settings: [
      { category: CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
      { category: SECOND_CATEGORY_ID, showOnWebsite: false, selectedProducts: [] },
    ],
  });

  assert.deepEqual(body.data.categories.map((category) => category.id), [
    String(CATEGORY_ID),
  ]);
  assert.deepEqual(calls.ecommerceQuery, { showOnWebsite: true });
});

test("does not return a hard-deleted Category referenced by a dangling setting", async () => {
  const { body } = await invokeHomeCategories({
    generalSetting: { homePageCategoryIds: [] },
    categories: [BASE_CATEGORY],
    settings: [
      { category: CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
      { category: SECOND_CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
    ],
  });

  assert.deepEqual(body.data.categories.map((category) => category.id), [
    String(CATEGORY_ID),
  ]);
});

test("falls back to active Categories in established creation order without Home configuration", async () => {
  const older = makeCategory(
    SECOND_CATEGORY_ID,
    "Older",
    "2023-01-01T00:00:00.000Z"
  );
  const { body } = await invokeHomeCategories({
    generalSetting: null,
    categories: [BASE_CATEGORY, older],
    settings: [
      { category: CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
      { category: SECOND_CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
    ],
  });

  assert.deepEqual(body.data.categories.map((category) => category.id), [
    String(SECOND_CATEGORY_ID),
    String(CATEGORY_ID),
  ]);
});

test("respects configured Home Category selection and configured order", async () => {
  const second = makeCategory(
    SECOND_CATEGORY_ID,
    "Oils",
    "2024-01-02T00:00:00.000Z"
  );
  const { body } = await invokeHomeCategories({
    generalSetting: { homePageCategoryIds: [SECOND_CATEGORY_ID, CATEGORY_ID] },
    categories: [BASE_CATEGORY, second],
    settings: [
      { category: CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
      { category: SECOND_CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
    ],
  });

  assert.deepEqual(body.data.categories.map((category) => category.id), [
    String(SECOND_CATEGORY_ID),
    String(CATEGORY_ID),
  ]);
});

test("returns a Category with zero public Products", async () => {
  const { body, calls } = await invokeHomeCategories({
    settings: [
      { category: CATEGORY_ID, showOnWebsite: true, selectedProducts: [] },
    ],
    products: [],
  });

  assert.equal(body.data.categories[0].productsCount, 0);
  assert.equal(calls.productAggregate, 0);
});

test("counts only selected Products using the ObjectId category relationship", async () => {
  const { body, calls } = await invokeHomeCategories({
    settings: [
      {
        category: CATEGORY_ID,
        showOnWebsite: true,
        selectedProducts: [PRODUCT_ID, WRONG_CATEGORY_PRODUCT_ID],
      },
    ],
    products: [
      { _id: PRODUCT_ID, category: CATEGORY_ID },
      { _id: WRONG_CATEGORY_PRODUCT_ID, category: SECOND_CATEGORY_ID },
      { _id: UNSELECTED_PRODUCT_ID, category: CATEGORY_ID },
    ],
  });

  assert.equal(body.data.categories[0].productsCount, 1);
  assert.equal(calls.productPipeline[0].$match.category.$in[0] instanceof mongoose.Types.ObjectId, true);
  assert.equal(calls.productPipeline[0].$match._id.$in[0] instanceof mongoose.Types.ObjectId, true);
  assert.deepEqual(calls.productPipeline[1], {
    $group: { _id: "$category", count: { $sum: 1 } },
  });
});

test("returns Arabic and English localizations and preserves stored slugs", async () => {
  const arabic = await invokeHomeCategories({ language: "ar" });
  const english = await invokeHomeCategories({ language: "en" });

  assert.equal(arabic.body.data.categories[0].name, "قطع غيار ناقل الحركة");
  assert.equal(arabic.body.data.categories[0].slug, "قطع-غيار-ناقل-الحركة");
  assert.equal(english.body.data.categories[0].name, "Transmission Parts");
  assert.equal(english.body.data.categories[0].slug, "transmission-parts");
  assert.deepEqual(english.body.data.categories[0].localizedSlugs, {
    ar: "قطع-غيار-ناقل-الحركة",
    en: "transmission-parts",
  });
});

test("uses the existing no-English-fallback policy when English translation is absent", async () => {
  const legacyCategory = {
    _id: CATEGORY_ID,
    name: "فلاتر",
    createdAt: BASE_CATEGORY.createdAt,
  };
  const { body } = await invokeHomeCategories({
    language: "en",
    categories: [legacyCategory],
  });

  assert.deepEqual(body.data.categories, []);
});

test("maps base64 and absolute images without exposing invalid paths", () => {
  const req = { protocol: "https", get: () => "api.example.test" };
  const base64Image = serializeHomeCategory(req, BASE_CATEGORY, "en");
  const absoluteImage = serializeHomeCategory(
    req,
    { ...BASE_CATEGORY, image: "https://cdn.example.test/category.webp" },
    "en"
  );
  const invalidImage = serializeHomeCategory(
    req,
    { ...BASE_CATEGORY, image: "/srv/private/image.png" },
    "ar"
  );

  assert.equal(
    base64Image.image.url,
    `https://api.kapomatic.com/api/public/images/categories/${CATEGORY_ID}`
  );
  assert.equal(base64Image.image.alt, "Transmission parts image");
  assert.equal(absoluteImage.image.url, "https://cdn.example.test/category.webp");
  assert.equal(invalidImage.image, null);
});

test("applies limit after configured ordering", async () => {
  const second = makeCategory(
    SECOND_CATEGORY_ID,
    "Second",
    "2024-01-02T00:00:00.000Z"
  );
  const third = makeCategory(
    THIRD_CATEGORY_ID,
    "Third",
    "2024-01-03T00:00:00.000Z"
  );
  const settings = [BASE_CATEGORY, second, third].map((category) => ({
    category: category._id,
    showOnWebsite: true,
    selectedProducts: [],
  }));
  const { body } = await invokeHomeCategories({
    limit: "2",
    generalSetting: {
      homePageCategoryIds: [THIRD_CATEGORY_ID, CATEGORY_ID, SECOND_CATEGORY_ID],
    },
    categories: [BASE_CATEGORY, second, third],
    settings,
  });

  assert.deepEqual(body.data.categories.map((category) => category.id), [
    String(THIRD_CATEGORY_ID),
    String(CATEGORY_ID),
  ]);
});

test("uses one grouped Product aggregation and no N+1 Product.find queries", async () => {
  const { calls } = await invokeHomeCategories();

  assert.equal(calls.productAggregate, 1);
  assert.equal(calls.productFind, 0);
});

test("validates and clamps limit values", async () => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
  assert.equal(getHomeCategoriesLimit(undefined, res), 12);
  assert.equal(getHomeCategoriesLimit("51", res), 50);
  assert.throws(() => getHomeCategoriesLimit("0", res));
  assert.equal(res.statusCode, 400);

  const invalid = await invokeHomeCategories({ limit: "twelve" });
  assert.equal(invalid.statusCode, 400);
});

test("returns database failures as errors instead of successful empty arrays", async () => {
  const { statusCode, body } = await invokeHomeCategories({
    databaseError: new Error("mongodb host and credentials are secret"),
  });

  assert.equal(statusCode, 500);
  assert.deepEqual(body, { message: "تعذر تحميل فئات الصفحة الرئيسية" });
});

test("rejects unsupported languages before querying the database", async () => {
  const { statusCode, body, calls } = await invokeHomeCategories({ language: "fr" });

  assert.equal(statusCode, 400);
  assert.deepEqual(body, { message: "قيمة اللغة غير صالحة" });
  assert.equal(calls.generalFindOne, 0);
  assert.equal(calls.ecommerceFind, 0);
});

test("builds a grouped count over Product.category and selected ObjectIds", () => {
  const pipeline = buildHomeProductCountsPipeline([CATEGORY_ID], [PRODUCT_ID]);

  assert.deepEqual(pipeline, [
    {
      $match: {
        _id: { $in: [PRODUCT_ID] },
        category: { $in: [CATEGORY_ID] },
      },
    },
    { $group: { _id: "$category", count: { $sum: 1 } } },
  ]);
});

test("registers the Home categories GET route without authentication middleware", () => {
  const layer = publicRouter.stack.find(
    (item) => item.route?.path === "/:language/categories/home"
  );

  assert.ok(layer);
  assert.equal(layer.route.methods.get, true);
  assert.equal(layer.route.stack.length, 1);
  assert.equal(layer.route.stack[0].handle, getHomeCategories);
});
