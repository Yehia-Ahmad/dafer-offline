// Online Stage 5B tests: POST /api/store/orders/quote prices an order exactly like placing it and creates nothing.
// Real throwaway mongod (port 27125, replica set).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage5b-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage5b-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = require("../src/app");
const Counter = require("../src/models/counter.model");
const WebOrder = require("../src/models/webOrder.model");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHONE = "01012345678";
let categorySeq = 0; let codeSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27125 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s5b-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s5b-owner", password: "owner-pass-123" } })).json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, route, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text };
}
const staff = (method, route, body) => call(method, route, { token: ownerToken, body });
const store = (method, route, body, token) => call(method, route, { token, body });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };
const uuid = () => require("node:crypto").randomUUID();

async function seedProduct({ name = "منتج", stock = 50, retail = 100, discount = 0 } = {}) {
  const category = ok(await staff("POST", "/api/categories", { name: `فئة ${name} ${++categorySeq}`, image: PNG_URI }), 201);
  const categoryId = category._id || category.id || category.category?._id;
  ok(await staff("PUT", `/api/website/categories/${categoryId}`, { visibility: "show", sortOrder: 1 }));
  const created = ok(await staff("POST", "/api/products", {
    name, code: `Q${++codeSeq}`, categoryId, inventoryCount: stock, purchasePrice: 50, wholesalePrice: 60, retailPrice: retail,
    ...(discount ? { discountPercentage: discount } : {}), image: PNG_URI,
  }), 201);
  const id = created._id || created.product?._id;
  ok(await staff("PUT", `/api/website/products/${id}`, { visibility: "show", description: "وصف", images: [PNG_URI] }));
  return id;
}
const putSettings = (body) => staff("PUT", "/api/website/settings", body);
const openSite = async (extra = {}) => ok(await putSettings({ enabled: true, orderingEnabled: true, title: "متجر", ...extra }));
const seedZone = async (extra = {}) => ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة", ...extra }), 201);
const contact = { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" };
const placeBody = (items, zoneId, extra = {}) => ({ items, zoneId, idempotencyKey: uuid(), contact, ...extra });
const quoteBody = (items, zoneId, extra = {}) => ({ items, zoneId, ...extra });
const quote = (body, token) => store("POST", "/api/store/orders/quote", body, token);
const placeRaw = (body, token) => store("POST", "/api/store/orders", body, token);

const TOTAL_KEYS = ["deliveryFee", "fulfillment", "items", "paymentMethod", "subtotal", "total", "vat", "zone"];
const ITEM_KEYS = ["discountPercentage", "lineTotal", "name", "productId", "qty", "unitPrice", "vat"];

it("quote gives the same totals as placing the same order, with an exact whitelist", async () => {
  await openSite();
  const product = await seedProduct({ retail: 100, discount: 10 });
  const zone = await seedZone();
  const items = [{ productId: product, qty: 3 }];

  const quoted = ok(await quote(quoteBody(items, zone.id || zone._id)));
  assert.deepEqual(Object.keys(quoted).sort(), TOTAL_KEYS);
  assert.deepEqual(Object.keys(quoted.items[0]).sort(), ITEM_KEYS);
  assert.deepEqual(quoted.zone, { name: "القاهرة", fee: 30 });

  const placed = ok(await placeRaw(placeBody(items, zone.id || zone._id)), 201);
  assert.equal(quoted.subtotal, placed.subtotal);
  assert.equal(quoted.vat, placed.vat);
  assert.equal(quoted.deliveryFee, placed.deliveryFee);
  assert.equal(quoted.total, placed.total);
  assert.equal(quoted.subtotal, 270, "server price: 100 less 10% x 3");
});

it("quote creates nothing: no order, no document number, and the same request can be quoted again", async () => {
  await openSite();
  const product = await seedProduct();
  const zone = await seedZone();
  const counters = await Counter.find({}).lean();
  const body = quoteBody([{ productId: product, qty: 2 }], zone.id || zone._id);
  ok(await quote(body)); ok(await quote(body));
  assert.equal(await WebOrder.countDocuments({}), 0);
  assert.deepEqual(await Counter.find({}).lean(), counters, "the document counters did not move");
  // the first real order still gets the first number
  const placed = ok(await placeRaw(placeBody([{ productId: product, qty: 1 }], zone.id || zone._id)), 201);
  assert.ok(placed.number);
  assert.equal(await WebOrder.countDocuments({}), 1);
});

it("quote does not need an idempotency key or contact, and ignores client prices", async () => {
  await openSite();
  const product = await seedProduct({ retail: 100 });
  const zone = await seedZone();
  const quoted = ok(await quote({ items: [{ productId: product, qty: 1, price: 1, unitPrice: 1 }], zoneId: zone.id || zone._id, total: 1 }));
  assert.equal(quoted.total, 130);
});

it("quote: pickup has no zone and no fee; free delivery and the minimum order follow the settings", async () => {
  await openSite({ fulfillment: { delivery: true, pickup: true }, freeDeliveryFrom: 200, minOrderAmount: 50 });
  const product = await seedProduct({ retail: 100 });
  const zone = await seedZone();
  const zoneId = zone.id || zone._id;

  const pickup = ok(await quote({ items: [{ productId: product, qty: 1 }], fulfillment: "pickup" }));
  assert.equal(pickup.fulfillment, "pickup"); assert.equal(pickup.deliveryFee, 0); assert.equal(pickup.zone, null); assert.equal(pickup.total, 100);

  assert.equal(ok(await quote(quoteBody([{ productId: product, qty: 1 }], zoneId))).deliveryFee, 30);
  assert.equal(ok(await quote(quoteBody([{ productId: product, qty: 2 }], zoneId))).deliveryFee, 0, "free from 200");

  ok(await putSettings({ minOrderAmount: 500 }));
  const refused = await quote(quoteBody([{ productId: product, qty: 1 }], zoneId));
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "MIN_ORDER_NOT_REACHED"); assert.equal(refused.json.minOrderAmount, 500);
});

it("quote reports line problems exactly like placing (409 ORDER_ITEMS_INVALID with lines)", async () => {
  await openSite();
  const product = await seedProduct({ stock: 3 });
  const zone = await seedZone();
  const zoneId = zone.id || zone._id;
  const missing = "0123456789abcdef01234567";
  const items = [{ productId: product, qty: 5 }, { productId: missing, qty: 1 }];

  const quoted = await quote(quoteBody(items, zoneId));
  const placed = await placeRaw(placeBody(items, zoneId));
  assert.equal(quoted.status, 409); assert.equal(placed.status, 409);
  assert.equal(quoted.json.code, "ORDER_ITEMS_INVALID");
  assert.deepEqual(quoted.json.lines, placed.json.lines);
  assert.deepEqual(quoted.json.lines.map((row) => row.reason).sort(), ["not_available", "quantity_exceeds_stock"]);
  assert.equal(quoted.json.lines.find((row) => row.reason === "quantity_exceeds_stock").max, 3);
});

it("quote validates the request like placing: bad items, duplicates, quantity, zone, fulfillment, payment", async () => {
  await openSite();
  const product = await seedProduct();
  const zone = await seedZone();
  const zoneId = zone.id || zone._id;
  const bad = async (body, code) => { const r = await quote(body); assert.equal(r.status, 400, r.text); assert.equal(r.json.code, code); };
  await bad(quoteBody([], zoneId), "INVALID_ITEMS");
  await bad(quoteBody([{ productId: "nope", qty: 1 }], zoneId), "INVALID_ITEMS");
  await bad(quoteBody([{ productId: product, qty: 1 }, { productId: product, qty: 1 }], zoneId), "DUPLICATE_PRODUCT");
  await bad(quoteBody([{ productId: product, qty: 0 }], zoneId), "INVALID_QTY");
  await bad(quoteBody([{ productId: product, qty: 1 }], undefined), "INVALID_ZONE");
  await bad(quoteBody([{ productId: product, qty: 1 }], zoneId, { fulfillment: "drone" }), "INVALID_FULFILLMENT");
  await bad(quoteBody([{ productId: product, qty: 1 }], zoneId, { paymentMethod: "bitcoin" }), "INVALID_PAYMENT_METHOD");
  await bad(quoteBody([{ productId: product, qty: 1 }], zoneId, { addressId: "0123456789abcdef01234567" }), "INVALID_ADDRESS");
  assert.equal((await quote(quoteBody([{ productId: product, qty: 1 }], "0123456789abcdef01234567"))).json.code, "ZONE_UNAVAILABLE");
  assert.equal((await quote(quoteBody([{ productId: product, qty: 1 }], zoneId, { paymentMethod: "instapay" }))).json.code, "PAYMENT_UNAVAILABLE", "wallet not enabled");
  assert.equal((await quote({ items: [{ productId: product, qty: 1 }], fulfillment: "pickup" })).json.code, "FULFILLMENT_UNAVAILABLE", "pickup not enabled");
});

it("quote follows the closed website and ordering-off rules", async () => {
  const product = await seedProduct();
  const zone = await seedZone();
  const body = quoteBody([{ productId: product, qty: 1 }], zone.id || zone._id);
  await openSite({ enabled: false, closedMessage: "رجعنالكم قريب" });
  const closed = await quote(body);
  assert.equal(closed.status, 503); assert.equal(closed.json.code, "STORE_CLOSED"); assert.equal(closed.json.closedMessage, "رجعنالكم قريب");
  await openSite({ enabled: true, orderingEnabled: false });
  const off = await quote(body);
  assert.equal(off.status, 409); assert.equal(off.json.code, "ORDERING_DISABLED");
});

it("quote for a signed-in customer accepts a saved address; a guest cannot use one", async () => {
  await openSite();
  const product = await seedProduct({ retail: 100 });
  const zone = await seedZone();
  const zoneId = zone.id || zone._id;
  const registered = ok(await store("POST", "/api/store/auth/register", { name: "عميلة", phone: "01099998888", password: "password-123" }), 201);
  const address = ok(await store("POST", "/api/store/me/addresses", { label: "البيت", zoneId, address: "شارع النيل" }, registered.token), 201);
  const addressId = address.id || (address.addresses && address.addresses[0].id) || (address.address && address.address.id);
  assert.ok(addressId, JSON.stringify(address));
  const body = quoteBody([{ productId: product, qty: 1 }], zoneId, { addressId });
  assert.equal(ok(await quote(body, registered.token)).total, 130);
  assert.equal((await quote(body)).json.code, "INVALID_ADDRESS");
  assert.equal((await quote(body, "not-a-token")).status, 401);
});

it("quote keeps the 64kb body limit and placing is unchanged by the refactor", async () => {
  await openSite();
  const product = await seedProduct();
  const zone = await seedZone();
  const big = await quote({ items: [{ productId: product, qty: 1 }], zoneId: zone.id || zone._id, pad: "x".repeat(70 * 1024) });
  assert.equal(big.status, 413);
  const body = placeBody([{ productId: product, qty: 2 }], zone.id || zone._id);
  const first = ok(await placeRaw(body), 201);
  const replay = ok(await placeRaw(body), 200);
  assert.equal(first.number, replay.number); assert.equal(first.trackingToken, replay.trackingToken);
  assert.equal(await WebOrder.countDocuments({}), 1);
  assert.equal((await placeRaw({ ...body, idempotencyKey: "nope" })).json.code, "INVALID_IDEMPOTENCY_KEY", "placing still requires the key");
  assert.equal((await placeRaw({ ...body, idempotencyKey: uuid(), contact: {} })).json.code, "INVALID_CONTACT", "placing still requires the contact");
});

// nginx cannot run in a Node test: check the template text. The quote has its own, looser limit zone (it is called on every
// cart / zone / payment change) so it does not eat the order zone's 10 requests a minute.
it("nginx: the quote and the order each have a POST-only rate limit zone on their own exact location", () => {
  const templates = path.join(__dirname, "..", "..", "deploy", "templates");
  const zones = fs.readFileSync(path.join(templates, "nginx-ratelimit.conf"), "utf8");
  const site = fs.readFileSync(path.join(templates, "nginx-nota.conf.template"), "utf8");
  assert.match(zones, /limit_req_zone\s+\$nota_login_key\s+zone=nota_store_quote:10m\s+rate=60r\/m/);
  assert.match(site, /location = \/api\/store\/orders\/quote\s*\{[^}]*limit_req zone=nota_store_quote burst=20 nodelay;[^}]*proxy_pass/s);
  assert.match(site, /location = \/api\/store\/orders\s*\{[^}]*limit_req zone=nota_store_order burst=5 nodelay;/s);
});

// Regex locations win over plain prefix locations, so a storefront hashed-file regex would catch /admin/media/<font>-<HASH>.woff2.
// `^~` on the admin and API prefixes stops the regex search (checked with a real nginx 1.24 by the reviewer).
it("nginx: /admin/ and /api/ are ^~ prefixes, the admin hashed-file rule is nested inside, and both rules cover the same asset types", () => {
  const site = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "templates", "nginx-nota.conf.template"), "utf8");
  const TYPES = "js|css|woff2|woff|ttf|eot|svg|png";
  assert.match(site, /location \^~ \/api\/ \{/);
  assert.match(site, /location \^~ \/api\/store\/ \{/);
  assert.doesNotMatch(site, /location \/api\/(store\/)? \{/, "no plain /api/ prefix is left for a regex to beat");
  assert.doesNotMatch(site, /location \/admin\/ \{/, "no plain /admin/ prefix is left for a regex to beat");
  // the admin block, with its nested regex location, and no other top-level admin regex
  const admin = /location \^~ \/admin\/ \{([\s\S]*?\n    \})/.exec(site);
  assert.ok(admin, "location ^~ /admin/ exists");
  assert.match(admin[1], /try_files \$uri \$uri\/ \/admin\/index\.html;/);
  assert.ok(admin[1].includes(`location ~ "^/admin/.+-[A-Z0-9]{8}\\.(${TYPES})$" {`), "nested admin hashed-file rule with every asset type");
  assert.match(admin[1], /immutable[\s\S]*try_files \$uri =404;/);
  assert.doesNotMatch(site.replace(admin[0], ""), /\^\/admin\//, "the admin regex is only inside the ^~ block");
  // the storefront rule has the same types and is the only other hashed-file regex
  assert.ok(site.includes(`location ~ "^/.+-[A-Z0-9]{8}\\.(${TYPES})$" {`), "storefront hashed-file rule with every asset type");
  // the entry page stays no-store and the exact locations are untouched
  assert.match(site, /location = \/admin\/index\.html \{\s*add_header Cache-Control "no-store" always;/);
  for (const exact of ["/api/auth/login", "/api/store/orders", "/api/store/orders/quote", "/api/store/auth/login", "/api/store/auth/register", "/health"]) {
    assert.ok(site.includes(`location = ${exact} {`), `exact location ${exact}`);
  }
});
