// Online Stage 3: the public API of the customer website, mounted at /api/store BEFORE the staff requireAuth.
// Staff tokens mean nothing here and customer tokens (NOTA_STORE_JWT_SECRET, audience nota-store) mean nothing on staff routes.
// Every route carries a STORE / STORE:customer tag for test/permissions.test.js (one router level only: no sub-routers).
const express = require("express");
const catalogController = require("../controllers/storeCatalog.controller");
const { createStoreAccountController } = require("../controllers/storeAccount.controller");
const { createStoreOrderController } = require("../controllers/storeOrder.controller");
const asyncHandler = require("../utils/asyncHandler");
const { httpError } = require("../auth/middleware");
const { storeCustomerOnly, storeOptional, storePublic } = require("../auth/storeAuth");
const { loadWebsiteSettings } = require("../store/catalog");

const createStoreRouter = ({ secret }) => {
  const router = express.Router();
  const account = createStoreAccountController({ secret });
  const orders = createStoreOrderController({ secret });
  const pub = storePublic();
  const optional = storeOptional(secret);
  const customer = storeCustomerOnly(secret);

  // Nothing here is cacheable by default (answers can hold a customer's data); the image routes set their own header.
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  // The one route that still answers while the website is closed.
  router.get("/settings", pub, catalogController.getSettings);

  // The closed page shows the shop logo, so the logo is the one image that still answers while the website is closed.
  router.get("/images/logo", pub, catalogController.getLogoImage);

  // Website disabled: every other route answers 503 STORE_CLOSED.
  router.use(asyncHandler(async (_req, _res, next) => {
    const settings = await loadWebsiteSettings();
    if (!settings || !settings.enabled) {
      const error = httpError(503, "STORE_CLOSED", "الموقع مقفول حاليًا");
      error.responseData.closedMessage = (settings && settings.closedMessage) || "";
      throw error;
    }
    next();
  }));

  router.get("/categories", pub, catalogController.getCategories);
  router.get("/products", pub, catalogController.getProducts);
  router.get("/products/:id", pub, catalogController.getProduct);
  router.get("/products/:id/related", pub, catalogController.getRelatedProducts); // Online Stage 5A
  router.get("/delivery-zones", pub, catalogController.getDeliveryZones);
  router.get("/images/website-logo", pub, catalogController.getWebsiteLogoImage); // Online Stage 5A
  router.get("/images/product/:id/:index", pub, catalogController.getProductImage);
  router.get("/images/category/:id", pub, catalogController.getCategoryImage);
  router.get("/images/banner/:id", pub, catalogController.getBannerImage);

  router.post("/auth/register", pub, account.register);
  router.post("/auth/login", pub, account.login);

  router.post("/orders", optional, orders.placeOrder);
  router.get("/orders/track/:token", pub, orders.trackOrder);

  router.get("/me", customer, account.getMe);
  router.put("/me", customer, account.updateMe);
  router.get("/me/addresses", customer, account.listAddresses);
  router.post("/me/addresses", customer, account.addAddress);
  router.put("/me/addresses/:id", customer, account.updateAddress);
  router.delete("/me/addresses/:id", customer, account.deleteAddress);
  router.get("/me/orders", customer, orders.listMyOrders);
  router.get("/me/orders/:id", customer, orders.getMyOrder);
  router.post("/me/orders/:id/cancel", customer, orders.cancelMyOrder);

  router.controller = account; // the lockout counters, for tests
  return router;
};

module.exports = { createStoreRouter };
