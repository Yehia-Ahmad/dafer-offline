// Online Stage 3: admin routes of the customer website. Every route needs website.manage.
const express = require("express");
const c = require("../controllers/website.controller");
const customers = require("../controllers/websiteCustomers.controller");
const marketingSettings = require("../controllers/marketingSettings.controller");
const metaConnection = require("../controllers/metaConnection.controller");
const { requirePermission } = require("../auth/middleware");
const { auditOnSuccess } = require("../auth/audit");

const router = express.Router();
const manage = requirePermission("website.manage");

router
  .route("/settings")
  .get(manage, c.getSettings)
  .put(manage, auditOnSuccess("website.settings.updated", "WebsiteSettings", () => undefined), c.updateSettings);

router
  .route("/delivery-zones")
  .get(manage, c.listZones)
  .post(manage, auditOnSuccess("website.zone.created", "DeliveryZone"), c.createZone);
router
  .route("/delivery-zones/:id")
  .put(manage, auditOnSuccess("website.zone.updated", "DeliveryZone"), c.updateZone)
  .delete(manage, auditOnSuccess("website.zone.deleted", "DeliveryZone"), c.deleteZone);

// Online Stage 7A: pixels, consent, attribution window, "عرفتنا منين؟" and the feed links (marketing permissions, not website.manage).
router.get("/marketing-settings", requirePermission("marketing.view"), marketingSettings.get);
router.put("/marketing-settings", requirePermission("marketing.manage"), auditOnSuccess("marketing.settings.updated", "WebsiteSettings", (req) => ({ fields: Object.keys(req.body || {}) })), marketingSettings.update);

// Online Stage 7B: the Meta ad account connection (owner only by default: marketing.connect) and the exchange-rate history.
// Audit details never carry the request body: the body holds the token.
const connect = requirePermission("marketing.connect");
router.get("/meta-connection", connect, metaConnection.get);
router.post("/meta-connection/test", connect, metaConnection.test);
router.post("/meta-connection/sync", connect, metaConnection.syncNow);
router.put("/meta-connection", connect, auditOnSuccess("meta.connected", "MetaConnection", (_req, body) => ({ adAccountId: body && body.adAccountId })), metaConnection.save);
router.delete("/meta-connection", connect, auditOnSuccess("meta.disconnected", "MetaConnection", () => undefined), metaConnection.disconnect);
router.get("/exchange-rates", requirePermission("marketing.view"), metaConnection.listRates);
router.post("/exchange-rates", connect, auditOnSuccess("meta.rate.saved", "ExchangeRate", (_req, body) => ({ currency: body && body.currency, rate: body && body.rate, effectiveFrom: body && body.effectiveFrom })), metaConnection.saveRate);
router.delete("/exchange-rates/:id", connect, auditOnSuccess("meta.rate.deleted", "ExchangeRate", () => undefined), metaConnection.deleteRate);

router.get("/products/:id", manage, c.getProductWebsite);
router.put("/products/:id", manage, auditOnSuccess("website.product.updated", "Product"), c.updateProductWebsite);
router.put("/categories/:id", manage, auditOnSuccess("website.category.updated", "Category"), c.updateCategoryWebsite);

// Online Stage 4: the website's customers (search, deactivate/activate, reset password).
router.get("/customers", manage, customers.list);
router.put("/customers/:id", manage, customers.setActive);
router.post("/customers/:id/reset-password", manage, customers.resetPassword);

module.exports = router;
