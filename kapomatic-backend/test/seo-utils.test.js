const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeSeoInput,
  normalizeSlug,
} = require("../src/utils/seo");

const res = {
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
};

test("normalizes English and Arabic slugs", () => {
  assert.equal(
    normalizeSlug(" Automatic Transmission Parts!! ", "en"),
    "automatic-transmission-parts"
  );
  assert.equal(
    normalizeSlug("قطع غيار فتيس أوتوماتيك", "ar"),
    "قطع-غيار-فتيس-اوتوماتيك"
  );
});

test("keeps legacy name as missing Arabic translation only", () => {
  const update = normalizeSeoInput({
    body: {},
    legacyName: "اسم قديم",
    entityType: "category",
    res,
  });

  assert.equal(update.translations.ar.name, "اسم قديم");
  assert.equal(update.translations.en, undefined);
});

test("preserves false booleans and numeric zero values in SEO", () => {
  const update = normalizeSeoInput({
    body: {
      seo: {
        robotsIndex: false,
        robotsFollow: false,
        includeInSitemap: false,
        sitemapPriority: 0,
      },
    },
    entityType: "product",
    res,
  });

  assert.equal(update.seo.robotsIndex, false);
  assert.equal(update.seo.robotsFollow, false);
  assert.equal(update.seo.includeInSitemap, false);
  assert.equal(update.seo.sitemapPriority, 0);
});

test("rejects non-http canonical overrides with field-specific errors", () => {
  assert.throws(
    () =>
      normalizeSeoInput({
        body: { seo: { en: { canonicalOverride: "ftp://example.com/product" } } },
        entityType: "product",
        res,
      }),
    (error) =>
      error.responseData.fieldErrors[0].field === "seo.en.canonicalOverride" &&
      res.statusCode === 400
  );
});
