// Stage 15 integration tests against a real throwaway mongod (port 27096; see helpers/mongod.js):
// auto-lock setting, verify-password (+ lockout), token refresh, the restore cut-off
// (NOTA_SESSIONS_VALID_AFTER), a restored backup without users, the audit inbox, and the
// per-user max discount (cash and credit, create and edit).
process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const SECRET = "stage15-test-secret-0123456789abcdef";
const APP_PATH = path.join(__dirname, "..", "src", "app.js");
const ENV_KEYS = ["NOTA_AUTH", "NOTA_JWT_SECRET", "NOTA_LAN_MODE", "NOTA_LAN_SECRET", "NOTA_SESSIONS_VALID_AFTER"];

const loadApp = (env) => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  delete require.cache[APP_PATH];
  try {
    return require(APP_PATH);
  } finally {
    ENV_KEYS.forEach((key) => (saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key])));
  }
};

const appOn = loadApp({ NOTA_AUTH: "1", NOTA_JWT_SECRET: SECRET });
// The same database, as the backend restarted by the desktop app after a restore at RESTORED_AT.
const RESTORED_AT = Date.now() + 60 * 60 * 1000; // every token issued by the test "before" it
const appRestored = loadApp({ NOTA_AUTH: "1", NOTA_JWT_SECRET: SECRET, NOTA_SESSIONS_VALID_AFTER: String(RESTORED_AT) });

const { clearDatabase, mongodSkipReason, startMongod } = require("./helpers/mongod");
const User = require("../src/models/user.model");
const AuditLog = require("../src/models/auditLog.model");
const Selling = require("../src/models/selling.model");
const { drainAuditInbox } = require("../src/auth/auditInbox");

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

let stopMongod;
let on;
let restored;

test.before(async () => {
  if (mongodSkipReason) return;
  stopMongod = await startMongod({ port: 27096 });
  on = await listen(appOn);
  restored = await listen(appRestored);
});

test.after(async () => {
  for (const target of [on, restored]) if (target) await new Promise((resolve) => target.server.close(resolve));
  if (stopMongod) await stopMongod();
});

test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase();
  appOn.locals.auth.loginLimiter.reset();
});

const call = async (target, method, url, { token, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${target.base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (204)
  }
  return { status: response.status, json, text };
};

const OWNER = { name: "صاحب المحل", username: "owner", password: "owner-pass-1" };

const setupOwner = async () => {
  const response = await call(on, "POST", "/api/auth/setup-owner", { body: OWNER });
  assert.equal(response.status, 201, response.text);
  return response.json;
};

const login = (username, password) => call(on, "POST", "/api/auth/login", { body: { username, password } });

const addUser = async (ownerToken, { username, role, permissions, maxDiscountPercent, password = "pass-1234" }) => {
  const created = await call(on, "POST", "/api/users", {
    token: ownerToken,
    body: { name: username, username, password, role, permissions, maxDiscountPercent },
  });
  assert.equal(created.status, 201, created.text);
  const session = await login(username, password);
  assert.equal(session.status, 200, session.text);
  return { id: created.json.user._id, token: session.json.token, user: session.json.user };
};

const seedProduct = async (token) => {
  const category = await call(on, "POST", "/api/categories", { token, body: { name: "تصنيف" } });
  assert.equal(category.status, 201, category.text);
  const product = await call(on, "POST", "/api/products", {
    token,
    body: { name: "منتج", code: "P-1", categoryId: category.json._id, inventoryCount: 100, purchasePrice: 50, wholesalePrice: 90, retailPrice: 100 },
  });
  assert.equal(product.status, 201, product.text);
  return product.json._id;
};

const today = new Date().toISOString().slice(0, 10);
let phone = 200;
const sale = (productId, extra = {}) => {
  phone += 1;
  return { customerName: "عميل", customerPhone: `01000000${phone}`, sellingDate: today, items: [{ productId, quantity: 1, price: 100 }], ...extra };
};

const skip = { skip: mongodSkipReason };

// ---- auto-lock setting ------------------------------------------------------------------------

test("shop profile: autoLockMinutes defaults to 10, accepts 0/5/10/15/30/60, rejects others, kept when not sent; any user reads it", skip, async () => {
  const owner = await setupOwner();
  const cashier = await addUser(owner.token, { username: "cashier", role: "cashier" });

  let response = await call(on, "GET", "/api/shop-profile", { token: cashier.token });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.autoLockMinutes, 10, "default before anything is saved");

  const base = { name: "محل", phones: [] };
  response = await call(on, "PUT", "/api/shop-profile", { token: owner.token, body: base });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.autoLockMinutes, 10, "default on the first save");

  for (const minutes of [0, 5, 15, 30, 60, 10]) {
    response = await call(on, "PUT", "/api/shop-profile", { token: owner.token, body: { ...base, autoLockMinutes: minutes } });
    assert.equal(response.status, 200, `${minutes}: ${response.text}`);
    assert.equal(response.json.autoLockMinutes, minutes);
  }
  for (const bad of [7, -5, 120, "abc", null, ""]) {
    response = await call(on, "PUT", "/api/shop-profile", { token: owner.token, body: { ...base, autoLockMinutes: bad } });
    assert.equal(response.status, 400, `${JSON.stringify(bad)} is refused`);
  }

  await call(on, "PUT", "/api/shop-profile", { token: owner.token, body: { ...base, autoLockMinutes: 30 } });
  response = await call(on, "PUT", "/api/shop-profile", { token: owner.token, body: { ...base, address: "شارع" } });
  assert.equal(response.json.autoLockMinutes, 30, "not sent → kept");
  response = await call(on, "GET", "/api/shop-profile", { token: cashier.token });
  assert.equal(response.json.autoLockMinutes, 30, "read back by a cashier");

  response = await call(on, "PUT", "/api/shop-profile", { token: cashier.token, body: { ...base, autoLockMinutes: 0 } });
  assert.equal(response.status, 403, "changing it needs shop.manage");
});

// ---- verify-password ----------------------------------------------------------------------------

test("verify-password: 204 when right (token unchanged), 400 WRONG_PASSWORD when wrong, needs login", skip, async () => {
  const owner = await setupOwner();
  let response = await call(on, "POST", "/api/auth/verify-password", { token: owner.token, body: { password: OWNER.password } });
  assert.equal(response.status, 204, response.text);
  assert.equal(response.text, "");

  response = await call(on, "POST", "/api/auth/verify-password", { token: owner.token, body: { password: "wrong" } });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "WRONG_PASSWORD");

  response = await call(on, "POST", "/api/auth/verify-password", { body: { password: OWNER.password } });
  assert.equal(response.status, 401);
  assert.equal(response.json.code, "SESSION_EXPIRED");

  // The same token still works afterwards.
  assert.equal((await call(on, "GET", "/api/auth/me", { token: owner.token })).status, 200);
  const failed = await AuditLog.countDocuments({ action: "auth.unlock_failed" });
  assert.equal(failed, 1);
});

test("verify-password: 5 wrong → 429 LOGIN_LOCKED (same lockout as login, per username + IP); the session is not ended", skip, async () => {
  const owner = await setupOwner();
  const wrong = () => call(on, "POST", "/api/auth/verify-password", { token: owner.token, body: { password: "nope" } });
  for (let i = 0; i < 4; i++) assert.equal((await wrong()).status, 400);
  const fifth = await wrong();
  assert.equal(fifth.status, 429);
  assert.equal(fifth.json.code, "LOGIN_LOCKED");
  // Locked: even the right password is refused now, and login from this IP too (shared counter).
  const right = await call(on, "POST", "/api/auth/verify-password", { token: owner.token, body: { password: OWNER.password } });
  assert.equal(right.status, 429);
  assert.equal((await login(OWNER.username, OWNER.password)).status, 429);
  // The session itself is still valid.
  assert.equal((await call(on, "GET", "/api/auth/me", { token: owner.token })).status, 200);
});

// ---- refresh ------------------------------------------------------------------------------------

test("refresh: a valid token gets a new 12h token; an old tokenVersion or an expired token gets 401", skip, async () => {
  const owner = await setupOwner();
  const decodedOld = jwt.decode(owner.token);

  await new Promise((resolve) => setTimeout(resolve, 1100)); // a later iat
  let response = await call(on, "POST", "/api/auth/refresh", { token: owner.token });
  assert.equal(response.status, 200, response.text);
  const fresh = jwt.verify(response.json.token, SECRET);
  assert.equal(fresh.sub, decodedOld.sub);
  assert.equal(fresh.tv, decodedOld.tv);
  assert.ok(fresh.exp > decodedOld.exp, "a later expiry");
  assert.equal(fresh.exp - fresh.iat, 12 * 60 * 60);
  assert.equal((await call(on, "GET", "/api/auth/me", { token: response.json.token })).status, 200);

  // Old tokenVersion (password changed elsewhere) → 401, and it cannot refresh.
  const changed = await call(on, "POST", "/api/auth/change-password", {
    token: owner.token,
    body: { currentPassword: OWNER.password, newPassword: "owner-pass-2" },
  });
  assert.equal(changed.status, 200, changed.text);
  response = await call(on, "POST", "/api/auth/refresh", { token: owner.token });
  assert.equal(response.status, 401);
  assert.equal(response.json.code, "SESSION_EXPIRED");

  // Expired token (same secret, same tokenVersion) → 401.
  const user = await User.findOne({ username: OWNER.username }).lean();
  const expired = jwt.sign({ sub: String(user._id), tv: user.tokenVersion, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: "HS256" });
  response = await call(on, "POST", "/api/auth/refresh", { token: expired });
  assert.equal(response.status, 401);
  assert.equal(response.json.code, "SESSION_EXPIRED");
});

// ---- restore ------------------------------------------------------------------------------------

test("after a restore (NOTA_SESSIONS_VALID_AFTER): older tokens get 401 SESSION_EXPIRED reason DATA_RESTORED; a new login works", skip, async () => {
  const owner = await setupOwner();
  // The backend restarted after the restore: the old token is refused with the restore reason.
  let response = await call(restored, "GET", "/api/auth/me", { token: owner.token });
  assert.equal(response.status, 401);
  assert.equal(response.json.code, "SESSION_EXPIRED");
  assert.equal(response.json.reason, "DATA_RESTORED");
  assert.match(response.json.message, /تم استرجاع النسخة/);
  // ...and cannot refresh itself past the cut-off.
  assert.equal((await call(restored, "POST", "/api/auth/refresh", { token: owner.token })).status, 401);

  // A token issued after the cut-off works (simulated: iat after RESTORED_AT).
  const user = await User.findOne({ username: OWNER.username }).lean();
  const later = jwt.sign({ sub: String(user._id), tv: user.tokenVersion, iat: Math.floor(RESTORED_AT / 1000) + 1 }, SECRET, {
    algorithm: "HS256",
    expiresIn: "12h",
  });
  response = await call(restored, "GET", "/api/auth/me", { token: later });
  assert.equal(response.status, 200, response.text);
  // Login itself is public, so the sign-in screen works after a restore.
  assert.equal((await call(restored, "POST", "/api/auth/login", { body: { username: OWNER.username, password: OWNER.password } })).status, 200);
});

test("a restored backup with users: bootstrap reports an owner (login screen); without users (pre-Stage 13): first-run owner screen", skip, async () => {
  await setupOwner();
  let response = await call(restored, "GET", "/api/auth/bootstrap");
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.hasOwner, true, JSON.stringify(response.json));

  // A backup made before Stage 13 has no users collection at all.
  await User.collection.drop();
  response = await call(restored, "GET", "/api/auth/bootstrap");
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.hasOwner, false, JSON.stringify(response.json));
  // The main PC (loopback) can create the owner again.
  assert.equal((await call(restored, "POST", "/api/auth/setup-owner", { body: OWNER })).status, 201);
});

// ---- audit inbox --------------------------------------------------------------------------------

test("audit inbox: backup.created / backup.restored / backup.restore_failed lines become audit entries; paths and unknown actions are dropped", skip, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nota-inbox-"));
  const file = path.join(dir, "audit-inbox.jsonl");
  const userId = "6aec5163155ae0405e6b1d67";
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ action: "backup.created", userId, userName: "صاحب المحل", file: "C:\\Users\\me\\Documents\\nota-backup-2026-11-05_101010.archive.gz", at: "2026-11-05T08:10:10Z" }),
      JSON.stringify({ action: "backup.restored", userId, userName: "صاحب المحل", file: "/home/x/nota-backup-old.archive.gz" }),
      JSON.stringify({ action: "backup.restore_failed", userName: "صاحب المحل", file: "bad.archive.gz", code: "RESTORE_FAILED", error: "boom", password: "secret" }),
      JSON.stringify({ action: "user.created", userName: "intruder" }),
      "not json",
      "",
    ].join("\n")
  );
  assert.equal(await drainAuditInbox(file), 3);
  assert.equal(fs.existsSync(file), false, "the inbox is deleted");
  assert.equal(await drainAuditInbox(file), 0, "a missing inbox is fine");

  const entries = await AuditLog.find({ entity: "Backup" }).sort({ action: 1 }).lean();
  assert.deepEqual(entries.map((e) => e.action), ["backup.created", "backup.restore_failed", "backup.restored"]);
  const created = entries[0];
  assert.equal(created.details.file, "nota-backup-2026-11-05_101010.archive.gz", "base name only");
  assert.equal(String(created.userId), userId);
  assert.equal(created.userName, "صاحب المحل");
  assert.equal(created.at.toISOString(), "2026-11-05T08:10:10.000Z");
  assert.equal(entries[2].details.file, "nota-backup-old.archive.gz");
  assert.equal(entries[1].details.code, "RESTORE_FAILED");
  assert.ok(!JSON.stringify(entries).includes("secret"), "no secrets");
  assert.ok(!JSON.stringify(entries).includes("Documents"), "no folder paths");
  assert.equal(await AuditLog.countDocuments({ action: "user.created" }), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- max discount ------------------------------------------------------------------------------

test("users: maxDiscountPercent is stored, returned by /me, cleared with null, validated 0–100, never on the owner", skip, async () => {
  const owner = await setupOwner();
  const manager = await addUser(owner.token, { username: "manager", role: "manager", maxDiscountPercent: 10 });
  assert.equal(manager.user.maxDiscountPercent, 10);
  let me = await call(on, "GET", "/api/auth/me", { token: manager.token });
  assert.equal(me.json.user.maxDiscountPercent, 10);

  let response = await call(on, "PUT", `/api/users/${manager.id}`, { token: owner.token, body: { maxDiscountPercent: 12.5 } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.user.maxDiscountPercent, 12.5);
  me = await call(on, "GET", "/api/auth/me", { token: manager.token });
  assert.equal(me.status, 200, "changing the limit does not log the user out");

  for (const bad of [-1, 101, "abc", true]) {
    response = await call(on, "PUT", `/api/users/${manager.id}`, { token: owner.token, body: { maxDiscountPercent: bad } });
    assert.equal(response.status, 400, `${JSON.stringify(bad)} is refused`);
  }
  response = await call(on, "PUT", `/api/users/${manager.id}`, { token: owner.token, body: { maxDiscountPercent: null } });
  assert.equal(response.status, 200);
  assert.equal(response.json.user.maxDiscountPercent, undefined, "null clears the limit");

  const ownerId = (await User.findOne({ role: "owner" }).lean())._id;
  response = await call(on, "PUT", `/api/users/${ownerId}`, { token: owner.token, body: { maxDiscountPercent: 5 } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.user.maxDiscountPercent, undefined, "the owner has no limit");

  // A manager with users.manage? Template managers do not have it; a custom admin with a limit
  // cannot raise its own or give a higher one.
  const admin = await addUser(owner.token, {
    username: "admin",
    role: "custom",
    permissions: ["users.manage", "sales.view", "sales.create", "sales.discount"],
    maxDiscountPercent: 10,
  });
  response = await call(on, "PUT", `/api/users/${admin.id}`, { token: admin.token, body: { maxDiscountPercent: 50 } });
  assert.equal(response.status, 400, "not your own limit");
  response = await call(on, "POST", "/api/users", {
    token: admin.token,
    body: { name: "x", username: "x1", password: "pass-1234", role: "custom", permissions: ["sales.view", "sales.discount"], maxDiscountPercent: 20 },
  });
  assert.equal(response.status, 403, "not higher than your own");
  response = await call(on, "POST", "/api/users", {
    token: admin.token,
    body: { name: "x", username: "x2", password: "pass-1234", role: "custom", permissions: ["sales.view", "sales.discount"], maxDiscountPercent: 5 },
  });
  assert.equal(response.status, 201, response.text);
});

test("max discount on create (cash and credit): under / at / over the limit, 0.01 rounding tolerance, no limit, owner", skip, async () => {
  const owner = await setupOwner();
  const productId = await seedProduct(owner.token);
  const limited = await addUser(owner.token, { username: "manager", role: "manager", maxDiscountPercent: 10 });
  const free = await addUser(owner.token, { username: "manager2", role: "manager" });

  for (const kind of ["sellings", "credit-sales"]) {
    const post = (token, extra) => call(on, "POST", `/api/${kind}`, { token, body: sale(productId, extra) });
    let response = await post(limited.token, { discountAmount: 5 });
    assert.equal(response.status, 201, `${kind} under: ${response.text}`);
    response = await post(limited.token, { discountAmount: 10 });
    assert.equal(response.status, 201, `${kind} at the limit: ${response.text}`);
    response = await post(limited.token, { items: [{ productId, quantity: 3, price: 33.33 }], discountAmount: 10 });
    assert.equal(response.status, 201, `${kind} 10.001 % passes with the 0.01 tolerance: ${response.text}`);
    response = await post(limited.token, { discountAmount: 15 });
    assert.equal(response.status, 403, `${kind} over`);
    assert.equal(response.json.code, "DISCOUNT_LIMIT");
    assert.equal(response.json.message, "أقصى خصم مسموح لك 10٪");
    assert.equal(response.json.maxDiscountPercent, 10);
    response = await post(limited.token, { discountPercentage: 20 });
    assert.equal(response.status, 403, `${kind} a percentage over the limit`);
    response = await post(free.token, { discountAmount: 40 });
    assert.equal(response.status, 201, `${kind} no limit: ${response.text}`);
    response = await post(owner.token, { discountAmount: 60 });
    assert.equal(response.status, 201, `${kind} owner: ${response.text}`);
  }
  // Nothing was saved for the refused ones (2 kinds × 5 accepted).
  assert.equal(await Selling.countDocuments(), 5);
});

test("max discount on edits: only a new or changed discount is judged (cash and credit)", skip, async () => {
  const owner = await setupOwner();
  const productId = await seedProduct(owner.token);
  const limited = await addUser(owner.token, {
    username: "editor",
    role: "custom",
    permissions: ["sales.view", "sales.create", "sales.edit", "sales.discount", "credit.view", "credit.create", "credit.edit"],
    maxDiscountPercent: 10,
  });

  for (const kind of ["sellings", "credit-sales"]) {
    // The owner gave 30 % before the limit mattered.
    const created = await call(on, "POST", `/api/${kind}`, { token: owner.token, body: sale(productId, { discountAmount: 30 }) });
    assert.equal(created.status, 201, created.text);
    const put = (body) => call(on, "PUT", `/api/${kind}/${created.json._id}`, { token: limited.token, body });

    let response = await put({ customerName: "عميل آخر" });
    assert.equal(response.status, 200, `${kind}: an edit that keeps the stored discount: ${response.text}`);
    response = await put({ discountAmount: 30 });
    assert.equal(response.status, 200, `${kind}: the same stored amount is not a new discount`);
    response = await put({ discountAmount: 25 });
    assert.equal(response.status, 403, `${kind}: a changed discount over the limit`);
    assert.equal(response.json.code, "DISCOUNT_LIMIT");
    response = await put({ discountAmount: 8 });
    assert.equal(response.status, 200, `${kind}: changed within the limit: ${response.text}`);
    response = await put({ items: [{ productId, quantity: 2, price: 100 }], discountAmount: 20 });
    assert.equal(response.status, 200, `${kind}: 20 of 200 = 10 %: ${response.text}`);
    response = await put({ items: [{ productId, quantity: 2, price: 100 }], discountAmount: 21 });
    assert.equal(response.status, 403, `${kind}: 21 of 200 = 10.5 %`);
    response = await put({ discountAmount: 0 });
    assert.equal(response.status, 200, `${kind}: removing it is always fine`);
  }
});
