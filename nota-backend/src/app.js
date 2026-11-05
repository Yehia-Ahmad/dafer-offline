const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const categoryRoutes = require("./routes/category.routes");
const creditSaleRoutes = require("./routes/creditSale.routes");
const customerRoutes = require("./routes/customer.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const lanRoutes = require("./routes/lan.routes");
const productRoutes = require("./routes/product.routes");
const returnsRoutes = require("./routes/returns.routes");
const sellingRoutes = require("./routes/selling.routes");
const shopProfileRoutes = require("./routes/shopProfile.routes");
const { createAuthRouter } = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const auditRoutes = require("./routes/audit.routes");
const accountingRoutes = require("./routes/accounting.routes");
const { createLanSecretGuard, isLanMode } = require("./middlewares/lanSecret.middleware");
const notFound = require("./middlewares/notFound.middleware");
const errorHandler = require("./middlewares/error.middleware");
const { isAuthMode, requireJwtSecret, sessionsValidAfter } = require("./auth/config");
const { authFlag, costStrip, requireAuth } = require("./auth/middleware");

const app = express();
// Offline desktop edition only (NOTA_LAN_MODE=1). Unset in the online deployment.
const lanMode = isLanMode();
// Stage 13 switch (NOTA_AUTH=1). Unset: no login, no permissions, nothing stripped, as before.
const authMode = isAuthMode();
// Fail closed: auth mode without a usable NOTA_JWT_SECRET must not start (throws here, at load).
const jwtSecret = authMode ? requireJwtSecret() : null;

app.use(authFlag(authMode));
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

if (authMode) {
  // LAN key first (above), then the session token. /api/lan/* and the login screen's own
  // endpoints (bootstrap, login, setup-owner, recover) need no token.
  app.use("/api", requireAuth(jwtSecret, { sessionsValidAfter: sessionsValidAfter() }));
  app.use("/api", costStrip());
  const authRouter = createAuthRouter({ secret: jwtSecret });
  app.locals.auth = authRouter.controller; // the lockout counters, for tests
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRoutes);
  app.use("/api/audit", auditRoutes);
}

// Accounting endpoints remain available to the offline/legacy migration
// runner when authentication is disabled; requirePermission is a no-op in
// that mode and enforces accounting.view/manage when auth is enabled.
app.use("/api/accounting", accountingRoutes);

app.use("/api/categories", categoryRoutes);
app.use("/api/credit-sales", creditSaleRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/products", productRoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/sellings", sellingRoutes);
app.use("/api/shop-profile", shopProfileRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
