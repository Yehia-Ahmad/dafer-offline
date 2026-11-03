const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getSitemapXmlPagesAr,
  _private: {
    buildProductSitemapRows,
    pageSitemapRowsForLanguage,
    renderImageSitemapXml,
    renderSitemapIndexXml,
    renderSitemapXml,
    sitemapChunks,
    sitemapRowsForLanguage,
    xmlEscape,
  },
} = require("../src/controllers/publicSeo.controller");
const { getPublicApiOrigin, getWebsiteOrigin } = require("../src/utils/seo");

const createMockResponse = () => {
  const response = {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  return response;
};

test("XML sitemap endpoint returns application/xml content type", async () => {
  const previousWebsiteOrigin = process.env.WEBSITE_ORIGIN;
  process.env.WEBSITE_ORIGIN = "https://kapomatic.example";
  const res = createMockResponse();

  try {
    await getSitemapXmlPagesAr({}, res, () => undefined);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/xml; charset=utf-8");
    assert.match(res.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
    assert.match(res.body, /<loc>https:\/\/kapomatic\.example\/ar<\/loc>/);
  } finally {
    if (previousWebsiteOrigin === undefined) delete process.env.WEBSITE_ORIGIN;
    else process.env.WEBSITE_ORIGIN = previousWebsiteOrigin;
  }
});

test("sitemap XML includes namespaces, hreflang alternates, and escaped values", () => {
  const xml = renderSitemapXml([
    {
      loc: "https://kapomatic.example/ar/categories/filters?a=1&b=2",
      lastmod: "2026-08-22T00:00:00.000Z",
      changefreq: "weekly",
      priority: 0.7,
      alternates: {
        ar: "https://kapomatic.example/ar/categories/فلاتر",
        en: "https://kapomatic.example/en/categories/filters",
        xDefault: "https://kapomatic.example/ar/categories/فلاتر",
      },
    },
  ]);

  assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.match(xml, /hreflang="ar"/);
  assert.match(xml, /hreflang="en"/);
  assert.match(xml, /hreflang="x-default"/);
  assert.match(xml, /a=1&amp;b=2/);
});

test("Arabic and English sitemap rows are separated", () => {
  const rows = [
    { loc: "https://kapomatic.example/ar/products/فلتر", language: "ar" },
    { loc: "https://kapomatic.example/en/products/filter", language: "en" },
  ];

  assert.deepEqual(sitemapRowsForLanguage(rows, "ar").map((row) => row.loc), [
    "https://kapomatic.example/ar/products/فلتر",
  ]);
  assert.deepEqual(sitemapRowsForLanguage(rows, "en").map((row) => row.loc), [
    "https://kapomatic.example/en/products/filter",
  ]);
});

test("image sitemap includes Google image namespace and escaped image fields", () => {
  const xml = renderImageSitemapXml([
    {
      loc: "https://kapomatic.example/ar/products/filter",
      image: {
        loc: "https://api.kapomatic.example/api/public/images/products/1?a=1&b=2",
        title: "Filter <Oil> & Fuel",
      },
      alternates: { ar: "https://kapomatic.example/ar/products/filter" },
    },
  ]);

  assert.match(xml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
  assert.match(xml, /<image:loc>https:\/\/api\.kapomatic\.example\/api\/public\/images\/products\/1\?a=1&amp;b=2<\/image:loc>/);
  assert.match(xml, /<image:title>Filter &lt;Oil&gt; &amp; Fuel<\/image:title>/);
});

test("sitemap chunks stay under the URL count limit and sitemap index escapes locations", () => {
  const rows = Array.from({ length: 50_001 }, (_item, index) => ({ loc: `https://kapomatic.example/en/products/${index}` }));
  const chunks = sitemapChunks(rows);
  const xml = renderSitemapIndexXml([{ loc: "https://api.kapomatic.example/api/public/seo/sitemaps/products-en-1.xml?a=1&b=2" }]);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 50_000);
  assert.equal(chunks[1].length, 1);
  assert.match(xml, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /a=1&amp;b=2/);
});


test("SEO-excluded product records are omitted from sitemap rows", () => {
  const req = { protocol: "https", get: () => "api.kapomatic.example" };
  const products = [
    {
      _id: "visible",
      code: "VISIBLE",
      translations: { ar: { name: "ظاهر", slug: "visible-ar" }, en: { name: "Visible", slug: "visible" } },
      seo: { robotsIndex: true, includeInSitemap: true },
    },
    {
      _id: "noindex",
      code: "NOINDEX",
      translations: { en: { name: "Noindex", slug: "noindex" } },
      seo: { robotsIndex: false, includeInSitemap: true },
    },
    {
      _id: "hidden",
      code: "HIDDEN",
      translations: { en: { name: "Hidden", slug: "hidden" } },
      seo: { robotsIndex: true, includeInSitemap: false },
    },
  ];

  const urls = buildProductSitemapRows(products, req).map((row) => row.loc);

  assert.equal(urls.some((url) => url.includes("visible")), true);
  assert.equal(urls.some((url) => url.includes("noindex")), false);
  assert.equal(urls.some((url) => url.includes("hidden")), false);
});


test("XML escaping covers special characters", () => {
  assert.equal(xmlEscape(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});

test("public origins never fall back to localhost or 127.0.0.1", () => {
  const previousWebsiteOrigin = process.env.WEBSITE_ORIGIN;
  const previousApiOrigin = process.env.PUBLIC_API_ORIGIN;
  process.env.WEBSITE_ORIGIN = "http://localhost:4200";
  process.env.PUBLIC_API_ORIGIN = "http://127.0.0.1:5000";

  const req = { protocol: "http", get: () => "127.0.0.1:5000" };

  assert.equal(getWebsiteOrigin().includes("localhost"), false);
  assert.equal(getPublicApiOrigin(req).includes("127.0.0.1"), false);
  assert.equal(pageSitemapRowsForLanguage("en")[0].loc.includes("localhost"), false);

  if (previousWebsiteOrigin === undefined) delete process.env.WEBSITE_ORIGIN;
  else process.env.WEBSITE_ORIGIN = previousWebsiteOrigin;
  if (previousApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
  else process.env.PUBLIC_API_ORIGIN = previousApiOrigin;
});
