const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const cartRoutes = require("./routes/cart.routes");
const categoryRoutes = require("./routes/category.routes");
const creditSaleRoutes = require("./routes/creditSale.routes");
const customerRoutes = require("./routes/customer.routes");
const ecommerceSettingRoutes = require("./routes/ecommerceSetting.routes");
const lanRoutes = require("./routes/lan.routes");
const notificationRoutes = require("./routes/notification.routes");
const productRoutes = require("./routes/product.routes");
const publicPageRoutes = require("./routes/publicPage.routes");
const publicSeoRoutes = require("./routes/publicSeo.routes");
const returnsRoutes = require("./routes/returns.routes");
const seoRoutes = require("./routes/seo.routes");
const sellingRoutes = require("./routes/selling.routes");
const websiteImageRoutes = require("./routes/websiteImage.routes");
const websiteOrderRoutes = require("./routes/websiteOrder.routes");
const { createLanSecretGuard, isLanMode } = require("./middlewares/lanSecret.middleware");
const notFound = require("./middlewares/notFound.middleware");
const errorHandler = require("./middlewares/error.middleware");

const app = express();
// Offline desktop edition only (KAPOMATIC_LAN_MODE=1). Unset in the online deployment.
const lanMode = isLanMode();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({ message: "Warehouse API is running" });
});

if (lanMode) {
  app.use("/api", createLanSecretGuard(process.env.KAPOMATIC_LAN_SECRET));
  app.use("/api/lan", lanRoutes);
}

app.use("/api/categories", categoryRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/credit-sales", creditSaleRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/ecommerce-settings", ecommerceSettingRoutes);
if (!lanMode) {
  // Push notifications need Firebase, which the offline edition does not ship.
  app.use("/api/notifications", notificationRoutes);
}
app.use("/api/products", productRoutes);
app.use("/api", publicPageRoutes);
app.use("/api/public", publicSeoRoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/seo", seoRoutes);
app.use("/api/sellings", sellingRoutes);
app.use("/api/website-images", websiteImageRoutes);
app.use("/api/website-orders", websiteOrderRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
