// Online Stage 6A tests: Web Push subscriptions, the new-order push (fake sender), the phone home summary.
// Real throwaway mongod (port 27126, replica set: transactions are required).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage6a-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage6a-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const Counter = require("../src/models/counter.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const PushSubscription = require("../src/models/pushSubscription.model");
const User = require("../src/models/user.model");
const pushService = require("../src/push/pushService");
const { runMigrations } = require("../src/migrations");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHONE = "01012345678";
let categorySeq = 0; let phoneSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27126 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { pushService.setSender(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset(); pushService.setSender(null);
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s6-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s6-owner", password: "owner-pass-123" } })).json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text };
}
const staff = (method, path, body, token = ownerToken, headers) => call(method, path, { token, body, headers });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };
const uuid = () => require("node:crypto").randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeStaff(username, role, permissions) {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
}
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function seedProduct() {
  const category = ok(await staff("POST", "/api/categories", { name: `فئة ${++categorySeq}`, image: PNG_URI }), 201);
  const categoryId = category._id || category.id || category.category?._id;
  ok(await staff("PUT", `/api/website/categories/${categoryId}`, { visibility: "show", sortOrder: 1 }));
  const created = ok(await staff("POST", "/api/products", { name: "منتج", code: "P1", categoryId, inventoryCount: 50, purchasePrice: 50, wholesalePrice: 60, retailPrice: 100, image: PNG_URI }), 201);
  const id = created._id || created.product?._id;
  ok(await staff("PUT", `/api/website/products/${id}`, { visibility: "show", description: "وصف", images: [PNG_URI] }));
  return id;
}
async function shop() {
  await startLedger();
  ok(await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر" }));
  const productId = await seedProduct();
  const zone = ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة" }), 201);
  return { productId, zoneId: zone.id };
}
const placeRaw = (productId, zoneId, extra = {}) => call("POST", "/api/store/orders", {
  body: { items: [{ productId, qty: 2 }], zoneId, idempotencyKey: uuid(), contact: { name: "عميل سري", phone: PHONE, address: "شارع سري 1", notes: "" }, ...extra },
});
const subBody = (name = "a") => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: `p256-${name}`, auth: `auth-${name}` } });

// ---------------------------------------------------------------------------------------------------------------------

it("push subscriptions: any signed-in user, validated, own only, re-assigned on the same endpoint", async () => {
  assert.equal((await call("POST", "/api/push/subscribe", { body: subBody() })).status, 401);
  assert.equal((await call("GET", "/api/push/public-key")).status, 401);
  const cashier = await makeStaff("s6-cashier", "cashier");
  const manager = await makeStaff("s6-manager", "manager");

  assert.equal((await staff("POST", "/api/push/subscribe", { endpoint: "http://insecure.example/x", keys: { p256dh: "a", auth: "b" } }, cashier)).status, 400);
  assert.equal((await staff("POST", "/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a" } }, cashier)).status, 400);
  assert.equal((await staff("POST", "/api/push/subscribe", {}, cashier)).status, 400);

  ok(await staff("POST", "/api/push/subscribe", subBody("one"), cashier, { "X-Nota-Device-Id": "web-aaaaaaaaaaaaaaaa" }), 201);
  ok(await staff("POST", "/api/push/subscribe", subBody("one"), cashier), 201);
  assert.equal(await PushSubscription.countDocuments({}), 1, "the endpoint is unique");

  // Another user cannot delete it.
  const foreign = ok(await staff("DELETE", "/api/push/subscribe", { endpoint: subBody("one").endpoint }, manager));
  assert.equal(foreign.removed, 0);
  assert.equal(await PushSubscription.countDocuments({}), 1);

  // The same browser signs in as someone else: the row moves to them.
  ok(await staff("POST", "/api/push/subscribe", subBody("one"), manager), 201);
  const row = await PushSubscription.findOne({}).lean();
  assert.equal(String(row.user), String((await User.findOne({ username: "s6-manager" }).lean())._id));

  assert.equal(ok(await staff("DELETE", "/api/push/subscribe", { endpoint: subBody("one").endpoint }, manager)).removed, 1);
  assert.equal(await PushSubscription.countDocuments({}), 0);
});

it("push endpoints: only https on the known push services (no IPs, localhost, look-alikes, ports, credentials)", async () => {
  const keys = { p256dh: "a", auth: "b" };
  const post = (endpoint) => staff("POST", "/api/push/subscribe", { endpoint, keys });
  const accepted = [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QAbc",
    "https://api.push.apple.com/3/device/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://autopush.push.services.mozilla.com/wpush/v2/abc",
    "https://db5p.notify.windows.com/w/?token=abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://FCM.GoogleAPIs.com/fcm/send/upper",
  ];
  for (const endpoint of accepted) assert.equal((await post(endpoint)).status, 201, endpoint);
  const refused = [
    "http://fcm.googleapis.com/fcm/send/abc", // not https
    "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://169.254.169.254/latest",
    "https://localhost/x", "https://localhost.localdomain/x",
    "https://fcm.googleapis.com.evil.com/x", // look-alikes
    "https://evilfcm.googleapis.com/x",
    "https://fcm-googleapis.com/x",
    "https://push.apple.com.evil.com/x",
    "https://notify.windows.com/x", // the bare suffix has no leading label
    "https://evilnotify.windows.com.attacker.io/x",
    "https://fcm.googleapis.com@evil.com/x", // credentials trick: the real host is evil.com
    "https://evil.com@fcm.googleapis.com/x", // credentials are refused too
    "https://fcm.googleapis.com:8443/x", // non-default port
    "https://push.example.com/x",
  ];
  for (const endpoint of refused) {
    const response = await post(endpoint);
    assert.equal(response.status, 400, endpoint);
    assert.equal(response.json.code, "INVALID_SUBSCRIPTION", endpoint);
  }
  assert.equal(await PushSubscription.countDocuments({}), accepted.length, "only the accepted endpoints were stored");
});

it("order list rows carry itemsCount (pieces, read-only)", async () => {
  const { productId, zoneId } = await shop();
  ok(await placeRaw(productId, zoneId), 201); // qty 2
  const list = ok(await staff("GET", "/api/orders?status=new"));
  assert.equal(list.data[0].itemsCount, 2);
});

it("public key: disabled without VAPID keys, served with them", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.NOTA_VAPID_PUBLIC_KEY; delete process.env.NOTA_VAPID_PRIVATE_KEY; delete process.env.NOTA_VAPID_SUBJECT;
    assert.deepEqual(ok(await staff("GET", "/api/push/public-key")), { enabled: false });
    process.env.NOTA_VAPID_PUBLIC_KEY = "PUB"; process.env.NOTA_VAPID_PRIVATE_KEY = "PRIV"; process.env.NOTA_VAPID_SUBJECT = "mailto:a@b.c";
    assert.deepEqual(ok(await staff("GET", "/api/push/public-key")), { enabled: true, publicKey: "PUB" });
    assert.ok(!JSON.stringify(ok(await staff("GET", "/api/push/public-key"))).includes("PRIV"));
  } finally {
    for (const key of ["NOTA_VAPID_PUBLIC_KEY", "NOTA_VAPID_PRIVATE_KEY", "NOTA_VAPID_SUBJECT"]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

it("a new website order pushes to active users with orders.view only, with no personal data in the payload", async () => {
  const { productId, zoneId } = await shop();
  const viewerToken = await makeStaff("s6-viewer", "custom", ["orders.view"]);
  const noViewToken = await makeStaff("s6-noview", "custom", ["products.view"]);
  const inactiveToken = await makeStaff("s6-inactive", "custom", ["orders.view"]);
  for (const [name, token] of [["owner", ownerToken], ["viewer", viewerToken], ["noview", noViewToken], ["inactive", inactiveToken]]) {
    ok(await staff("POST", "/api/push/subscribe", subBody(name), token), 201);
  }
  await User.updateOne({ username: "s6-inactive" }, { $set: { isActive: false } });

  const sent = [];
  pushService.setSender(async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, payload }); });
  const placed = ok(await placeRaw(productId, zoneId), 201);
  for (let i = 0; i < 40 && sent.length < 2; i += 1) await sleep(50);
  await sleep(100);

  assert.deepEqual(sent.map((row) => row.endpoint).sort(), [subBody("owner").endpoint, subBody("viewer").endpoint].sort());
  const parsed = JSON.parse(sent[0].payload);
  assert.equal(parsed.notification.title, `طلب جديد #${placed.number}`);
  assert.equal(parsed.notification.body, "230 ج.م · توصيل");
  assert.equal(parsed.notification.data.url, `/admin/orders/${placed.id}`);
  const raw = sent[0].payload;
  for (const secret of ["عميل سري", PHONE, "شارع سري"]) assert.ok(!raw.includes(secret), `payload must not contain ${secret}`);
  assert.ok((await PushSubscription.findOne({ endpoint: subBody("owner").endpoint }).lean()).lastSuccessAt);

  // A replay with the same idempotency key creates nothing new and pushes nothing.
  sent.length = 0;
  const key = uuid();
  ok(await placeRaw(productId, zoneId, { idempotencyKey: key }), 201);
  await sleep(300); sent.length = 0;
  ok(await placeRaw(productId, zoneId, { idempotencyKey: key }), 200);
  await sleep(300);
  assert.equal(sent.length, 0);
});

it("a 410 removes the subscription; a failing or slow push never fails or delays the order", async () => {
  const { productId, zoneId } = await shop();
  ok(await staff("POST", "/api/push/subscribe", subBody("gone")), 201);
  pushService.setSender(async () => { const error = new Error("gone"); error.statusCode = 410; throw error; });
  ok(await placeRaw(productId, zoneId), 201);
  for (let i = 0; i < 40 && await PushSubscription.countDocuments({}) > 0; i += 1) await sleep(50);
  assert.equal(await PushSubscription.countDocuments({}), 0);

  ok(await staff("POST", "/api/push/subscribe", subBody("boom")), 201);
  pushService.setSender(async () => { throw new Error("push service down"); });
  ok(await placeRaw(productId, zoneId), 201);
  await sleep(200);
  assert.equal(await PushSubscription.countDocuments({}), 1, "other errors keep the subscription");

  pushService.setSender(() => new Promise(() => {})); // never answers
  const started = Date.now();
  ok(await placeRaw(productId, zoneId), 201);
  assert.ok(Date.now() - started < 3000, "the order does not wait for the push");
});

it("mobile summary: read-only, filtered by permission, website vs shop split", async () => {
  const { productId, zoneId } = await shop();
  const courier = ok(await staff("POST", "/api/couriers", { name: "أحمد", phone: `0100000${String(++phoneSeq).padStart(4, "0")}` }), 201);
  const placed = ok(await placeRaw(productId, zoneId), 201);
  ok(await staff("POST", `/api/orders/${placed.id}/confirm`, {}));
  ok(await staff("POST", `/api/orders/${placed.id}/prepare`, {}));
  ok(await staff("POST", `/api/orders/${placed.id}/dispatch`, { courierId: courier.id }));

  const full = ok(await staff("GET", "/api/dashboard/mobile-summary"));
  assert.equal(full.today.total, 230);
  assert.equal(full.today.website, 230);
  assert.equal(full.today.shop, 0);
  assert.equal(typeof full.cashDrawer, "number");

  // The courier hands the money in: it sits in the courier's box. The drawer is the shop's boxes only, so it stays out.
  ok(await staff("POST", `/api/orders/${placed.id}/deliver`, {}));
  const boxes = ok(await staff("GET", "/api/cashbox/boxes"));
  assert.equal(boxes.cashTotal, 230, "the cashbox page counts every active cash box");
  const afterDeliver = ok(await staff("GET", "/api/dashboard/mobile-summary"));
  assert.equal(afterDeliver.cashDrawer, 0, "a courier's box is not in the shop's drawer");
  const main = boxes.data.find((box) => box.isMain);
  ok(await staff("POST", "/api/cashbox/transfers", { fromBoxId: String(boxes.data.find((box) => String(box._id) === String(courier.boxId))._id), toBoxId: String(main._id), amount: 230 }), 201);
  assert.equal(ok(await staff("GET", "/api/dashboard/mobile-summary")).cashDrawer, 230, "after the courier hands it to the main box it is in the drawer");

  const dashOnly = await makeStaff("s6-dash", "custom", ["dashboard.view"]);
  const partial = ok(await staff("GET", "/api/dashboard/mobile-summary", undefined, dashOnly));
  assert.equal(partial.today.total, 230);
  assert.equal(partial.today.website, undefined);
  assert.equal(partial.cashDrawer, undefined);

  const nothing = await makeStaff("s6-none", "custom", ["orders.view"]);
  assert.deepEqual(ok(await staff("GET", "/api/dashboard/mobile-summary", undefined, nothing)), {});

  assert.equal((await staff("POST", "/api/dashboard/mobile-summary", {})).status, 404, "GET only");
  assert.equal((await call("GET", "/api/dashboard/mobile-summary")).status, 401);
});
