const express = require("express");
const cors = require("cors");
const { createAccessLog } = require("./utils/accessLog");
const { createHealthHandler } = require("./utils/health");

const categoryRoutes = require("./routes/category.routes");
const creditSaleRoutes = require("./routes/creditSale.routes");
const customerRoutes = require("./routes/customer.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
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
const { deviceContext } = require("./middlewares/device.middleware");
const notFound = require("./middlewares/notFound.middleware");
const errorHandler = require("./middlewares/error.middleware");
const { requireJwtSecret, requireStoreJwtSecret, sessionsValidAfter } = require("./auth/config");
const { createStoreRouter } = require("./routes/store.routes");
const websiteRoutes = require("./routes/website.routes");
const { costStrip, requireAuth } = require("./auth/middleware");

const app = express();
// Behind nginx on the same machine: take the client IP from X-Forwarded-For, only from a loopback peer.
// Without this every request looks like 127.0.0.1 and the login lockout would hit everyone at once.
if (process.env.NOTA_TRUST_PROXY === "1") app.set("trust proxy", "loopback");
// Fail closed: without a usable NOTA_JWT_SECRET the app must not start (throws here, at load).
const jwtSecret = requireJwtSecret();
// Online Stage 3: the customer website signs its own tokens with a different secret; the server must not start without it.
const storeJwtSecret = requireStoreJwtSecret();

// CORS_ORIGINS: comma-separated allow-list. Unset or empty: no cross-origin access (same origin only).
const corsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins }));
app.use(createAccessLog());

// Health check for nginx/systemd/deploy scripts: outside /api, no auth, no data besides ok/version/db.
app.get("/health", createHealthHandler());

app.get("/", (req, res) => {
  res.json({ message: "Warehouse API is running" });
});

// Online Stage 3: the public API of the customer website. Mounted BEFORE the staff requireAuth below, so it never sees a
// staff token, and with its own small body limit (the 10mb staff limit never applies here).
const storeRouter = createStoreRouter({ secret: storeJwtSecret });
app.locals.store = storeRouter.controller; // the customer lockout counters, for tests
app.use("/api/store", express.json({ limit: "64kb" }), storeRouter);

// The staff API: 10mb JSON bodies (product images), then the session token.
app.use("/api", express.json({ limit: "10mb" }));
// Every /api request needs the session token, except the login screen's own endpoints
// (bootstrap, login).
app.use("/api", requireAuth(jwtSecret, { sessionsValidAfter: sessionsValidAfter() }));
app.use("/api", costStrip());
const authRouter = createAuthRouter({ secret: jwtSecret });
app.locals.auth = authRouter.controller; // the lockout counters, for tests
app.use("/api/auth", authRouter);
app.use("/api/users", usersRoutes);
app.use("/api/audit", auditRoutes);

// Stage 19: which device this is (X-Nota-Device-Id), for the default cash box. Not an auth factor.
app.use("/api", deviceContext());

// requirePermission enforces accounting.view/manage.
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
app.use("/api/website", websiteRoutes); // Online Stage 3: website.manage
app.use("/api/orders", require("./routes/orders.routes")); // Online Stage 4: orders.view / orders.manage / orders.dispatch
app.use("/api/couriers", require("./routes/couriers.routes")); // Online Stage 4: couriers

app.use(notFound);
app.use(errorHandler);

module.exports = app;
