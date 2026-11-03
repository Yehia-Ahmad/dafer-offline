const assert = require("node:assert/strict");
const test = require("node:test");
const {
  _private: {
    buildPublicProductSearchQuery,
    buildPublicProductSearchRegexes,
    getPublicProductSearchTerm,
    getPublicProductSearchRelevance,
    normalizeArabicSearchText,
    sortProductsByPublicSearchRelevance,
  },
} = require("../src/controllers/publicSeo.controller");
const { buildPaginationMetadata, getPaginationParams } = require("../src/utils/pagination");

const createMockResponse = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
});

test("builds one language-independent query across Arabic, English, code, keywords, and aliases", () => {
  const query = buildPublicProductSearchQuery(["product-1"], "filter");
  const fields = new Set(query.$or.flatMap((condition) => Object.keys(condition)));

  assert.deepEqual(query._id, { $in: ["product-1"] });
  assert.equal(fields.has("name"), true);
  assert.equal(fields.has("code"), true);
  assert.equal(fields.has("translations.ar.name"), true);
  assert.equal(fields.has("translations.en.name"), true);
  assert.equal(fields.has("translations.ar.shortDescription"), true);
  assert.equal(fields.has("translations.en.shortDescription"), true);
  assert.equal(fields.has("translations.ar.description"), true);
  assert.equal(fields.has("translations.en.description"), true);
  assert.equal(fields.has("seo.ar.keywords"), true);
  assert.equal(fields.has("seo.en.keywords"), true);
  assert.equal(fields.has("slugAliases.slug"), true);
});

test("trims q and rejects missing or empty q with project validation style", () => {
  const res = createMockResponse();

  assert.equal(getPublicProductSearchTerm({ q: "  فلتر  " }, res), "فلتر");
  assert.throws(
    () => getPublicProductSearchTerm({ q: "   " }, res),
    (error) => error.message === "مطلوب معامل البحث q" && res.statusCode === 400
  );
});

test("escapes regex-special search input and keeps English matching case-insensitive", () => {
  const [regex] = buildPublicProductSearchRegexes("(+.*)");

  assert.equal(regex.test("(+.*)"), true);
  assert.equal(regex.test("FILTER (+.*)"), true);
  assert.equal(regex.test("anything"), false);
  assert.equal(regex.flags.includes("i"), true);
});

test("normalizes Arabic search text without mutating product data", () => {
  assert.equal(normalizeArabicSearchText("فِلـتَر آبار"), "فلتر ابار");
});

test("Arabic regex tolerates Alef variants, diacritics, and tatweel", () => {
  const regexes = buildPublicProductSearchRegexes("ابار");

  assert.equal(regexes.some((regex) => regex.test("آبـار")), true);
  assert.equal(regexes.some((regex) => regex.test("أبار")), true);
  assert.equal(regexes.some((regex) => regex.source.includes("\\u")), false);
});

test("relevance works for partial names, case-insensitive English, Arabic, and product code", () => {
  const product = {
    name: "فلتر فورد",
    code: "FLT-221",
    translations: {
      ar: { name: "فلتر فورد", description: "فلتر زيت" },
      en: { name: "Ford Filter", shortDescription: "Oil filter" },
    },
    seo: {
      ar: { keywords: ["فلاتر"] },
      en: { keywords: ["filter"] },
    },
    slugAliases: [{ slug: "ford-filter-old" }],
  };

  assert.equal(getPublicProductSearchRelevance(product, "فور"), 2);
  assert.equal(getPublicProductSearchRelevance(product, "FILTER"), 0);
  assert.equal(getPublicProductSearchRelevance(product, "flt-221"), 0);
});

test("sorts matched products once by relevance then newest createdAt", () => {
  const products = [
    { _id: "2", translations: { en: { name: "Cabin filter" } }, createdAt: "2024-01-01T00:00:00.000Z" },
    { _id: "1", code: "FILTER", translations: { en: { name: "Filter" } }, createdAt: "2023-01-01T00:00:00.000Z" },
    { _id: "3", translations: { en: { name: "Oil product" } }, createdAt: "2025-01-01T00:00:00.000Z" },
  ];

  assert.deepEqual(
    sortProductsByPublicSearchRelevance(products, "filter").map((product) => product._id),
    ["1", "2", "3"]
  );
});

test("pagination parameters keep safe defaults and limits", () => {
  assert.deepEqual(getPaginationParams({ page: "2", limit: "1" }), { page: 2, limit: 1, skip: 1 });
  assert.deepEqual(getPaginationParams({ page: "0", limit: "500" }), { page: 1, limit: 10, skip: 0 });
  assert.deepEqual(buildPaginationMetadata({ page: 2, limit: 1, totalItems: 3 }), {
    page: 2,
    limit: 1,
    totalItems: 3,
    totalPages: 3,
    hasNextPage: true,
    hasPrevPage: true,
  });
});
