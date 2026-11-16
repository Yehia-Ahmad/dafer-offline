// Online Stage 3: admin routes of the customer website. Every route needs website.manage.
const express = require("express");
const c = require("../controllers/website.controller");
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

router.get("/products/:id", manage, c.getProductWebsite);
router.put("/products/:id", manage, auditOnSuccess("website.product.updated", "Product"), c.updateProductWebsite);
router.put("/categories/:id", manage, auditOnSuccess("website.category.updated", "Category"), c.updateCategoryWebsite);

module.exports = router;
