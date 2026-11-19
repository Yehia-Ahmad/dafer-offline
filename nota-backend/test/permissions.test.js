// Stage 13 unit tests (no database): permission catalog, role templates, effective permissions,
// the route → permission map (walks the real Express router), lockout clock, tokens, cost stripping,
// audit detail filtering, recovery codes, and fail-closed startup.
process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_TEMPLATES,
  effectivePermissions,
  hasPermission,
  permissionsForRole,
} = require("../src/auth/permissions");
const { PERMISSION_TAG, stripCost } = require("../src/auth/middleware");
const { createLoginLimiter, LOCK_MS } = require("../src/auth/loginLimiter");
const { signToken, verifyToken } = require("../src/auth/jwt");
const { safeDetails } = require("../src/auth/audit");
const { canonicalRecoveryCode, generateRecoveryCode } = require("../src/controllers/auth.controller");

const APP_PATH = path.join(__dirname, "..", "src", "app.js");
const SECRET = "0123456789abcdef0123456789abcdef-test";
const STORE_SECRET = "store-0123456789abcdef0123456789abcdef-test";

const EXPECTED_CATALOG = [
  "sales.create", "sales.view", "sales.edit", "sales.delete", "sales.discount", "sales.priceBelowCost",
  "credit.create", "credit.view", "credit.edit", "credit.delete", "credit.collect", "credit.payment.cancel",
  "returns.create", "returns.view",
  "customers.view", "customers.manage",
  "suppliers.view", "suppliers.manage", "suppliers.pay", "purchases.view", "purchases.create", "purchases.cancel",
  "products.view", "products.manage", "products.viewCost", "products.syncPrice", "products.importExport",
  "categories.manage",
  "reports.profit", "dashboard.view",
  "shop.manage", "users.manage", "audit.view",
  "backup.manage",
  "accounting.view", "accounting.manage",
  // Stage 19
  "cashbox.view", "cashbox.manage", "shift.operate", "shift.manage", "expenses.create", "expenses.manage", "owner.drawings",
  // Stage 21
  "vat.file",
  // Stage 22
  "reports.financial", "accounting.close",
  // Online Stage 3
  "website.manage",
  // Online Stage 4
  "orders.view", "orders.manage", "orders.dispatch",
];

test("catalog: exactly the Stage 13 keys, each with an Arabic and English label and a group", () => {
  assert.deepEqual([...ALL_PERMISSIONS].sort(), [...EXPECTED_CATALOG].sort());
  for (const key of ALL_PERMISSIONS) {
    const entry = PERMISSIONS[key];
    assert.ok(entry.ar && entry.en && entry.group, `${key} has labels and a group`);
  }
});

test("role templates match the spec", () => {
  const sorted = (list) => [...list].sort();
  assert.deepEqual(sorted(ROLE_TEMPLATES.owner), sorted(EXPECTED_CATALOG));
  assert.deepEqual(sorted(ROLE_TEMPLATES.manager), sorted(EXPECTED_CATALOG.filter((k) => !["users.manage", "backup.manage", "accounting.manage", "accounting.close", "owner.drawings"].includes(k))));
  assert.deepEqual(sorted(ROLE_TEMPLATES.cashier), sorted([
    "sales.create", "sales.view", "credit.create", "credit.view", "credit.collect",
    "returns.create", "customers.view", "products.view", "dashboard.view",
    "shift.operate", "expenses.create", "orders.view", "orders.manage", "orders.dispatch",
  ]));
  assert.deepEqual(sorted(ROLE_TEMPLATES.storekeeper), sorted([
    "products.view", "products.manage", "categories.manage", "products.importExport", "products.viewCost", "suppliers.view",
    "purchases.view", "purchases.create",
  ]));
  assert.deepEqual(sorted(ROLE_TEMPLATES.accountant), sorted([
    "sales.view", "credit.view", "returns.view", "customers.view", "products.view", "dashboard.view",
    "reports.profit", "products.viewCost", "credit.collect", "audit.view", "accounting.view", "suppliers.view",
    "purchases.view", "suppliers.pay", "cashbox.view", "expenses.create", "expenses.manage", "vat.file", "reports.financial",
  ]));
  assert.deepEqual(permissionsForRole("custom"), []);
});

test("effective permissions: owner always all, custom its list, template unless edited", () => {
  assert.deepEqual(effectivePermissions({ role: "owner", permissions: [] }), ALL_PERMISSIONS);
  assert.deepEqual(effectivePermissions({ role: "owner", permissions: ["sales.view"], permissionsEdited: true }), ALL_PERMISSIONS);
  assert.deepEqual(effectivePermissions({ role: "custom", permissions: ["sales.view", "nope", "sales.view"] }), ["sales.view"]);
  assert.deepEqual(effectivePermissions({ role: "cashier", permissions: ["audit.view"] }), permissionsForRole("cashier"), "not edited → template");
  assert.deepEqual(effectivePermissions({ role: "cashier", permissions: ["audit.view"], permissionsEdited: true }), ["audit.view"]);
  assert.equal(hasPermission({ role: "cashier" }, "sales.create"), true);
  assert.equal(hasPermission({ role: "cashier" }, "products.viewCost"), false);
  assert.equal(hasPermission(null, "sales.view"), false);
});

// ---- Route → permission map ---------------------------------------------------------------

// PUBLIC = no login; AUTHENTICATED = any signed-in user; otherwise every listed key.
const EXPECTED_ROUTES = {
  "GET /api/auth/bootstrap": "PUBLIC",
  "POST /api/auth/login": "PUBLIC",
  "GET /api/auth/me": "AUTHENTICATED",
  "POST /api/auth/change-password": "AUTHENTICATED",
  "POST /api/auth/verify-password": "AUTHENTICATED",
  "POST /api/auth/refresh": "AUTHENTICATED",
  "GET /api/auth/permissions": "AUTHENTICATED",
  "GET /api/users": "users.manage",
  "POST /api/users": "users.manage",
  "PATCH /api/users/:id/status": "users.manage",
  "POST /api/users/:id/reset-password": "users.manage",
  "GET /api/users/:id": "users.manage",
  "PUT /api/users/:id": "users.manage",
  "GET /api/audit": "audit.view",
  "GET /api/accounting/accounts": "accounting.view",
  "GET /api/accounting/accounts/:id/ledger": "accounting.view",
  "GET /api/accounting/journal": "accounting.view",
  "GET /api/accounting/journal/:id": "accounting.view",
  "GET /api/accounting/health": "accounting.view",
  "GET /api/accounting/opening": "accounting.view",
  "POST /api/accounting/opening": "accounting.manage",
  "POST /api/accounting/opening/finalize": "accounting.manage",
  // Stage 22
  "GET /api/accounting/accounts/next-code": "accounting.manage",
  "POST /api/accounting/accounts": "accounting.manage",
  "GET /api/accounting/accounts/:id/usage": "accounting.manage",
  "PUT /api/accounting/accounts/:id": "accounting.manage",
  "POST /api/accounting/accounts/:id/deactivate": "accounting.manage",
  "POST /api/accounting/accounts/:id/reactivate": "accounting.manage",
  "DELETE /api/accounting/accounts/:id": "accounting.manage",
  "GET /api/accounting/manual-entries/accounts": "accounting.manage",
  "GET /api/accounting/manual-entries": "accounting.manage",
  "POST /api/accounting/manual-entries": "accounting.manage",
  "GET /api/accounting/manual-entries/:id": "accounting.manage",
  "PUT /api/accounting/manual-entries/:id": "accounting.manage",
  "DELETE /api/accounting/manual-entries/:id": "accounting.manage",
  "POST /api/accounting/manual-entries/:id/post": "accounting.manage",
  "POST /api/accounting/manual-entries/:id/reverse": "accounting.manage",
  "GET /api/accounting/lock-date": "AUTHENTICATED",
  "GET /api/accounting/closing": "accounting.view",
  "POST /api/accounting/closing/close": "accounting.close",
  "POST /api/accounting/closing/reopen": "accounting.close",
  "GET /api/reports/income-statement": "reports.financial",
  "GET /api/reports/balance-sheet": "reports.financial",
  "GET /api/reports/trial-balance": "reports.financial",
  "GET /api/reports/box-movements": "reports.financial",
  "GET /api/reports/party-balances": "reports.financial",
  "GET /api/categories": "products.view",
  "POST /api/categories": "categories.manage",
  "GET /api/categories/export": "products.importExport + products.viewCost",
  "POST /api/categories/import": "products.importExport + categories.manage",
  "GET /api/categories/:id": "products.view",
  "PUT /api/categories/:id": "categories.manage",
  "DELETE /api/categories/:id": "categories.manage + products.manage",
  "GET /api/credit-sales": "credit.view",
  "POST /api/credit-sales": "credit.create",
  "POST /api/credit-sales/:id/payments": "credit.collect",
  "GET /api/credit-sales/:id": "credit.view",
  "PUT /api/credit-sales/:id": "credit.edit",
  "POST /api/credit-sales/:id/cancel": "credit.delete",
  "GET /api/customers": "customers.view",
  "POST /api/customers": "customers.manage",
  "POST /api/customers/:id/payments": "credit.collect",
  "GET /api/customers/:id/statement": "customers.view",
  "GET /api/customers/:id/credit": "customers.view",
  "GET /api/customers/:id/receipts": "customers.view | credit.collect",
  "POST /api/customers/:id/receipts/:receiptId/cancel": "credit.payment.cancel",
  "POST /api/customers/:id/payouts": "credit.collect",
  "POST /api/customers/:id/payouts/:payoutId/cancel": "credit.collect",
  "POST /api/customers/:id/apply-credit": "credit.collect",
  "GET /api/customers/:id": "customers.view",
  "PUT /api/customers/:id": "customers.manage",
  "DELETE /api/customers/:id": "customers.manage",
  "GET /api/dashboard/summary": "dashboard.view",
  "GET /api/dashboard/mobile-summary": "AUTHENTICATED",
  "GET /api/push/public-key": "AUTHENTICATED",
  "POST /api/push/subscribe": "AUTHENTICATED",
  "DELETE /api/push/subscribe": "AUTHENTICATED",
  "GET /api/products": "products.view",
  "POST /api/products": "products.manage + products.viewCost",
  "GET /api/products/search": "products.view",
  "GET /api/products/export/excel": "products.importExport + products.viewCost",
  "GET /api/products/profit-report": "reports.profit + products.viewCost",
  "GET /api/products/profit-bar": "reports.profit + products.viewCost",
  "POST /api/products/:id/sync-purchase-price": "products.syncPrice",
  "POST /api/products/:id/restore": "products.manage",
  "GET /api/products/:id/profit-report": "reports.profit + products.viewCost",
  "GET /api/products/:id": "products.view",
  "PUT /api/products/:id": "products.manage",
  "DELETE /api/products/:id": "products.manage",
  "GET /api/returns/summary": "returns.view",
  "GET /api/returns": "returns.view",
  "POST /api/returns": "returns.create",
  "GET /api/returns/:id": "returns.view",
  "GET /api/sellings": "sales.view",
  "POST /api/sellings": "sales.create",
  "GET /api/sellings/:id": "sales.view",
  "PUT /api/sellings/:id": "sales.edit",
  "POST /api/sellings/:id/cancel": "sales.delete",
  "GET /api/sellings/customer-by-phone": "sales.create | credit.create",
  "GET /api/shop-profile": "AUTHENTICATED",
  // Stage 19
  "GET /api/cashbox/payment-boxes": "AUTHENTICATED",
  "GET /api/cashbox/boxes": "cashbox.view",
  "POST /api/cashbox/boxes": "cashbox.manage",
  "GET /api/cashbox/boxes/:id": "cashbox.view",
  "PUT /api/cashbox/boxes/:id": "cashbox.manage",
  "DELETE /api/cashbox/boxes/:id": "cashbox.manage",
  "GET /api/cashbox/boxes/:id/ledger": "cashbox.view",
  "GET /api/cashbox/transfers": "cashbox.view",
  "POST /api/cashbox/transfers": "cashbox.manage",
  "POST /api/cashbox/transfers/:id/cancel": "cashbox.manage",
  "GET /api/cashbox/drawings": "owner.drawings",
  "POST /api/cashbox/drawings": "owner.drawings",
  "POST /api/cashbox/drawings/:id/cancel": "owner.drawings",
  "GET /api/shifts": "shift.operate | shift.manage",
  "POST /api/shifts": "shift.operate | shift.manage",
  "GET /api/shifts/:id": "shift.operate | shift.manage",
  "POST /api/shifts/:id/close": "shift.operate | shift.manage",
  "GET /api/expenses/categories": "expenses.create | expenses.manage | cashbox.view",
  "POST /api/expenses/categories": "expenses.manage",
  "PUT /api/expenses/categories/:id": "expenses.manage",
  "GET /api/expenses": "expenses.create | expenses.manage | cashbox.view",
  "POST /api/expenses": "expenses.create",
  "POST /api/expenses/:id/cancel": "expenses.manage",
  // Stage 21
  "GET /api/vat/returns": "vat.file | accounting.view",
  "GET /api/vat/returns/:period": "vat.file | accounting.view",
  "GET /api/vat/returns/:period/export": "vat.file | accounting.view",
  "POST /api/vat/returns/:period/file": "vat.file",
  "POST /api/vat/returns/:period/pay": "vat.file",
  "POST /api/vat/returns/:period/unfile": "vat.file",
  "GET /api/devices": "cashbox.manage",
  // Stage 23: prints
  "POST /api/print/reserve": "AUTHENTICATED",
  "POST /api/print/confirm": "AUTHENTICATED",
  "POST /api/print/release": "AUTHENTICATED",
  "GET /api/print/journal-ref/:number": "AUTHENTICATED",
  "GET /api/customers/:id/receipts/:number/print-data": "customers.view | credit.collect",
  "GET /api/purchases/:id/print-data": "purchases.view",
  "GET /api/products/print-data": "products.view",
  "GET /api/suppliers": "suppliers.view",
  "POST /api/suppliers": "suppliers.manage",
  "GET /api/suppliers/:id": "suppliers.view",
  "PUT /api/suppliers/:id": "suppliers.manage",
  "DELETE /api/suppliers/:id": "suppliers.manage",
  "GET /api/suppliers/:id/statement": "suppliers.view",
  "GET /api/suppliers/:id/payments": "suppliers.view",
  "POST /api/suppliers/:id/payments": "suppliers.pay",
  "GET /api/suppliers/:id/refunds": "suppliers.view",
  "POST /api/suppliers/:id/refunds": "suppliers.pay",
  "POST /api/supplier-payments/:id/cancel": "suppliers.pay",
  "GET /api/purchases": "purchases.view",
  "POST /api/purchases": "purchases.create",
  "GET /api/purchases/:id": "purchases.view",
  "POST /api/purchases/:id/cancel": "purchases.cancel",
  "POST /api/purchases/:id/returns": "purchases.create",
  "PUT /api/shop-profile": "shop.manage",
  // Online Stage 3: the admin side of the customer website
  "GET /api/website/settings": "website.manage",
  "PUT /api/website/settings": "website.manage",
  "GET /api/website/delivery-zones": "website.manage",
  "POST /api/website/delivery-zones": "website.manage",
  "PUT /api/website/delivery-zones/:id": "website.manage",
  "DELETE /api/website/delivery-zones/:id": "website.manage",
  "GET /api/website/products/:id": "website.manage",
  "PUT /api/website/products/:id": "website.manage",
  "PUT /api/website/categories/:id": "website.manage",
  // Online Stage 4: website customers, orders, couriers
  "GET /api/website/customers": "website.manage",
  "PUT /api/website/customers/:id": "website.manage",
  "POST /api/website/customers/:id/reset-password": "website.manage",
  "GET /api/orders": "orders.view",
  "GET /api/orders/summary": "orders.view",
  "GET /api/orders/delivery-zones": "orders.manage",
  "GET /api/orders/:id": "orders.view",
  "PUT /api/orders/:id": "orders.manage",
  "POST /api/orders/:id/confirm": "orders.manage",
  "POST /api/orders/:id/prepare": "orders.manage",
  "POST /api/orders/:id/reject": "orders.manage",
  "POST /api/orders/:id/cancel": "orders.manage",
  // Online Stage 5A: dispatch / deliver need credit.create / credit.collect (cash on delivery) or sales.create (wallet), checked in the
  // service once the order is loaded; ready and verify-payment are order management; picking up creates a cash sale.
  "POST /api/orders/:id/ready": "orders.manage",
  "POST /api/orders/:id/verify-payment": "orders.manage",
  "POST /api/orders/:id/pickup": "orders.dispatch + sales.create",
  "POST /api/orders/:id/dispatch": "orders.dispatch",
  "POST /api/orders/:id/deliver": "orders.dispatch",
  "POST /api/orders/:id/refuse": "orders.dispatch + returns.create",
  "POST /api/orders/:id/change-courier": "orders.dispatch",
  "GET /api/couriers": "orders.view | website.manage",
  "POST /api/couriers": "website.manage + customers.manage",
  "GET /api/couriers/:id": "orders.view | website.manage",
  "PUT /api/couriers/:id": "website.manage + customers.manage",
  // Online Stage 3: the public API of the customer website. STORE = no token needed (a guest may call it),
  // STORE:customer = needs a customer token (never a staff token). POST /orders accepts a guest or a customer.
  "GET /api/store/settings": "STORE",
  "GET /api/store/categories": "STORE",
  "GET /api/store/products": "STORE",
  "GET /api/store/products/:id": "STORE",
  "GET /api/store/products/:id/related": "STORE",
  "GET /api/store/delivery-zones": "STORE",
  "GET /api/store/images/website-logo": "STORE",
  "GET /api/store/images/product/:id/:index": "STORE",
  "GET /api/store/images/category/:id": "STORE",
  "GET /api/store/images/banner/:id": "STORE",
  "GET /api/store/images/logo": "STORE",
  "POST /api/store/auth/register": "STORE",
  "POST /api/store/auth/login": "STORE",
  "POST /api/store/orders": "STORE",
  "POST /api/store/orders/quote": "STORE",
  "GET /api/store/orders/track/:token": "STORE",
  "GET /api/store/me": "STORE:customer",
  "PUT /api/store/me": "STORE:customer",
  "GET /api/store/me/addresses": "STORE:customer",
  "POST /api/store/me/addresses": "STORE:customer",
  "PUT /api/store/me/addresses/:id": "STORE:customer",
  "DELETE /api/store/me/addresses/:id": "STORE:customer",
  "GET /api/store/me/orders": "STORE:customer",
  "GET /api/store/me/orders/:id": "STORE:customer",
  "POST /api/store/me/orders/:id/cancel": "STORE:customer",
};

const loadApp = (env) => {
  const keys = ["NOTA_JWT_SECRET", "NOTA_STORE_JWT_SECRET", "CORS_ORIGINS"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  delete require.cache[APP_PATH];
  try {
    return require(APP_PATH);
  } finally {
    keys.forEach((key) => (saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key])));
  }
};

// "^\/api\/categories\/?(?=\/|$)" → "/api/categories"
const mountPath = (layer) =>
  layer.regexp.source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");

// router.route(path).get(...).post(...) shares one stack: keep only the layers of each method.
const methodStack = (route, method) => route.stack.filter((layer) => layer.method === method);

const listRoutes = (app) => {
  const routes = [];
  for (const layer of app._router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ key: `${method.toUpperCase()} ${layer.route.path}`, stack: methodStack(layer.route, method) });
      }
    } else if (layer.name === "router" && layer.handle.stack) {
      const base = mountPath(layer);
      for (const inner of layer.handle.stack) {
        if (!inner.route) continue;
        for (const method of Object.keys(inner.route.methods)) {
          const routePath = inner.route.path === "/" ? "" : inner.route.path;
          routes.push({ key: `${method.toUpperCase()} ${base}${routePath}`, stack: methodStack(inner.route, method) });
        }
      }
    }
  }
  return routes;
};

const permissionOf = (stack) => {
  const tagged = stack.map((layer) => layer.handle[PERMISSION_TAG]).filter((value) => value !== undefined);
  if (tagged.length !== 1) return null;
  return Array.isArray(tagged[0]) ? tagged[0].join(" + ") : tagged[0];
};

test("every /api route has exactly one permission, and the map is the documented one", () => {
  const app = loadApp({ NOTA_JWT_SECRET: SECRET, NOTA_STORE_JWT_SECRET: STORE_SECRET });
  const routes = listRoutes(app).filter((route) => route.key.split(" ")[1].startsWith("/api"));
  const actual = Object.fromEntries(routes.map((route) => [route.key, permissionOf(route.stack)]));
  const missing = Object.entries(actual).filter(([, permission]) => !permission).map(([key]) => key);
  assert.deepEqual(missing, [], `routes without a permission: ${missing.join(", ")}`);
  assert.deepEqual(actual, EXPECTED_ROUTES);
  for (const permission of Object.values(actual)) {
    for (const key of permission.split(/ [+|] /)) {
      assert.ok(key === "PUBLIC" || key === "AUTHENTICATED" || key === "STORE" || key === "STORE:customer" || PERMISSIONS[key], `${key} is in the catalog`);
    }
  }
  // Online Stage 3: every /api/store route carries a STORE tag and nothing else does.
  for (const [key, permission] of Object.entries(actual)) {
    const isStoreRoute = key.split(" ")[1].startsWith("/api/store/");
    assert.equal(permission.startsWith("STORE"), isStoreRoute, `${key}: a STORE tag belongs on /api/store routes only`);
  }
});

test("setup-owner and recover are not routes: an owner is created and recovered on the server only", () => {
  const app = loadApp({ NOTA_JWT_SECRET: SECRET, NOTA_STORE_JWT_SECRET: STORE_SECRET });
  const keys = listRoutes(app).map((route) => route.key);
  assert.ok(!keys.some((key) => /setup-owner|recover/.test(key)), keys.join(", "));
});

// ---- Lockout, tokens, stripping, audit details, recovery codes --------------------------------

test("lockout: 5 failures lock (username, IP) for 5 minutes, then it expires (injected clock)", () => {
  let clock = 1_000_000;
  const A = "192.168.1.20";
  const B = "192.168.1.30";
  const limiter = createLoginLimiter({ now: () => clock });
  for (let i = 1; i <= 4; i++) assert.equal(limiter.fail("Cashier", A), false, `failure ${i} does not lock`);
  assert.equal(limiter.lockedFor("cashier", A), 0);
  assert.equal(limiter.fail("cashier", A), true, "the 5th failure locks");
  assert.equal(limiter.lockedFor("CASHIER", A), LOCK_MS, "usernames are compared case-insensitively");
  assert.equal(limiter.lockedFor("cashier", B), 0, "another IP is not locked");
  assert.equal(limiter.lockedFor("owner", A), 0, "another username from the same IP is not locked");
  clock += LOCK_MS - 1;
  assert.equal(limiter.lockedFor("cashier", A), 1);
  clock += 1;
  assert.equal(limiter.lockedFor("cashier", A), 0, "expired");
  assert.equal(limiter.fail("cashier", A), false, "the count starts over after the lock");
  limiter.succeed("cashier", A);
  assert.equal(limiter.fail("cashier", A), false);

  for (let i = 0; i < 5; i++) limiter.fail("owner", A);
  for (let i = 0; i < 5; i++) limiter.fail("owner", B);
  limiter.clearUsername("OWNER");
  assert.equal(limiter.lockedFor("owner", A) + limiter.lockedFor("owner", B), 0, "clearUsername unlocks every IP");
});

test("tokens: payload is { sub, tv } only; bad signature, expired and alg=none are rejected", () => {
  const token = signToken({ _id: "6aeba10c1485c03d1687cdcb", tokenVersion: 3 }, SECRET);
  const payload = verifyToken(token, SECRET);
  assert.equal(payload.sub, "6aeba10c1485c03d1687cdcb");
  assert.equal(payload.tv, 3);
  assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "sub", "tv"]);
  assert.equal(payload.exp - payload.iat, 12 * 60 * 60, "12 hours");
  assert.equal(jwt.decode(token, { complete: true }).header.alg, "HS256");

  assert.equal(verifyToken(token, `${SECRET}-other`), null, "bad signature");
  const expired = jwt.sign({ sub: "6aeba10c1485c03d1687cdcb", tv: 0, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
  assert.equal(verifyToken(expired, SECRET), null, "expired");
  const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"x","tv":0}').toString("base64url")}.`;
  assert.equal(verifyToken(unsigned, SECRET), null, "alg none");
  assert.equal(verifyToken("", SECRET), null);
});

test("cost stripping removes purchase price and profit at any depth and keeps the rest", () => {
  const input = {
    data: [{ name: "A", purchasePrice: 5, retailPrice: 9, wholesalePrice: 7, items: [{ profitAmount: 1, unitPrice: 9 }] }],
    totalProfit: 3,
    profitValue: 3,
    months: [{ month: 1, profit: 2, revenue: 10 }],
  };
  assert.deepEqual(stripCost(input), {
    data: [{ name: "A", retailPrice: 9, wholesalePrice: 7, items: [{ unitPrice: 9 }] }],
    months: [{ month: 1, revenue: 10 }],
  });
});

test("audit details never keep secret-looking keys", () => {
  const details = safeDetails({
    username: "cashier",
    password: "x",
    newPassword: "y",
    passwordHash: "$2b$10$...",
    token: "t",
    recoveryCode: "ABCD-EFGH-JKLM-NPQR",
    nested: { recoveryCodeHash: "h", amount: 5 },
  });
  assert.deepEqual(details, { username: "cashier", nested: { amount: 5 } });
});

test("recovery codes: XXXX-XXXX-XXXX-XXXX without 0/O/1/I; input is normalized", () => {
  for (let i = 0; i < 50; i++) {
    const code = generateRecoveryCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  }
  assert.equal(canonicalRecoveryCode(" abcd efgh-jklm npqr "), "ABCD-EFGH-JKLM-NPQR");
  assert.equal(canonicalRecoveryCode("ABCD-EFGH"), "");
});

test("startup fails with a missing or short NOTA_JWT_SECRET", () => {
  const run = (env) => {
    const childEnv = { NOTA_STORE_JWT_SECRET: STORE_SECRET, ...process.env, ...env };
    if (env.NOTA_JWT_SECRET === undefined) delete childEnv.NOTA_JWT_SECRET;
    return spawnSync(process.execPath, ["-e", `require(${JSON.stringify(APP_PATH)})`], { env: childEnv, encoding: "utf8", windowsHide: true });
  };
  const missing = run({});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /NOTA_JWT_SECRET must be at least 32 characters/);
  const short = run({ NOTA_JWT_SECRET: "x".repeat(31) });
  assert.notEqual(short.status, 0);
  assert.match(short.stderr, /NOTA_JWT_SECRET must be at least 32/);
  assert.equal(run({ NOTA_JWT_SECRET: "x".repeat(32) }).status, 0, "32 characters is enough");
});
