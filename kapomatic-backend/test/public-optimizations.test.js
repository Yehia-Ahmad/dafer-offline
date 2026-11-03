process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Category = require("../src/models/category.model");
const EcommerceSetting = require("../src/models/ecommerceSetting.model");
const GeneralSetting = require("../src/models/generalSetting.model");
const Product = require("../src/models/product.model");
const WebsiteImage = require("../src/models/websiteImage.model");
const {
  getActiveEcommerceSettingCategories,
  getHomePageCategories,
  updateHomePageCategories,
} = require("../src/controllers/ecommerceSetting.controller");
const {
  getActiveWebsiteImagesWithProducts,
} = require("../src/controllers/websiteImage.controller");
const errorHandler = require("../src/middlewares/error.middleware");
const { cacheGet, cacheSet, clearPublicSeoCache } = require("../src/utils/seo");

const CATEGORY_ID = new mongoose.Types.ObjectId("66b0b7b5a8c197aa0adf1234");
const PRODUCT_ID = new mongoose.Types.ObjectId("67b0b7b5a8c197aa0adf1234");
const PROMOTION_ID = new mongoose.Types.ObjectId("68b0b7b5a8c197aa0adf1234");

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

const req = (query = {}, body = {}) => ({
  query,
  body,
  protocol: "https",
  get(name) {
    return name.toLowerCase() === "host" ? "api.example.test" : undefined;
  },
});

const invoke = (handler, request) =>
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
    handler(request, res, (error) => {
      if (!error) return reject(new Error("next called without an error"));
      return errorHandler(error, request, res, reject);
    });
  });

test("keeps the full active-categories row contract while replacing Base64 images", async () => {
  clearPublicSeoCache();
  const originals = {
    categoryFind: Category.find,
    productFind: Product.find,
    ecommerceFind: EcommerceSetting.find,
  };
  Category.find = () =>
    chain([
      {
        _id: CATEGORY_ID,
        name: "زيوت",
        image: "data:image/png;base64,AAAA",
        specifications: [{ name: "Type" }],
      },
    ]);
  Product.find = () =>
    chain([
      {
        _id: PRODUCT_ID,
        name: "ATF",
        code: "ATF-1",
        image: "data:image/png;base64,AAAA",
        category: CATEGORY_ID,
        retailPrice: 100,
        discountPercentage: 10,
        inventoryCount: 4,
        specifications: [{ name: "Type", value: "A" }],
      },
    ]);
  EcommerceSetting.find = () =>
    chain([
      {
        _id: new mongoose.Types.ObjectId(),
        category: CATEGORY_ID,
        showOnWebsite: true,
        selectedProducts: [PRODUCT_ID],
        filters: [],
      },
    ]);
  try {
    const response = await invoke(getActiveEcommerceSettingCategories, req());
    assert.equal(Array.isArray(response.body), true);
    assert.deepEqual(response.body[0].setting.selectedProducts, [PRODUCT_ID]);
    assert.equal(response.body[0].products[0].code, "ATF-1");
    assert.deepEqual(response.body[0].category.specifications[0], {
      name: "Type",
      values: ["A"],
    });
    assert.match(response.body[0].category.image, /\/api\/public\/images\/categories\//);
    assert.match(response.body[0].products[0].image, /\/api\/public\/images\/products\//);
    assert.equal(JSON.stringify(response.body).includes("base64"), false);
    assert.equal(response.headers["cache-control"], "private, no-store");
  } finally {
    Category.find = originals.categoryFind;
    Product.find = originals.productFind;
    EcommerceSetting.find = originals.ecommerceFind;
    clearPublicSeoCache();
  }
});

test("bounded active categories uses one pre-limited aggregate and omits private product data", async () => {
  clearPublicSeoCache();
  const originals = {
    ecommerceFind: EcommerceSetting.find,
    ecommerceAggregate: EcommerceSetting.aggregate,
    categoryAggregate: Category.aggregate,
    productFind: Product.find,
  };
  let pipeline;
  let productFindCalls = 0;
  EcommerceSetting.find = () =>
    chain([{ category: CATEGORY_ID, showOnWebsite: true, selectedProducts: [PRODUCT_ID] }]);
  EcommerceSetting.aggregate = async (value) => {
    pipeline = value;
    return [
      {
        category: CATEGORY_ID,
        productOrder: 0,
        product: {
          _id: PRODUCT_ID,
          category: CATEGORY_ID,
          name: "ATF",
          localized: { name: "ATF", slug: "atf" },
          slugAr: "atf",
          slugEn: "atf",
          code: "ATF-1",
          retailPrice: 100,
          discountPercentage: 10,
          inventoryCount: 4,
          hasImage: true,
        },
      },
    ];
  };
  Category.aggregate = async () => [
    {
      _id: CATEGORY_ID,
      name: "زيوت",
      localized: { name: "زيوت", slug: "زيوت" },
      slugAr: "زيوت",
      slugEn: "oils",
      hasImage: true,
    },
  ];
  Product.find = () => {
    productFindCalls += 1;
    throw new Error("Product.find must not be used in bounded mode");
  };
  try {
    const response = await invoke(
      getActiveEcommerceSettingCategories,
      req({ projection: "storefront", productLimit: "6" })
    );
    assert.equal(response.body[0].products.length, 1);
    assert.equal(pipeline[1].$project.selectedProducts.$slice[1], 6);
    assert.ok(pipeline.find((stage) => stage.$lookup));
    assert.equal(productFindCalls, 0);
    assert.equal(JSON.stringify(response.body).includes("purchasePrice"), false);
    assert.equal(JSON.stringify(response.body).includes("base64"), false);
  } finally {
    EcommerceSetting.find = originals.ecommerceFind;
    EcommerceSetting.aggregate = originals.ecommerceAggregate;
    Category.aggregate = originals.categoryAggregate;
    Product.find = originals.productFind;
    clearPublicSeoCache();
  }
});

test("Home category settings preserves IDs/order and returns URL images only", async () => {
  const originals = {
    generalFindOne: GeneralSetting.findOne,
    categoryAggregate: Category.aggregate,
  };
  GeneralSetting.findOne = () => chain({ homePageCategoryIds: [CATEGORY_ID] });
  Category.aggregate = async () => [
    { _id: CATEGORY_ID, name: "زيوت", hasImage: true },
  ];
  try {
    const response = await invoke(getHomePageCategories, req());
    assert.deepEqual(response.body.categoryIds, [CATEGORY_ID]);
    assert.equal(response.body.categories[0].name, "زيوت");
    assert.equal(response.body.categories[0].image, response.body.categories[0].imageUrl);
    assert.equal(JSON.stringify(response.body).includes("base64"), false);
  } finally {
    GeneralSetting.findOne = originals.generalFindOne;
    Category.aggregate = originals.categoryAggregate;
  }
});

test("active promotions batches and deduplicates Product resolution, preserves the array contract, and caches", async () => {
  clearPublicSeoCache();
  const originals = {
    websiteFind: WebsiteImage.find,
    productAggregate: Product.aggregate,
    categoryAggregate: Category.aggregate,
  };
  let websiteQueries = 0;
  let productQueries = 0;
  let productMatch;
  WebsiteImage.find = () => {
    websiteQueries += 1;
    return chain([
      {
        _id: PROMOTION_ID,
        title: "Offer",
        targetType: "product",
        productIds: [PRODUCT_ID, PRODUCT_ID],
        categoryIds: [],
        specificationFilters: [],
        isActive: true,
      },
    ]);
  };
  Product.aggregate = async (pipeline) => {
    productQueries += 1;
    productMatch = pipeline[0].$match;
    return [
      {
        _id: PRODUCT_ID,
        name: "ATF",
        code: "ATF-1",
        category: CATEGORY_ID,
        retailPrice: 100,
        discountPercentage: 10,
        inventoryCount: 4,
        specifications: [],
        translations: {},
        slugAliases: [],
        hasImage: true,
      },
    ];
  };
  Category.aggregate = async () => [
    { _id: CATEGORY_ID, name: "زيوت", hasImage: true },
  ];
  try {
    const first = await invoke(getActiveWebsiteImagesWithProducts, req());
    const second = await invoke(getActiveWebsiteImagesWithProducts, req());
    assert.equal(Array.isArray(first.body), true);
    assert.equal(first.body[0].resolvedProducts.length, 1);
    assert.equal(first.body[0].productIds.length, 1);
    assert.equal(first.body[0].imageUrl, `https://api.kapomatic.com/api/website-images/${PROMOTION_ID}/image`);
    assert.deepEqual(productMatch.$or[0]._id.$in, [PRODUCT_ID]);
    assert.equal(productQueries, 1);
    assert.equal(websiteQueries, 1);
    assert.equal(second.headers["cache-control"].startsWith("public"), true);
    assert.equal(JSON.stringify(first.body).includes("base64"), false);
    assert.equal(JSON.stringify(first.body).includes("purchasePrice"), false);
  } finally {
    WebsiteImage.find = originals.websiteFind;
    Product.aggregate = originals.productAggregate;
    Category.aggregate = originals.categoryAggregate;
    clearPublicSeoCache();
  }
});

test("updating Home configuration invalidates the established public cache", async () => {
  clearPublicSeoCache();
  cacheSet("invalidation-proof", { stale: true });
  const originals = {
    countDocuments: Category.countDocuments,
    generalFindOneAndUpdate: GeneralSetting.findOneAndUpdate,
  };
  Category.countDocuments = async () => 0;
  GeneralSetting.findOneAndUpdate = () => ({
    select() {
      return Promise.resolve({ homePageCategoryIds: [] });
    },
  });
  try {
    const response = await invoke(updateHomePageCategories, req({}, { categoryIds: [] }));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { categoryIds: [], categories: [] });
    assert.equal(cacheGet("invalidation-proof"), undefined);
  } finally {
    Category.countDocuments = originals.countDocuments;
    GeneralSetting.findOneAndUpdate = originals.generalFindOneAndUpdate;
    clearPublicSeoCache();
  }
});
