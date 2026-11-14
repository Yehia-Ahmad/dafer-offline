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
const supplierRoutes = require("./routes/supplier.routes");
const purchaseRoutes = require("./routes/purchase.routes");
const supplierPaymentRoutes = require("./routes/supplierPayment.routes");
const { createAuthRouter } = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const auditRoutes = require("./routes/audit.routes");
const accountingRoutes = require("./routes/accounting.routes");
const reportsRoutes = require("./routes/reports.routes");
const cashboxRoutes = require("./routes/cashbox.routes");
const shiftRoutes = require("./routes/shift.routes");
const expenseRoutes = require("./routes/expense.routes");
const vatRoutes = require("./routes/vat.routes");
const deviceRoutes = require("./routes/device.routes");
const printRoutes = require("./routes/print.routes");
const { requireLicense } = require("./license/middleware");
const { deviceGate } = require("./middlewares/deviceGate.middleware");
const { createLicenseRouter } = require("./routes/license.routes");
const { deviceContext } =require("./middlewares/device.middleware");
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

if (lanMode) app.use("/api", createLanSecretGuard(process.env.NOTA_LAN_SECRET));

// Stage 24: no valid license, no API (402 LICENSE_REQUIRED), except the two activation routes below.
app.use("/api", requireLicense());
// Stage 24: every non-loopback request carries a device id; one id from two IPs at once is refused (the client limit's honesty checks).
app.use("/api", deviceGate());
app.use("/api/license", createLicenseRouter({ secret: jwtSecret, sessionsValidAfter: sessionsValidAfter() }));

if (lanMode) app.use("/api/lan", lanRoutes);

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

// Stage 19: which PC this is (X-Nota-Device-Id), for the default cash box. Not an auth factor.
app.use("/api", deviceContext());

// Accounting endpoints remain available to the offline/legacy migration
// runner when authentication is disabled; requirePermission is a no-op in
// that mode and enforces accounting.view/manage when auth is enabled.
app.use("/api/accounting", accountingRoutes);
app.use("/api/reports", reportsRoutes);

app.use("/api/cashbox", cashboxRoutes);
app.use("/api/shifts", shiftRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/vat", vatRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/print", printRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/credit-sales", creditSaleRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/products", productRoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/sellings", sellingRoutes);
app.use("/api/shop-profile", shopProfileRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/purchases", purchaseRoutes);
app.use("/api/supplier-payments", supplierPaymentRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
