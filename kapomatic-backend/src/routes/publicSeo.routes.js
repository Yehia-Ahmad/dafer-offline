const express = require("express");
const {
  getCategoryImage,
  getHomeCategories,
  getLocalizedCategory,
  getLocalizedCategoryProducts,
  getLocalizedProduct,
  getProductImage,
  getSitemapCategories,
  getSitemapImages,
  getSitemapPages,
  getSitemapProducts,
  getSitemapXmlCategoriesAr,
  getSitemapXmlCategoriesArChunk,
  getSitemapXmlCategoriesEn,
  getSitemapXmlCategoriesEnChunk,
  getSitemapXmlImages,
  getSitemapXmlImagesChunk,
  getSitemapXmlIndex,
  getSitemapXmlPagesAr,
  getSitemapXmlPagesEn,
  getSitemapXmlProductsAr,
  getSitemapXmlProductsArChunk,
  getSitemapXmlProductsEn,
  getSitemapXmlProductsEnChunk,
  resolveSlugAlias,
  searchLocalizedProducts,
} = require("../controllers/publicSeo.controller");

const router = express.Router();

router.get("/seo/sitemap/pages", getSitemapPages);
router.get("/seo/sitemap/categories", getSitemapCategories);
router.get("/seo/sitemap/products", getSitemapProducts);
router.get("/seo/sitemap/images", getSitemapImages);
router.get("/seo/sitemaps/pages-ar.xml", getSitemapXmlPagesAr);
router.get("/seo/sitemaps/pages-en.xml", getSitemapXmlPagesEn);
router.get("/seo/sitemaps/categories-ar.xml", getSitemapXmlCategoriesAr);
router.get("/seo/sitemaps/categories-en.xml", getSitemapXmlCategoriesEn);
router.get("/seo/sitemaps/products-ar.xml", getSitemapXmlProductsAr);
router.get("/seo/sitemaps/products-en.xml", getSitemapXmlProductsEn);
router.get("/seo/sitemaps/images.xml", getSitemapXmlImages);
router.get("/seo/sitemaps/sitemap-index.xml", getSitemapXmlIndex);
router.get("/seo/sitemaps/categories-ar-:page.xml", getSitemapXmlCategoriesArChunk);
router.get("/seo/sitemaps/categories-en-:page.xml", getSitemapXmlCategoriesEnChunk);
router.get("/seo/sitemaps/products-ar-:page.xml", getSitemapXmlProductsArChunk);
router.get("/seo/sitemaps/products-en-:page.xml", getSitemapXmlProductsEnChunk);
router.get("/seo/sitemaps/images-:page.xml", getSitemapXmlImagesChunk);
router.get("/images/categories/:id", getCategoryImage);
router.get("/images/products/:id", getProductImage);
router.get("/products/search", searchLocalizedProducts);
// Deprecated compatibility aliases. New clients should use /api/public/products/search.
router.get("/:language/products/search", searchLocalizedProducts);
router.get("/:language/categories/home", getHomeCategories);
router.get("/:language/categories/:slug/products", getLocalizedCategoryProducts);
router.get("/:language/categories/:slug", getLocalizedCategory);
router.get("/:language/products/:slug", getLocalizedProduct);
router.get("/:language/slug-aliases/:entityType/:slug", resolveSlugAlias);

module.exports = router;
