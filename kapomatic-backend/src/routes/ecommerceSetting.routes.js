const express = require("express");
const {
  getActiveEcommerceSettingCategories,
  getEcommerceCategoryFilters,
  getEcommerceSettingCategories,
  getEcommerceSettings,
  getProductByActiveEcommerceCategory,
  getProductsByActiveEcommerceCategory,
  searchActiveEcommerceProducts,
  getStorefrontSettings,
  getHomePageCategories,
  updateHomePageCategories,
  getGeneralSettings,
  updateGeneralSettings,
  getGovernmentShippingFees,
  getWebsiteCurrency,
  updateWebsiteCurrency,
  updateFreeShippingMinimumAmount,
  updateGovernmentShippingFees,
  getEcommerceSettingByCategory,
  upsertEcommerceSetting,
  resetEcommerceSetting,
} = require("../controllers/ecommerceSetting.controller");

const router = express.Router();

router.get("/", getEcommerceSettings);
router.get("/categories", getEcommerceSettingCategories);
router.get("/categories/active", getActiveEcommerceSettingCategories);
router.get("/categories/:categoryId/filters", getEcommerceCategoryFilters);
router.get("/categories/active/:categoryId/products", getProductsByActiveEcommerceCategory);
router.get(
  "/categories/active/:categoryId/products/:productId",
  getProductByActiveEcommerceCategory
);
router.get("/products/search", searchActiveEcommerceProducts);
router.get("/storefront", getStorefrontSettings);
router
  .route("/home-page/categories")
  .get(getHomePageCategories)
  .put(updateHomePageCategories);
router.route("/general").get(getGeneralSettings).put(updateGeneralSettings);
router.route("/currency").get(getWebsiteCurrency).put(updateWebsiteCurrency);
router
  .route("/shipping/governments")
  .get(getGovernmentShippingFees)
  .put(updateGovernmentShippingFees);
router.put("/shipping/free-minimum", updateFreeShippingMinimumAmount);
router
  .route("/:categoryId")
  .get(getEcommerceSettingByCategory)
  .put(upsertEcommerceSetting)
  .delete(resetEcommerceSetting);

module.exports = router;
