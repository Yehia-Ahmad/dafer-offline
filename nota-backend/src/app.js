const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const categoryRoutes = require("./routes/category.routes");
const creditSaleRoutes = require("./routes/creditSale.routes");
const customerRoutes = require("./routes/customer.routes");
const lanRoutes = require("./routes/lan.routes");
const productRoutes = require("./routes/product.routes");
const returnsRoutes = require("./routes/returns.routes");
const sellingRoutes = require("./routes/selling.routes");
const shopProfileRoutes = require("./routes/shopProfile.routes");
const { createLanSecretGuard, isLanMode } = require("./middlewares/lanSecret.middleware");
const notFound = require("./middlewares/notFound.middleware");
const errorHandler = require("./middlewares/error.middleware");

const app = express();
// Offline desktop edition only (NOTA_LAN_MODE=1). Unset in the online deployment.
const lanMode = isLanMode();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({ message: "Warehouse API is running" });
});

if (lanMode) {
  app.use("/api", createLanSecretGuard(process.env.NOTA_LAN_SECRET));
  app.use("/api/lan", lanRoutes);
}

app.use("/api/categories", categoryRoutes);
app.use("/api/credit-sales", creditSaleRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/products", productRoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/sellings", sellingRoutes);
app.use("/api/shop-profile", shopProfileRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
