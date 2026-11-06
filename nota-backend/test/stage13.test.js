// Stage 13 integration tests: users, login, tokens, permissions, cost stripping, below-cost rule,
// createdBy/updatedBy and the audit log, against a real throwaway mongod (port 27097; see
// helpers/mongod.js). The same process also runs the app with NOTA_AUTH unset to prove the switch.
process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");

const SECRET = "stage13-test-secret-0123456789abcdef";
const APP_PATH = path.join(__dirname, "..", "src", "app.js");

// Both apps are loaded before the database starts, so their models get their indexes (one owner).
const loadApp = (env) => {
  const keys = ["NOTA_AUTH", "NOTA_JWT_SECRET", "NOTA_LAN_MODE", "NOTA_LAN_SECRET"];
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
const appOn = loadApp({ NOTA_AUTH: "1", NOTA_JWT_SECRET: SECRET });
const appOff = loadApp({});

const { clearDatabase, mongodSkipReason, startMongod } = require("./helpers/mongod");
const User = require("../src/models/user.model");
const AuditLog = require("../src/models/auditLog.model");
const Product = require("../src/models/product.model");
const Category = require("../src/models/category.model");
const Customer = require("../src/models/customer.model");
const Selling = require("../src/models/selling.model");
const CreditSale = require("../src/models/creditSale.model");
const ReturnLog = require("../src/models/returnLog.model");
const { createAuthRouter } = require("../src/routes/auth.routes");
const { authFlag } = require("../src/auth/middleware");
const errorHandler = require("../src/middlewares/error.middleware");
const { LOCK_MS } = require("../src/auth/loginLimiter");

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

let stopMongod;
let on;
let off;

test.before(async () => {
  if (mongodSkipReason) return;
  stopMongod = await startMongod({ port: 27097 });
  on = await listen(appOn);
  off = await listen(appOff);
});

test.after(async () => {
  if (on) await new Promise((resolve) => on.server.close(resolve));
  if (off) await new Promise((resolve) => off.server.close(resolve));
  if (stopMongod) await stopMongod();
});

test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase();
  appOn.locals.auth.loginLimiter.reset();
  appOn.locals.auth.recoverLimiter.reset();
});

const call = async (target, method, url, { token, body, headers: extraHeaders } = {}) => {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${target.base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, json, text };
};

const OWNER = { name: "صاحب المحل", username: "owner", password: "owner-pass-1" };

const setupOwner = async () => {
  const response = await call(on, "POST", "/api/auth/setup-owner", { body: OWNER });
  assert.equal(response.status, 201, response.text);
  return response.json;
};

const login = async (username, password) => call(on, "POST", "/api/auth/login", { body: { username, password } });

/** Creates a user as the owner (or `asToken`) and returns { id, token, user }. */
const addUser = async (ownerToken, { username, role, permissions, name, password = "pass-1234", asToken } = {}) => {
  const created = await call(on, "POST", "/api/users", {
    token: asToken || ownerToken,
    body: { name: name || username, username, password, role, permissions },
  });
  assert.equal(created.status, 201, created.text);
  const session = await login(username, password);
  assert.equal(session.status, 200, session.text);
  return { id: created.json.user._id, token: session.json.token, user: created.json.user };
};

const seedCatalog = async (token, { purchasePrice = 73.5 } = {}) => {
  const category = await call(on, "POST", "/api/categories", { token, body: { name: "تصنيف" } });
  assert.equal(category.status, 201, category.text);
  const product = await call(on, "POST", "/api/products", {
    token,
    body: { name: "منتج", code: "P-1", categoryId: category.json._id, inventoryCount: 50, purchasePrice, wholesalePrice: 100, retailPrice: 120 },
  });
  assert.equal(product.status, 201, product.text);
  return { categoryId: category.json._id, productId: product.json._id };
};

const today = new Date().toISOString().slice(0, 10);
const sale = (productId, price = 120, extra = {}) => ({
  customerName: "عميل",
  customerPhone: "01000000001",
  sellingDate: today,
  items: [{ productId, quantity: 1, price }],
  ...extra,
});

const COST_KEYS = ["purchasePrice", "profitAmount", "totalProfit", "profitValue", "profit"];
const findCostKeys = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => findCostKeys(item, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (COST_KEYS.includes(key)) found.add(key);
      findCostKeys(item, found);
    }
  }
  return [...found];
};

const skip = { skip: mongodSkipReason };

// ---- setup-owner, passwords, login, lockout -------------------------------------------------

test("setup-owner: works once, bootstrap reflects it, a second call is 409 OWNER_EXISTS", skip, async () => {
  const before = await call(on, "GET", "/api/auth/bootstrap");
  assert.equal(before.status, 200);
  assert.deepEqual(before.json, { hasOwner: false, isLocal: true, shop: { name: "", logo: "" } });

  const created = await setupOwner();
  assert.ok(created.token);
  assert.match(created.recoveryCode, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.equal(created.user.role, "owner");

  const after = await call(on, "GET", "/api/auth/bootstrap");
  assert.equal(after.json.hasOwner, true);

  const again = await call(on, "POST", "/api/auth/setup-owner", { body: { name: "Other", username: "other", password: "other-pass" } });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "OWNER_EXISTS");
  assert.equal(await User.countDocuments(), 1);
});

test("setup-owner: two racing requests create exactly one owner", skip, async () => {
  const results = await Promise.all([
    call(on, "POST", "/api/auth/setup-owner", { body: { name: "A", username: "owner-a", password: "password-a" } }),
    call(on, "POST", "/api/auth/setup-owner", { body: { name: "B", username: "owner-b", password: "password-b" } }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).json.code, "OWNER_EXISTS");
  assert.equal(await User.countDocuments({ role: "owner" }), 1);
  assert.equal(await User.countDocuments(), 1);
});

test("passwords: bcrypt cost 10, 6–128 characters, Arabic and spaces allowed; responses never show secrets", skip, async () => {
  const short = await call(on, "POST", "/api/auth/setup-owner", { body: { ...OWNER, password: "12345" } });
  assert.equal(short.status, 400);
  assert.equal(short.json.code, "PASSWORD_INVALID");
  const long = await call(on, "POST", "/api/auth/setup-owner", { body: { ...OWNER, password: "x".repeat(129) } });
  assert.equal(long.status, 400);

  const arabic = "كلمة سر ١٢٣";
  const created = await call(on, "POST", "/api/auth/setup-owner", { body: { ...OWNER, password: arabic } });
  assert.equal(created.status, 201, created.text);
  for (const secretKey of ["passwordHash", "recoveryCodeHash", "tokenVersion"]) {
    assert.equal(created.text.includes(secretKey), false, `${secretKey} is not in the response`);
  }
  const stored = await User.findOne({ username: "owner" }).lean();
  assert.match(stored.passwordHash, /^\$2[aby]\$10\$/, "bcrypt, cost 10");
  assert.match(stored.recoveryCodeHash, /^\$2[aby]\$10\$/);
  assert.notEqual(stored.passwordHash, arabic);

  assert.equal((await login("owner", arabic)).status, 200);
  const me = await call(on, "GET", "/api/auth/me", { token: created.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.text.includes("passwordHash"), false);
  assert.equal(me.json.permissions.length, 31);
});

test("login: success; wrong password, unknown user and disabled user get the same 401", skip, async () => {
  const owner = await setupOwner();
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });

  const ok = await login("CASHIER", "pass-1234");
  assert.equal(ok.status, 200, "usernames are case-insensitive");
  assert.ok(ok.json.token);
  assert.deepEqual(ok.json.permissions, cashier.user.permissions);
  assert.ok((await User.findById(cashier.id)).lastLoginAt, "lastLoginAt is set");

  const wrong = await login("cashier", "wrong-password");
  const unknown = await login("nobody", "wrong-password");
  assert.equal((await call(on, "PATCH", `/api/users/${cashier.id}/status`, { token: owner.token, body: { isActive: false } })).status, 200);
  const disabled = await login("cashier", "pass-1234");
  for (const response of [wrong, unknown, disabled]) {
    assert.equal(response.status, 401);
    assert.deepEqual(response.json, { message: "اسم الدخول أو كلمة المرور غير صحيحة", code: "INVALID_CREDENTIALS" });
  }
});

test("login lockout: 5 failures → 429 LOGIN_LOCKED for 5 minutes, then it expires (injected clock)", skip, async () => {
  let clock = Date.now();
  const mini = express();
  mini.use(authFlag(true));
  mini.use(express.json());
  mini.use("/api/auth", createAuthRouter({ secret: SECRET, now: () => clock }));
  mini.use(errorHandler);
  const target = await listen(mini);
  try {
    assert.equal((await call(target, "POST", "/api/auth/setup-owner", { body: OWNER })).status, 201);
    const attempt = (password) => call(target, "POST", "/api/auth/login", { body: { username: "owner", password } });
    for (let i = 1; i <= 4; i++) assert.equal((await attempt("bad-password")).status, 401, `attempt ${i}`);
    const fifth = await attempt("bad-password");
    assert.equal(fifth.status, 429);
    assert.equal(fifth.json.code, "LOGIN_LOCKED");
    assert.equal((await attempt(OWNER.password)).status, 429, "locked even with the right password");
    clock += LOCK_MS - 1000;
    assert.equal((await attempt(OWNER.password)).status, 429, "still locked just before 5 minutes");
    clock += 1000;
    assert.equal((await attempt(OWNER.password)).status, 200, "unlocked after 5 minutes");
  } finally {
    await new Promise((resolve) => target.server.close(resolve));
  }
});

test("login lockout is per username + IP: 5 bad logins from IP A lock A only; IP B still signs in", skip, async () => {
  // The test overrides req.ip from a header, so two "PCs" can be simulated on one machine.
  const mini = express();
  mini.use(authFlag(true));
  mini.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { value: req.get("x-test-ip") || "127.0.0.1", configurable: true });
    next();
  });
  mini.use(express.json());
  mini.use("/api/auth", createAuthRouter({ secret: SECRET }));
  mini.use(errorHandler);
  const target = await listen(mini);
  try {
    assert.equal((await call(target, "POST", "/api/auth/setup-owner", { body: OWNER })).status, 201);
    const attempt = (ip, password) =>
      call(target, "POST", "/api/auth/login", { body: { username: "owner", password }, headers: { "x-test-ip": ip } });
    for (let i = 1; i <= 4; i++) assert.equal((await attempt("192.168.1.20", "bad-password")).status, 401);
    assert.equal((await attempt("192.168.1.20", "bad-password")).status, 429, "IP A is locked after 5 failures");
    assert.equal((await attempt("192.168.1.20", OWNER.password)).status, 429, "IP A stays locked, even with the right password");
    const fromB = await attempt("192.168.1.30", OWNER.password);
    assert.equal(fromB.status, 200, "IP B signs in with the right password");
    assert.ok(fromB.json.token);
    assert.equal((await attempt("192.168.1.30", "bad-password")).status, 401, "IP B has its own counter");
  } finally {
    await new Promise((resolve) => target.server.close(resolve));
  }
});

// ---- tokens and recover --------------------------------------------------------------------

test("tokens: change-password, reset-password and disable end old sessions; expired and wrongly signed tokens get 401", skip, async () => {
  const owner = await setupOwner();
  const expectExpired = async (token, why) => {
    const response = await call(on, "GET", "/api/auth/me", { token });
    assert.equal(response.status, 401, why);
    assert.equal(response.json.code, "SESSION_EXPIRED", why);
  };

  // change-password: the old token stops working, the returned one works.
  const wrongCurrent = await call(on, "POST", "/api/auth/change-password", { token: owner.token, body: { currentPassword: "nope", newPassword: "new-owner-pass" } });
  assert.equal(wrongCurrent.status, 400);
  const changed = await call(on, "POST", "/api/auth/change-password", { token: owner.token, body: { currentPassword: OWNER.password, newPassword: "new-owner-pass" } });
  assert.equal(changed.status, 200, changed.text);
  await expectExpired(owner.token, "old token after change-password");
  const ownerToken = changed.json.token;
  assert.equal((await call(on, "GET", "/api/auth/me", { token: ownerToken })).status, 200);
  assert.equal((await login("owner", "new-owner-pass")).status, 200);

  // reset-password and disable by the owner end the cashier's session.
  const cashier = await addUser(ownerToken, { username: "cashier", role: "cashier" });
  assert.equal((await call(on, "POST", `/api/users/${cashier.id}/reset-password`, { token: ownerToken, body: { newPassword: "reset-1234" } })).status, 200);
  await expectExpired(cashier.token, "after reset-password");
  const relogged = await login("cashier", "reset-1234");
  assert.equal(relogged.status, 200);
  assert.equal((await call(on, "PATCH", `/api/users/${cashier.id}/status`, { token: ownerToken, body: { isActive: false } })).status, 200);
  await expectExpired(relogged.json.token, "after disable");

  // Expired, wrongly signed, garbage and missing tokens.
  const ownerDoc = await User.findOne({ role: "owner" });
  const expired = jwt.sign({ sub: String(ownerDoc._id), tv: ownerDoc.tokenVersion, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
  await expectExpired(expired, "expired token");
  const forged = jwt.sign({ sub: String(ownerDoc._id), tv: ownerDoc.tokenVersion }, "another-secret-that-is-long-enough!!");
  await expectExpired(forged, "bad signature");
  await expectExpired("not-a-token", "garbage");
  const none = await call(on, "GET", "/api/products");
  assert.equal(none.status, 401, "no token");
});

test("recover: the code works once, a new code is issued, the old one stops working; lockout", skip, async () => {
  const owner = await setupOwner();
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  void cashier;

  const notOwner = await call(on, "POST", "/api/auth/recover", { body: { username: "cashier", recoveryCode: owner.recoveryCode, newPassword: "x-123456" } });
  assert.equal(notOwner.status, 401);
  assert.equal(notOwner.json.code, "INVALID_RECOVERY");

  const recovered = await call(on, "POST", "/api/auth/recover", {
    body: { username: "owner", recoveryCode: owner.recoveryCode.toLowerCase().replace(/-/g, " "), newPassword: "recovered-pass" },
  });
  assert.equal(recovered.status, 200, recovered.text);
  assert.ok(recovered.json.token);
  assert.notEqual(recovered.json.recoveryCode, owner.recoveryCode, "a new code is issued");
  assert.equal((await call(on, "GET", "/api/auth/me", { token: owner.token })).status, 401, "old sessions end");
  assert.equal((await login("owner", "recovered-pass")).status, 200);

  const oldCode = await call(on, "POST", "/api/auth/recover", { body: { username: "owner", recoveryCode: owner.recoveryCode, newPassword: "another-pass" } });
  assert.equal(oldCode.status, 401, "the old code stops working");
  for (let i = 2; i <= 4; i++) {
    assert.equal((await call(on, "POST", "/api/auth/recover", { body: { username: "owner", recoveryCode: "AAAA-BBBB-CCCC-DDDD", newPassword: "another-pass" } })).status, 401);
  }
  const locked = await call(on, "POST", "/api/auth/recover", { body: { username: "owner", recoveryCode: "AAAA-BBBB-CCCC-DDDD", newPassword: "another-pass" } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, "LOGIN_LOCKED");
  const lockedRight = await call(on, "POST", "/api/auth/recover", { body: { username: "owner", recoveryCode: recovered.json.recoveryCode, newPassword: "another-pass" } });
  assert.equal(lockedRight.status, 429, "locked even with the right code");
});

// ---- users endpoint rules ----------------------------------------------------------------

test("users: nobody creates a second owner or turns anyone into / out of owner; there is no DELETE", skip, async () => {
  const owner = await setupOwner();
  const second = await call(on, "POST", "/api/users", { token: owner.token, body: { name: "X", username: "x", password: "pass-1234", role: "owner" } });
  assert.equal(second.status, 403);
  assert.equal(second.json.code, "OWNER_PROTECTED");

  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  const promote = await call(on, "PUT", `/api/users/${cashier.id}`, { token: owner.token, body: { role: "owner" } });
  assert.equal(promote.status, 403);
  assert.equal(promote.json.code, "OWNER_PROTECTED");
  const demote = await call(on, "PUT", `/api/users/${owner.user._id}`, { token: owner.token, body: { role: "manager" } });
  assert.equal(demote.status, 403);
  const ownerPerms = await call(on, "PUT", `/api/users/${owner.user._id}`, { token: owner.token, body: { permissions: ["sales.view"] } });
  assert.equal(ownerPerms.status, 403, "the owner's permissions cannot be edited");

  const remove = await call(on, "DELETE", `/api/users/${cashier.id}`, { token: owner.token });
  assert.equal(remove.status, 404, "no DELETE route");
  assert.equal(await User.countDocuments({ role: "owner" }), 1);
  assert.ok(await User.findById(cashier.id));
});

test("users: the owner cannot be disabled; only the owner edits the owner (name/password)", skip, async () => {
  const owner = await setupOwner();
  const admin = await addUser(owner.token, { username: "admin", role: "custom", permissions: ["users.manage", "sales.view"] });

  assert.equal((await call(on, "PATCH", `/api/users/${owner.user._id}/status`, { token: owner.token, body: { isActive: false } })).status, 403);
  assert.equal((await call(on, "PATCH", `/api/users/${owner.user._id}/status`, { token: admin.token, body: { isActive: false } })).json.code, "OWNER_PROTECTED");
  assert.equal((await call(on, "PUT", `/api/users/${owner.user._id}`, { token: admin.token, body: { name: "Hacked" } })).status, 403);
  assert.equal((await call(on, "POST", `/api/users/${owner.user._id}/reset-password`, { token: admin.token, body: { newPassword: "hacked-123" } })).status, 403);

  const rename = await call(on, "PUT", `/api/users/${owner.user._id}`, { token: owner.token, body: { name: "المالك الجديد" } });
  assert.equal(rename.status, 200);
  assert.equal(rename.json.user.name, "المالك الجديد");
  assert.equal((await User.findById(owner.user._id)).isActive, true);
});

test("users: a non-owner with users.manage cannot grant a permission they do not hold", skip, async () => {
  const owner = await setupOwner();
  const admin = await addUser(owner.token, { username: "admin", role: "custom", permissions: ["users.manage", "sales.view", "sales.create"] });

  const cashier = await call(on, "POST", "/api/users", { token: admin.token, body: { name: "C", username: "c1", password: "pass-1234", role: "cashier" } });
  assert.equal(cashier.status, 403, "the cashier template has permissions the admin lacks");
  assert.equal(cashier.json.code, "PERMISSION_NOT_HELD");
  assert.ok(cashier.json.permissions.includes("credit.create"));

  const allowed = await call(on, "POST", "/api/users", { token: admin.token, body: { name: "C", username: "c2", password: "pass-1234", role: "custom", permissions: ["sales.view"] } });
  assert.equal(allowed.status, 201);
  const grant = await call(on, "PUT", `/api/users/${allowed.json.user._id}`, { token: admin.token, body: { permissions: ["sales.view", "audit.view"] } });
  assert.equal(grant.status, 403);
  assert.equal(grant.json.code, "PERMISSION_NOT_HELD");

  // A user who already holds more than the admin can still be renamed (nothing is granted).
  const storekeeper = await addUser(owner.token, { username: "store", role: "storekeeper" });
  assert.equal((await call(on, "PUT", `/api/users/${storekeeper.id}`, { token: admin.token, body: { name: "أمين" } })).status, 200);
});

test("users: nobody resets their own password through /users, disables themselves or removes their own users.manage", skip, async () => {
  const owner = await setupOwner();
  const admin = await addUser(owner.token, { username: "admin", role: "custom", permissions: ["users.manage", "sales.view"] });

  const resetSelf = await call(on, "POST", `/api/users/${admin.id}/reset-password`, { token: admin.token, body: { newPassword: "no-current-needed" } });
  assert.equal(resetSelf.status, 400, "your own password only changes through /api/auth/change-password");
  assert.equal(resetSelf.json.code, "CANNOT_CHANGE_SELF");
  const ownerResetSelf = await call(on, "POST", `/api/users/${owner.user._id}/reset-password`, { token: owner.token, body: { newPassword: "no-current-needed" } });
  assert.equal(ownerResetSelf.status, 400, "not even the owner");
  assert.equal((await login("admin", "pass-1234")).status, 200, "the password did not change");
  assert.equal((await login("owner", OWNER.password)).status, 200);

  const disableSelf = await call(on, "PATCH", `/api/users/${admin.id}/status`, { token: admin.token, body: { isActive: false } });
  assert.equal(disableSelf.status, 400);
  assert.equal(disableSelf.json.code, "CANNOT_CHANGE_SELF");
  const dropManage = await call(on, "PUT", `/api/users/${admin.id}`, { token: admin.token, body: { permissions: ["sales.view"] } });
  assert.equal(dropManage.status, 400);
  assert.equal(dropManage.json.code, "CANNOT_CHANGE_SELF");
  const toCashier = await call(on, "PUT", `/api/users/${admin.id}`, { token: admin.token, body: { role: "cashier" } });
  assert.equal(toCashier.status, 400, "a role without users.manage counts too");
  assert.equal((await User.findById(admin.id)).isActive, true);
});

test("users: a role / permission change, disable and reset raise tokenVersion (the old token gets 401)", skip, async () => {
  const owner = await setupOwner();
  const user = await addUser(owner.token, { username: "worker", role: "cashier" });
  const sessionEnds = async (token) => assert.equal((await call(on, "GET", "/api/auth/me", { token })).status, 401);
  const relogin = async () => (await login("worker", "pass-1234")).json.token;
  const version = async () => (await User.findById(user.id)).tokenVersion;

  let token = user.token;
  assert.equal(await version(), 0);
  assert.equal((await call(on, "PUT", `/api/users/${user.id}`, { token: owner.token, body: { role: "storekeeper" } })).status, 200);
  assert.equal(await version(), 1);
  await sessionEnds(token);

  token = await relogin();
  assert.equal((await call(on, "PUT", `/api/users/${user.id}`, { token: owner.token, body: { permissions: ["products.view"] } })).status, 200);
  assert.equal(await version(), 2);
  await sessionEnds(token);

  token = await relogin();
  assert.equal((await call(on, "PUT", `/api/users/${user.id}`, { token: owner.token, body: { name: "Renamed" } })).status, 200);
  assert.equal(await version(), 2, "a rename does not log the user out");
  assert.equal((await call(on, "GET", "/api/auth/me", { token })).status, 200);

  assert.equal((await call(on, "POST", `/api/users/${user.id}/reset-password`, { token: owner.token, body: { newPassword: "pass-1234" } })).status, 200);
  assert.equal(await version(), 3);
  await sessionEnds(token);

  token = await relogin();
  assert.equal((await call(on, "PATCH", `/api/users/${user.id}/status`, { token: owner.token, body: { isActive: false } })).status, 200);
  assert.equal(await version(), 4);
  await sessionEnds(token);
});

test("users: a duplicate username → 409 USERNAME_TAKEN (case-insensitive)", skip, async () => {
  const owner = await setupOwner();
  await addUser(owner.token, { username: "cashier1", role: "cashier" });
  const duplicate = await call(on, "POST", "/api/users", { token: owner.token, body: { name: "Again", username: " Cashier1 ", password: "pass-1234", role: "cashier" } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, "USERNAME_TAKEN");
  const ownerName = await call(on, "POST", "/api/users", { token: owner.token, body: { name: "O", username: "OWNER", password: "pass-1234", role: "cashier" } });
  assert.equal(ownerName.status, 409);
});

test("users: an edited permission list is stored with permissionsEdited; a template list is not", skip, async () => {
  const owner = await setupOwner();
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  assert.equal(cashier.user.permissionsEdited, false);

  const edited = await call(on, "PUT", `/api/users/${cashier.id}`, { token: owner.token, body: { permissions: ["sales.view", "sales.create"] } });
  assert.equal(edited.json.user.permissionsEdited, true);
  assert.deepEqual(edited.json.user.permissions, ["sales.create", "sales.view"]);

  const backToTemplate = await call(on, "PUT", `/api/users/${cashier.id}`, { token: owner.token, body: { role: "cashier" } });
  assert.equal(backToTemplate.json.user.permissionsEdited, false);
  const template = (await call(on, "GET", "/api/auth/permissions", { token: owner.token })).json.roles.find((r) => r.role === "cashier");
  assert.deepEqual(backToTemplate.json.user.permissions, template.permissions);

  const unknown = await call(on, "PUT", `/api/users/${cashier.id}`, { token: owner.token, body: { permissions: ["sales.view", "made.up"] } });
  assert.equal(unknown.status, 400);
  const list = await call(on, "GET", "/api/users", { token: owner.token });
  assert.equal(list.json.users.length, 2);
  assert.equal(list.text.includes("passwordHash"), false);
});

// ---- permissions, stripping, below cost, discount -------------------------------------------

test("403 FORBIDDEN per role on a sample of routes", skip, async () => {
  const owner = await setupOwner();
  const { productId } = await seedCatalog(owner.token);
  const roles = {};
  for (const role of ["manager", "cashier", "storekeeper", "accountant"]) roles[role] = await addUser(owner.token, { username: role, role });

  const expectations = [
    ["cashier", "DELETE", `/api/products/${productId}`, 403],
    ["cashier", "GET", "/api/products/profit-report", 403],
    ["cashier", "PUT", "/api/shop-profile", 403],
    ["cashier", "GET", "/api/users", 403],
    ["cashier", "GET", "/api/audit", 403],
    ["cashier", "GET", "/api/products", 200],
    ["cashier", "GET", "/api/shop-profile", 200],
    ["storekeeper", "POST", "/api/sellings", 403],
    ["storekeeper", "GET", "/api/customers", 403],
    ["storekeeper", "GET", "/api/products", 200],
    ["accountant", "POST", "/api/products", 403],
    ["accountant", "GET", "/api/products/profit-report", 200],
    ["accountant", "GET", "/api/audit", 200],
    ["manager", "GET", "/api/users", 403],
    ["manager", "GET", "/api/audit", 200],
    ["manager", "GET", "/api/products/profit-bar", 200],
  ];
  for (const [role, method, url, status] of expectations) {
    const response = await call(on, method, url, { token: roles[role].token, body: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(response.status, status, `${role} ${method} ${url}: ${response.text}`);
    if (status === 403) {
      assert.equal(response.json.code, "FORBIDDEN");
      assert.equal(response.json.message, "ليست لديك صلاحية للقيام بهذه العملية");
    }
  }
});

test("cost stripping: a cashier sees no purchase price or profit; the owner does (products, sale, dashboard, profit report)", skip, async () => {
  const owner = await setupOwner();
  const { productId } = await seedCatalog(owner.token);
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  const created = await call(on, "POST", "/api/sellings", { token: owner.token, body: sale(productId) });
  assert.equal(created.status, 201, created.text);
  const saleId = created.json._id;

  for (const url of ["/api/products", `/api/products/${productId}`, "/api/products/search?q=P", `/api/sellings/${saleId}`, "/api/sellings"]) {
    const asOwner = await call(on, "GET", url, { token: owner.token });
    const asCashier = await call(on, "GET", url, { token: cashier.token });
    assert.equal(asCashier.status, 200, `${url}: ${asCashier.text}`);
    assert.deepEqual(findCostKeys(asCashier.json), [], `${url} has no cost fields for the cashier`);
    if (!url.includes("search")) assert.ok(findCostKeys(asOwner.json).includes("purchasePrice") || findCostKeys(asOwner.json).includes("profitAmount"), `${url} keeps cost for the owner`);
  }
  const ownerSale = await call(on, "GET", `/api/sellings/${saleId}`, { token: owner.token });
  assert.equal(ownerSale.json.items[0].purchasePrice, 73.5);
  assert.ok(ownerSale.json.totalProfit > 0);
  const cashierSale = await call(on, "GET", `/api/sellings/${saleId}`, { token: cashier.token });
  assert.equal(cashierSale.json.items[0].unitPrice ?? cashierSale.json.items[0].productPricePerEach, 120, "the rest of the sale is unchanged");

  // The dashboard carries no cost fields at all: same response for both.
  const dashOwner = await call(on, "GET", "/api/dashboard/summary", { token: owner.token });
  const dashCashier = await call(on, "GET", "/api/dashboard/summary", { token: cashier.token });
  assert.deepEqual(findCostKeys(dashOwner.json), []);
  assert.deepEqual(dashCashier.json, dashOwner.json);

  // Profit report: the cashier is refused outright; the owner gets it with profit.
  assert.equal((await call(on, "GET", "/api/products/profit-report", { token: cashier.token })).status, 403);
  const report = await call(on, "GET", "/api/products/profit-report", { token: owner.token });
  assert.equal(report.status, 200);
  assert.ok(findCostKeys(report.json).length > 0);

  // Exports need products.viewCost as well.
  assert.equal((await call(on, "GET", "/api/products/export/excel", { token: cashier.token })).status, 403);
});

test("below cost: the message never has the price; auth off blocks everyone; auth on only sales.priceBelowCost may (cash and credit)", skip, async () => {
  const owner = await setupOwner();
  const { productId } = await seedCatalog(owner.token, { purchasePrice: 73.5 });
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  const noPrice = (message) => !/73|7٣|٧٣/.test(String(message));

  const cashierCash = await call(on, "POST", "/api/sellings", { token: cashier.token, body: sale(productId, 60) });
  assert.equal(cashierCash.status, 400);
  assert.equal(cashierCash.json.message, "سعر البيع لا يمكن أن يكون أقل من سعر الشراء للمنتج منتج");
  assert.ok(noPrice(cashierCash.json.message));
  const cashierCredit = await call(on, "POST", "/api/credit-sales", { token: cashier.token, body: sale(productId, 60, { customerPhone: "01000000002" }) });
  assert.equal(cashierCredit.status, 400);
  assert.ok(noPrice(cashierCredit.json.message));

  const ownerCash = await call(on, "POST", "/api/sellings", { token: owner.token, body: sale(productId, 60) });
  assert.equal(ownerCash.status, 201, ownerCash.text);
  const ownerCredit = await call(on, "POST", "/api/credit-sales", { token: owner.token, body: sale(productId, 60, { customerPhone: "01000000003" }) });
  assert.equal(ownerCredit.status, 201, ownerCredit.text);
  const ownerEdit = await call(on, "PUT", `/api/sellings/${ownerCash.json._id}`, { token: owner.token, body: { items: [{ productId, quantity: 2, price: 50 }] } });
  assert.equal(ownerEdit.status, 200, "editing to below cost also needs the permission, which the owner has");

  // Auth off: blocked for everyone, exactly as before Stage 13.
  const offSale = await call(off, "POST", "/api/sellings", { body: sale(productId, 60) });
  assert.equal(offSale.status, 400);
  assert.ok(noPrice(offSale.json.message));
  const offCredit = await call(off, "POST", "/api/credit-sales", { body: sale(productId, 60, { customerPhone: "01000000004" }) });
  assert.equal(offCredit.status, 400);
});

test("sales.discount: a cashier cannot give an invoice discount (cash or credit); a manager can", skip, async () => {
  const owner = await setupOwner();
  const { productId } = await seedCatalog(owner.token);
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  const manager = await addUser(owner.token, { username: "manager", role: "manager" });

  assert.equal((await call(on, "POST", "/api/sellings", { token: cashier.token, body: sale(productId, 120, { discountAmount: 5 }) })).status, 403);
  assert.equal((await call(on, "POST", "/api/credit-sales", { token: cashier.token, body: sale(productId, 120, { discountPercentage: 10, customerPhone: "01000000005" }) })).status, 403);
  assert.equal((await call(on, "POST", "/api/sellings", { token: cashier.token, body: sale(productId, 120, { discountAmount: 0 }) })).status, 201, "no discount is fine");
  const discounted = await call(on, "POST", "/api/sellings", { token: manager.token, body: sale(productId, 120, { discountAmount: 5 }) });
  assert.equal(discounted.status, 201, discounted.text);
  assert.equal(discounted.json.discountAmount, 5);
});

test("sales.discount on edits compares what the user controls (cash and credit)", skip, async () => {
  const owner = await setupOwner();
  const { productId } = await seedCatalog(owner.token);
  // May edit invoices but has no sales.discount.
  const editor = await addUser(owner.token, {
    username: "editor",
    role: "custom",
    permissions: ["sales.view", "sales.create", "sales.edit", "credit.view", "credit.create", "credit.edit"],
  });
  const put = (kind, id, body) => call(on, "PUT", `/api/${kind}/${id}`, { token: editor.token, body });
  const twoItems = [{ productId, quantity: 2, price: 120 }];
  let phone = 100;
  const create = async (kind, discountAmount) => {
    phone += 1;
    const created = await call(on, "POST", `/api/${kind}`, { token: owner.token, body: sale(productId, 120, { discountAmount, customerPhone: `01000000${phone}` }) });
    assert.equal(created.status, 201, created.text);
    return created.json._id;
  };
  // A legacy percentage invoice: discountPercentage stored, no discountAmount (what older records look like).
  const createLegacyPercentage = async (kind, Model, percentage) => {
    const id = await create(kind, 0);
    await Model.updateOne({ _id: id }, { $unset: { discountAmount: 1 }, $set: { discountPercentage: percentage } });
    return id;
  };

  // Stored percentage (10 %): a quantity change with the same percentage needs no permission,
  // whether the client sends the recomputed amount (2 × 120 × 10 % = 24) or no amount at all.
  let id = await createLegacyPercentage("sellings", Selling, 10);
  let response = await put("sellings", id, { items: twoItems, discountPercentage: 10, discountAmount: 24 });
  assert.equal(response.status, 200, `quantity change, same percentage, recomputed amount: ${response.text}`);
  assert.equal(response.json.discountAmount, 24);
  id = await createLegacyPercentage("sellings", Selling, 10);
  assert.equal((await put("sellings", id, { items: twoItems, discountPercentage: 10 })).status, 200, "same percentage, no amount");
  id = await createLegacyPercentage("credit-sales", CreditSale, 10);
  assert.equal((await put("credit-sales", id, { items: twoItems, discountPercentage: 10, discountAmount: 24 })).status, 200, "credit: same");

  // Percentage changed → 403; same percentage but an amount that is not that percentage → 403.
  id = await createLegacyPercentage("sellings", Selling, 10);
  response = await put("sellings", id, { items: twoItems, discountPercentage: 15, discountAmount: 36 });
  assert.equal(response.status, 403, "percentage changed");
  assert.equal(response.json.code, "FORBIDDEN");
  assert.equal((await put("sellings", id, { items: twoItems, discountPercentage: 10, discountAmount: 50 })).status, 403, "inflated amount with the same percentage");
  assert.equal((await put("sellings", id, { items: twoItems, discountAmount: 0 })).status, 200, "percentage discount removed");

  // Stored fixed amount (5): unchanged → allowed (even with a quantity change); changed → 403; removed → allowed.
  id = await create("sellings", 5);
  assert.equal((await put("sellings", id, { items: twoItems, discountAmount: 5 })).status, 200, "same fixed amount, quantity change");
  assert.equal((await put("sellings", id, { discountAmount: 7 })).status, 403, "fixed amount changed");
  response = await put("sellings", id, { discountAmount: 0 });
  assert.equal(response.status, 200, "fixed discount removed");
  assert.equal(response.json.discountAmount, 0);
  id = await create("credit-sales", 5);
  assert.equal((await put("credit-sales", id, { discountAmount: 8 })).status, 403, "credit: fixed amount changed");
  assert.equal((await put("credit-sales", id, { discountAmount: 0 })).status, 200, "credit: discount removed");
});

test("returns skip the below-cost rule: a cashier partly returns a credit invoice sold below cost", skip, async () => {
  const owner = await setupOwner();
  const { productId } = await seedCatalog(owner.token, { purchasePrice: 73.5 });
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });
  assert.equal(cashier.user.permissions.includes("sales.priceBelowCost"), false);

  // The owner (sales.priceBelowCost) sells 3 units at 60, below the purchase price of 73.5.
  const credit = await call(on, "POST", "/api/credit-sales", {
    token: owner.token,
    body: sale(productId, 60, { customerPhone: "01000000200", items: [{ productId, quantity: 3, price: 60 }] }),
  });
  assert.equal(credit.status, 201, credit.text);

  // The cashier (returns.create only) returns one unit; the two remaining units stay below cost.
  const returned = await call(on, "POST", "/api/returns", {
    token: cashier.token,
    body: { returnType: "credit", invoiceId: credit.json._id, items: [{ productId, quantity: 1, returnReason: "partial" }] },
  });
  assert.ok([200, 201].includes(returned.status), returned.text);
  const stored = await CreditSale.findById(credit.json._id).lean();
  assert.equal(stored.refundedQuantity, 1, "one unit returned");
  assert.equal((await Product.findById(productId).lean()).inventoryCount, 48, "50 − 3 + 1");

  // Selling below cost is still blocked for the cashier.
  assert.equal((await call(on, "POST", "/api/credit-sales", { token: cashier.token, body: sale(productId, 60, { customerPhone: "01000000201" }) })).status, 400);
});

// ---- createdBy / updatedBy ----------------------------------------------------------------

test("createdBy / updatedBy come from the signed-in user (sale, credit + payment, return, product, category, customer)", skip, async () => {
  const owner = await setupOwner();
  const storekeeper = await addUser(owner.token, { username: "store", role: "storekeeper", name: "أمين المخزن" });
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier", name: "الكاشير" });
  const category = await call(on, "POST", "/api/categories", { token: owner.token, body: { name: "تصنيف" } });
  const product = await call(on, "POST", "/api/products", {
    token: storekeeper.token,
    body: { name: "منتج", code: "P-1", categoryId: category.json._id, inventoryCount: 50, purchasePrice: 10, wholesalePrice: 20, retailPrice: 30 },
  });
  assert.equal(product.status, 201, product.text);
  assert.equal(product.json.createdByName, "أمين المخزن", "visible in the product response");

  // Quantity 2, so the return below is partial (a full cash return deletes the invoice, as before).
  const cash = await call(on, "POST", "/api/sellings", {
    token: cashier.token,
    body: sale(product.json._id, 30, { customerPhone: "01000000010", items: [{ productId: product.json._id, quantity: 2, price: 30 }] }),
  });
  assert.equal(cash.status, 201, cash.text);
  assert.equal(cash.json.createdByName, "الكاشير", "visible in the invoice response");
  const credit = await call(on, "POST", "/api/credit-sales", { token: cashier.token, body: sale(product.json._id, 30, { customerPhone: "01000000011" }) });
  assert.equal(credit.status, 201, credit.text);
  const payment = await call(on, "POST", `/api/credit-sales/${credit.json._id}/payments`, { token: cashier.token, body: { amount: 5 } });
  assert.equal(payment.status, 201, payment.text);
  const returned = await call(on, "POST", "/api/returns", {
    token: cashier.token,
    body: { returnType: "cash", invoiceId: cash.json._id, items: [{ productId: product.json._id, quantity: 1, returnReason: "test" }] },
  });
  assert.ok([200, 201].includes(returned.status), returned.text);

  const is = (doc, user, field = "createdBy") => assert.equal(String(doc[field]), String(user.id || user.user._id), `${field} is ${user.user ? user.user.username : user}`);
  const ownerRef = { id: owner.user._id, user: owner.user };
  is(await Category.findById(category.json._id).lean(), ownerRef);
  const productDoc = await Product.findById(product.json._id).lean();
  is(productDoc, storekeeper);
  is(productDoc, storekeeper, "updatedBy");
  assert.equal(productDoc.inventoryCount, 48, "the sales and the return moved stock (50 − 2 − 1 + 1)…");
  // …but stock moves are not edits of the product: updatedBy stays the storekeeper.
  is(await Selling.findById(cash.json._id).lean(), cashier);
  const creditDoc = await CreditSale.findById(credit.json._id).lean();
  is(creditDoc, cashier);
  is(creditDoc.payments[0], cashier);
  assert.equal(creditDoc.payments[0].createdByName, "الكاشير");
  is(await ReturnLog.findOne({}).lean(), cashier);
  is(await Customer.findOne({ phone: "01000000010" }).lean(), cashier);

  // An edit by the owner sets updatedBy and keeps createdBy.
  const edited = await call(on, "PUT", `/api/sellings/${cash.json._id}`, { token: owner.token, body: { customerName: "عميل معدل" } });
  assert.equal(edited.status, 200, edited.text);
  const editedDoc = await Selling.findById(cash.json._id).lean();
  is(editedDoc, cashier);
  is(editedDoc, ownerRef, "updatedBy");
});

test("createdBy / updatedBy are absent with auth off", skip, async () => {
  const category = await call(off, "POST", "/api/categories", { body: { name: "تصنيف" } });
  const product = await call(off, "POST", "/api/products", {
    body: { name: "منتج", code: "P-1", categoryId: category.json._id, inventoryCount: 5, purchasePrice: 10, wholesalePrice: 20, retailPrice: 30 },
  });
  const cash = await call(off, "POST", "/api/sellings", { body: sale(product.json._id, 30) });
  assert.equal(cash.status, 201);
  for (const doc of [
    await Category.findById(category.json._id).lean(),
    await Product.findById(product.json._id).lean(),
    await Selling.findById(cash.json._id).lean(),
    await Customer.findOne({}).lean(),
  ]) {
    for (const key of ["createdBy", "createdByName", "updatedBy", "updatedByName"]) assert.equal(key in doc, false, `${key} not set`);
  }
  for (const response of [product, cash]) assert.equal(/createdBy|updatedBy/.test(response.text), false, "not in the response either");
});

// ---- audit log -----------------------------------------------------------------------------

test("audit: entries for auth, users and business actions; filters, newest first; no secrets stored", skip, async () => {
  const owner = await setupOwner();
  await login("owner", "wrong-password");
  const ownerLogin = await login("owner", OWNER.password);
  const token = ownerLogin.json.token;
  const cashier = await addUser(token, { username: "cashier", role: "cashier" });
  await call(on, "PUT", `/api/users/${cashier.id}`, { token, body: { role: "storekeeper" } });
  await call(on, "PATCH", `/api/users/${cashier.id}/status`, { token, body: { isActive: false } });
  await call(on, "POST", `/api/users/${cashier.id}/reset-password`, { token, body: { newPassword: "reset-secret-9" } });
  const { productId } = await seedCatalog(token);
  const cash = await call(on, "POST", "/api/sellings", { token, body: sale(productId) });
  await call(on, "PUT", `/api/sellings/${cash.json._id}`, { token, body: { customerName: "عميل 2" } });
  const credit = await call(on, "POST", "/api/credit-sales", { token, body: sale(productId, 120, { customerPhone: "01000000020" }) });
  const cancellableCredit = await call(on, "POST", "/api/credit-sales", { token, body: sale(productId, 120, { customerPhone: "01000000021" }) });
  await call(on, "POST", `/api/credit-sales/${credit.json._id}/payments`, { token, body: { amount: 10 } });
  await call(on, "POST", "/api/returns", { token, body: { returnType: "credit", invoiceId: credit.json._id, items: [{ productId, quantity: 1, returnReason: "x" }] } });
  await call(on, "POST", `/api/products/${productId}/sync-purchase-price`, { token, body: {} });
  await call(on, "PUT", "/api/shop-profile", { token, body: { name: "متجر" } });
  await call(on, "POST", `/api/sellings/${cash.json._id}/cancel`, { token, body: { reason: "اختبار الإلغاء" } });
  await call(on, "POST", `/api/credit-sales/${cancellableCredit.json._id}/cancel`, { token, body: { reason: "اختبار الإلغاء" } });
  await call(on, "DELETE", `/api/products/${productId}`, { token });
  const changed = await call(on, "POST", "/api/auth/change-password", { token, body: { currentPassword: OWNER.password, newPassword: "changed-secret-1" } });
  const finalToken = changed.json.token;

  const page = await call(on, "GET", "/api/audit?limit=100", { token: finalToken });
  assert.equal(page.status, 200, page.text);
  const actions = page.json.data.map((entry) => entry.action);
  for (const action of [
    "auth.setup_owner", "auth.login_failed", "auth.login", "user.created", "user.updated", "user.status_changed",
    "user.password_reset", "sale.updated", "sale.cancelled", "credit.payment", "credit.returned", "credit.cancelled",
    "product.sync_purchase_price", "product.archived", "shop.updated", "auth.password_changed",
  ]) {
    assert.ok(actions.includes(action), `${action} is logged (got ${actions.join(", ")})`);
  }
  const times = page.json.data.map((entry) => new Date(entry.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  const failed = page.json.data.find((entry) => entry.action === "auth.login_failed");
  assert.deepEqual(failed.details, { username: "owner" });
  assert.equal(failed.userId, undefined, "a failed login names only the username");

  const filtered = await call(on, "GET", `/api/audit?action=user.created&userId=${owner.user._id}`, { token: finalToken });
  assert.equal(filtered.json.data.length, 1);
  assert.equal(filtered.json.pagination.totalItems, 1);
  const paged = await call(on, "GET", "/api/audit?limit=2&page=1", { token: finalToken });
  assert.equal(paged.json.data.length, 2);
  assert.equal(paged.json.pagination.hasNextPage, true);
  const future = await call(on, "GET", "/api/audit?from=2999-01-01", { token: finalToken });
  assert.equal(future.json.data.length, 0);

  const everything = JSON.stringify(await AuditLog.find({}).lean());
  for (const secret of [OWNER.password, "pass-1234", "reset-secret-9", "changed-secret-1", owner.recoveryCode, token, finalToken, "$2a$", "$2b$"]) {
    assert.equal(everything.includes(secret), false, `audit log never contains ${secret.slice(0, 6)}…`);
  }
  assert.equal(/password|hash|token|recovery/i.test(everything.replace(/auth\.password_changed|user\.password_reset/g, "")), false);
});

// ---- the switch ----------------------------------------------------------------------------

test("auth off: existing requests behave as before (no token, nothing stripped, new routes are 404)", skip, async () => {
  for (const url of ["/api/auth/bootstrap", "/api/users", "/api/audit"]) {
    assert.equal((await call(off, "GET", url)).status, 404, `${url} is not mounted`);
  }
  assert.equal((await call(off, "POST", "/api/auth/setup-owner", { body: OWNER })).status, 404);
  assert.equal(await User.countDocuments(), 0);

  const category = await call(off, "POST", "/api/categories", { body: { name: "تصنيف" } });
  assert.equal(category.status, 201);
  const product = await call(off, "POST", "/api/products", {
    body: { name: "منتج", code: "P-1", categoryId: category.json._id, inventoryCount: 5, purchasePrice: 10, wholesalePrice: 20, retailPrice: 30 },
  });
  assert.equal(product.status, 201);
  assert.equal(product.json.purchasePrice, 10, "nothing is stripped");
  const cash = await call(off, "POST", "/api/sellings", { body: sale(product.json._id, 30, { discountAmount: 2 }) });
  assert.equal(cash.status, 201, "discounts need no permission");
  const details = await call(off, "GET", `/api/sellings/${cash.json._id}`);
  assert.equal(details.json.items[0].purchasePrice, 10);
  assert.ok("totalProfit" in details.json);
  assert.equal((await call(off, "GET", "/api/products/profit-report")).status, 200);
  assert.equal((await call(off, "GET", "/api/dashboard/summary")).status, 200);
  assert.equal((await call(off, "PUT", "/api/shop-profile", { body: { name: "متجر" } })).status, 200);
  assert.equal(await AuditLog.countDocuments(), 0, "nothing is audited with auth off");
});

// ---- Stage 14: owner actions only from the main PC itself ---------------------------------

// The whole auth app behind an outer app that overrides req.ip, to simulate a client PC.
const withIp = async (ip) => {
  const outer = express();
  outer.use((req, _res, next) => {
    Object.defineProperty(req, "ip", { value: ip, configurable: true });
    next();
  });
  outer.use(appOn);
  return listen(outer);
};
const closeTarget = (target) => new Promise((resolve) => target.server.close(resolve));

test("stage 14: setup-owner and recover from loopback work (127.0.0.1, ::1, ::ffff:127.0.0.1)", skip, async () => {
  for (const ip of ["::1", "::ffff:127.0.0.1"]) {
    const target = await withIp(ip);
    try {
      const response = await call(target, "GET", "/api/auth/bootstrap");
      assert.equal(response.json.isLocal, true, ip);
    } finally {
      await closeTarget(target);
    }
  }
  const owner = await setupOwner(); // real 127.0.0.1
  const recovered = await call(on, "POST", "/api/auth/recover", {
    body: { username: OWNER.username, recoveryCode: owner.recoveryCode, newPassword: "recovered-pass" },
  });
  assert.equal(recovered.status, 200, recovered.text);
});

test("stage 14: setup-owner and recover from a non-loopback address get 403 LOCAL_ONLY; bootstrap isLocal is false", skip, async () => {
  const target = await withIp("192.168.1.20");
  try {
    const boot = await call(target, "GET", "/api/auth/bootstrap");
    assert.equal(boot.status, 200);
    assert.equal(boot.json.isLocal, false);
    assert.equal(boot.json.hasOwner, false);

    const setup = await call(target, "POST", "/api/auth/setup-owner", { body: OWNER });
    assert.equal(setup.status, 403);
    assert.equal(setup.json.code, "LOCAL_ONLY");
    assert.equal(await User.countDocuments(), 0, "no owner was created");

    const owner = await setupOwner(); // from the main PC
    const recover = await call(target, "POST", "/api/auth/recover", {
      body: { username: OWNER.username, recoveryCode: owner.recoveryCode, newPassword: "stolen-pass" },
    });
    assert.equal(recover.status, 403);
    assert.equal(recover.json.code, "LOCAL_ONLY");
    assert.equal((await login(OWNER.username, OWNER.password)).status, 200, "the password did not change");

    // Login itself still works from a client PC.
    const clientLogin = await call(target, "POST", "/api/auth/login", { body: { username: OWNER.username, password: OWNER.password } });
    assert.equal(clientLogin.status, 200);
  } finally {
    await closeTarget(target);
  }
});

test("stage 14: creating a product needs products.viewCost; a custom role with products.manage but no viewCost gets 403 on POST, 200 on PUT, and the stored purchasePrice is kept", skip, async () => {
  const owner = await setupOwner();
  const { categoryId, productId } = await seedCatalog(owner.token, { purchasePrice: 61 });
  const noCost = await addUser(owner.token, {
    username: "no-cost",
    role: "custom",
    permissions: ["products.view", "products.manage", "categories.manage"],
  });

  const created = await call(on, "POST", "/api/products", {
    token: noCost.token,
    body: { name: "بدون تكلفة", code: "NC-1", inventoryCount: 1, categoryId, wholesalePrice: 80, retailPrice: 100 },
  });
  assert.equal(created.status, 403);
  assert.equal(created.json.code, "FORBIDDEN");
  assert.equal(await Product.countDocuments({ code: "NC-1" }), 0, "nothing was created");

  const updated = await call(on, "PUT", `/api/products/${productId}`, {
    token: noCost.token,
    body: { name: "اسم جديد", retailPrice: 120 },
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.purchasePrice, undefined, "the response is stripped for this user");
  const stored = await Product.findById(productId).lean();
  assert.equal(stored.name, "اسم جديد");
  assert.equal(stored.purchasePrice, 61, "the stored purchase price is unchanged");

  // The owner (viewCost) still creates products as before.
  const byOwner = await call(on, "POST", "/api/products", {
    token: owner.token,
    body: { name: "بتكلفة", code: "OC-1", inventoryCount: 1, categoryId, wholesalePrice: 80, purchasePrice: 60, retailPrice: 100 },
  });
  assert.equal(byOwner.status, 201, byOwner.text);
});
