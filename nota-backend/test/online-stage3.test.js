// Online Stage 3 tests: the customer website backend (/api/store), website settings, delivery zones, customer accounts and
// placing orders. Real throwaway mongod (port 27110, replica set: transactions are required).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage3-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage3-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");

const app = require("../src/app");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const DeliveryZone = require("../src/models/deliveryZone.model");
const Meta = require("../src/models/meta.model");
const Account = require("../src/models/account.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Product = require("../src/models/product.model");
const Selling = require("../src/models/selling.model");
const StoreCustomer = require("../src/models/storeCustomer.model");
const WebOrder = require("../src/models/webOrder.model");
const { migrations, runMigrations } = require("../src/migrations");
const { signToken } = require("../src/auth/jwt");
const { signStoreToken } = require("../src/auth/storeJwt");
const { normalizeStorePhone } = require("../src/utils/storePhone");
const { storeSlug } = require("../src/utils/storeSlug");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_URI = `data:image/png;base64,${PNG}`;
const PHONE = "01012345678";
let categorySeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27110 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s3-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s3-owner", password: "owner-pass-123" } })).json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return response;
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}
const staff = (method, path, body, token = ownerToken) => call(method, path, { token, body });
const store = (method, path, body, token) => call(method, path, { token, body });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };

const uuid = () => require("node:crypto").randomUUID();

async function makeStaff(username, role) {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
}

/** A category + product through the real admin API, then shown on the website with website.manage. */
async function seedProduct({ name = "منتج", code = "P1", stock = 50, retail = 100, discount = 0, wholesale = Math.min(60, retail), cost = Math.min(50, wholesale), visible = true, categoryVisible = true, image = PNG_URI, categoryId, exempt = false, lowStockThreshold } = {}) {
  let category = categoryId;
  if (!category) {
    const created = ok(await staff("POST", "/api/categories", { name: `فئة ${name} ${++categorySeq}`, image: PNG_URI }), 201);
    category = created._id || created.id || created.category?._id;
    if (categoryVisible) ok(await staff("PUT", `/api/website/categories/${category}`, { visible: true, sortOrder: 1 }));
  }
  const created = ok(await staff("POST", "/api/products", {
    name, code, categoryId: category, inventoryCount: stock, purchasePrice: cost, wholesalePrice: wholesale, retailPrice: retail,
    ...(discount ? { discountPercentage: discount } : {}), ...(image ? { image } : {}), ...(exempt ? { vatExempt: true } : {}),
    ...(lowStockThreshold !== undefined ? { lowStockThreshold } : {}),
  }), 201);
  const id = created._id || created.product?._id;
  if (visible) ok(await staff("PUT", `/api/website/products/${id}`, { visible: true, description: "وصف", images: [PNG_URI] }));
  return { id, category };
}
async function openSite(extra = {}) {
  return ok(await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر", ...extra }));
}
async function seedZone(extra = {}) {
  return ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة", ...extra }), 201);
}
const orderBody = (items, zoneId, extra = {}) => ({ items, zoneId, idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" }, ...extra });
async function register(phone = PHONE, name = "عميل") {
  return ok(await store("POST", "/api/store/auth/register", { name, phone, password: "customer-pass-1" }), 201);
}

// ---------------------------------------------------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set([
  "purchasePrice", "wholesalePrice", "profit", "profitAmount", "totalProfit", "inventoryCount", "soldItemCount", "lowStockThreshold",
  "createdBy", "updatedBy", "isArchived", "archivedAt", "archivedBy", "code", "passwordHash", "tokenVersion", "isActive", "requestHash",
  "idempotencyKey", "trackingTokenHash", "storeCustomer", "__v", "specifications", "taxNumber", "commercialRegister", "invoiceFooter", "vatExempt",
]);
const walk = (value, visit, path = "$") => {
  if (Array.isArray(value)) return value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { visit(key, `${path}.${key}`); walk(item, visit, `${path}.${key}`); }
  }
};
const assertClean = (response, label) => {
  assert.ok(response.json !== null || response.status === 204, `${label}: JSON body`);
  walk(response.json, (key, path) => assert.ok(!FORBIDDEN_KEYS.has(key), `${label}: forbidden key ${path}`));
  assert.ok(!/base64|data:image/i.test(response.text || ""), `${label}: no base64 in JSON`);
};

it("every public response contains only whitelisted fields (walk the JSON, fail on any forbidden key)", async () => {
  const { id, category } = await seedProduct({ code: "SECRET-CODE-77", name: "هاتف" });
  await seedProduct({ code: "ARCH-1", name: "مؤرشف", categoryId: category });
  await Product.updateOne({ code: "ARCH-1" }, { $set: { isArchived: true } });
  await seedProduct({ code: "HID-1", name: "مخفي", categoryId: category, visible: false });
  await openSite({ about: "نبذة", whatsapp: "01012345678", facebook: "https://facebook.com/shop", banners: [{ image: PNG_URI, linkType: "category", linkId: category }], featuredCategoryIds: [category] });
  const zone = await seedZone();
  const customer = await register();
  const auth = customer.token;
  ok(await store("POST", "/api/store/me/addresses", { label: "البيت", address: "شارع 5", zoneId: zone.id }, auth), 201);
  const placed = ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 2 }], zone.id), auth), 201);

  const responses = {
    settings: await store("GET", "/api/store/settings"),
    categories: await store("GET", "/api/store/categories"),
    products: await store("GET", "/api/store/products"),
    product: await store("GET", `/api/store/products/${id}`),
    zones: await store("GET", "/api/store/delivery-zones"),
    placed: { json: placed, text: JSON.stringify(placed), status: 201 },
    tracking: await store("GET", `/api/store/orders/track/${placed.trackingToken}`),
    me: await store("GET", "/api/store/me", undefined, auth),
    addresses: await store("GET", "/api/store/me/addresses", undefined, auth),
    myOrders: await store("GET", "/api/store/me/orders", undefined, auth),
    myOrder: await store("GET", `/api/store/me/orders/${placed.id}`, undefined, auth),
    login: await store("POST", "/api/store/auth/login", { phone: PHONE, password: "customer-pass-1" }),
  };
  for (const [label, response] of Object.entries(responses)) { assert.equal(response.status < 300, true, `${label} ${response.status} ${response.text}`); assertClean(response, label); }
  // the product code is internal: its value never appears anywhere
  for (const [label, response] of Object.entries(responses)) assert.ok(!response.text.includes("SECRET-CODE-77"), `${label}: no product code`);
  assert.deepEqual(responses.products.json.data.map((p) => p.name), ["هاتف"]);
  assert.deepEqual(Object.keys(responses.product.json).sort(), ["availability", "category", "description", "discountPercentage", "finalPrice", "id", "images", "maxOrderQty", "name", "price", "slug"]);
  assert.deepEqual(Object.keys(responses.tracking.json).sort(), ["createdAt", "deliveryFee", "items", "number", "paymentMethod", "status", "subtotal", "total", "vat", "zone"]);
  assert.equal(responses.tracking.json.contact, undefined);
});

it("hidden, archived and hidden-category products are invisible everywhere in the public API, images included", async () => {
  await openSite();
  const shown = await seedProduct({ code: "SHOWN", name: "ظاهر" });
  const hidden = await seedProduct({ code: "HIDDEN", name: "مخفي", visible: false, categoryId: shown.category });
  const archived = await seedProduct({ code: "ARCHIVED", name: "مؤرشف", categoryId: shown.category });
  await Product.updateOne({ _id: archived.id }, { $set: { isArchived: true } });
  const hiddenCategory = await seedProduct({ code: "HCAT", name: "فئة مخفية", categoryVisible: false });

  const list = ok(await store("GET", "/api/store/products?limit=48"));
  assert.deepEqual(list.data.map((p) => p.id), [shown.id]);
  for (const product of [hidden, archived, hiddenCategory]) {
    assert.equal((await store("GET", `/api/store/products/${product.id}`)).status, 404);
    assert.equal((await store("GET", `/api/store/images/product/${product.id}/0`)).status, 404);
    assert.equal((await store("GET", `/api/store/images/product/${product.id}/1`)).status, 404);
  }
  assert.equal((await store("GET", `/api/store/images/category/${hiddenCategory.category}`)).status, 404);
  assert.equal((await store("GET", `/api/store/products?category=${hiddenCategory.category}`)).json.data.length, 0);
  const categories = ok(await store("GET", "/api/store/categories")).data;
  assert.deepEqual(categories.map((c) => c.id), [shown.category]);
  assert.equal(categories[0].productCount, 1);
  // a missing id answers exactly like a hidden one
  const missing = await store("GET", `/api/store/products/${"a".repeat(24)}`);
  const hiddenAnswer = await store("GET", `/api/store/products/${hidden.id}`);
  assert.deepEqual([missing.status, missing.json], [hiddenAnswer.status, hiddenAnswer.json]);
  // none of them can be ordered
  const zone = await seedZone();
  const attempt = await store("POST", "/api/store/orders", orderBody([{ productId: hidden.id, qty: 1 }, { productId: archived.id, qty: 1 }], zone.id));
  assert.equal(attempt.status, 409);
  assert.deepEqual(attempt.json.lines.map((line) => line.reason), ["not_available", "not_available"]);
});

it("catalog: pagination limit, sorting, search, availability and maxOrderQty never show the stock number", async () => {
  await openSite();
  const first = await seedProduct({ code: "C1", name: "بطارية", retail: 300, discount: 10, stock: 3 });
  await seedProduct({ code: "C2", name: "شاحن", retail: 50, stock: 200, categoryId: first.category });
  await seedProduct({ code: "C3", name: "كابل", retail: 120, stock: 0, categoryId: first.category });
  const byPrice = ok(await store("GET", "/api/store/products?sort=price-asc")).data;
  assert.deepEqual(byPrice.map((p) => p.finalPrice), [50, 120, 270]);
  assert.deepEqual(ok(await store("GET", "/api/store/products?sort=price-desc")).data.map((p) => p.finalPrice), [270, 120, 50]);
  assert.deepEqual(ok(await store("GET", `/api/store/products?q=${encodeURIComponent("شاح")}`)).data.map((p) => p.name), ["شاحن"]);
  const page = ok(await store("GET", "/api/store/products?limit=2&page=2&sort=name"));
  assert.equal(page.data.length, 1); assert.equal(page.pagination.totalItems, 3);
  assert.equal(ok(await store("GET", "/api/store/products?limit=500")).pagination.limit, 12, "an over-limit value falls back to the default (max 48)");
  const battery = byPrice.find((p) => p.name === "بطارية");
  assert.equal(battery.availability, "low"); assert.equal(battery.maxOrderQty, 3); assert.equal(battery.price, 300); assert.equal(battery.discountPercentage, 10);
  assert.equal(byPrice.find((p) => p.name === "شاحن").availability, "in_stock");
  assert.equal(byPrice.find((p) => p.name === "شاحن").maxOrderQty, 99);
  const cable = byPrice.find((p) => p.name === "كابل");
  assert.equal(cable.availability, "out_of_stock"); assert.equal(cable.maxOrderQty, 0);
  assert.equal((await store("GET", "/api/store/products?sort=bogus")).status, 400);
});

it("images: binary with a strong ETag, 304 on a match, long cache, versioned URLs, never base64 in JSON", async () => {
  await openSite();
  const { id } = await seedProduct({ code: "IMG1" });
  const product = ok(await store("GET", `/api/store/products/${id}`));
  assert.equal(product.images.length, 2, "main image + one website image");
  assert.match(product.images[0], new RegExp(`^/api/store/images/product/${id}/0\\?v=\\d+$`));
  const first = await call("GET", product.images[0], { raw: true });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.equal(first.headers.get("cache-control"), "public, max-age=86400");
  const etag = first.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{40}"$/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), Buffer.from(PNG, "base64"));
  const again = await call("GET", product.images[0], { raw: true, headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await call("GET", `/api/store/images/product/${id}/2`, { raw: true })).status, 404);
  const before = product.images[0];
  await staff("PUT", `/api/website/products/${id}`, { images: [PNG_URI, PNG_URI] });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.notEqual(ok(await store("GET", `/api/store/products/${id}`)).images[0], before, "a changed product gets a new ?v=");
  // SVG (script-capable) is never served
  await Product.updateOne({ _id: id }, { $set: { image: `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)/>").toString("base64")}` } });
  assert.equal((await call("GET", `/api/store/images/product/${id}/0`, { raw: true })).status, 404);
});

it("order totals are computed on the server: extra client fields (price, total, discount, fee) are ignored", async () => {
  await openSite();
  const { id } = await seedProduct({ code: "T1", retail: 200, discount: 25 }); // final price 150
  const zone = await seedZone({ fee: 30 });
  const body = orderBody([{ productId: id, qty: 2, price: 1, unitPrice: 1, discount: 99, total: 1, lineTotal: 1, vat: 77 }], zone.id, {
    price: 1, total: 1, subtotal: 1, discount: 99, discountAmount: 99, deliveryFee: 0, fee: 0, vat: 0, zone: { fee: 0 }, status: "delivered",
  });
  const placed = ok(await store("POST", "/api/store/orders", body), 201);
  assert.equal(placed.subtotal, 300); assert.equal(placed.deliveryFee, 30); assert.equal(placed.total, 330); assert.equal(placed.status, "new");
  assert.match(placed.number, /^W-000001$/);
  const stored = await WebOrder.findById(placed.id).lean();
  assert.equal(stored.items[0].unitPrice, 150); assert.equal(stored.items[0].lineTotal, 300); assert.equal(stored.items[0].retailPrice, 200);
  assert.equal(stored.source, "website"); assert.equal(stored.paymentMethod, "cod"); assert.equal(stored.statusHistory[0].status, "new");
  assert.equal(stored.zone.fee, 30);
  // the snapshot is never recalculated: later price and zone changes do not touch it
  await Product.updateOne({ _id: id }, { $set: { retailPrice: 999 } }); await DeliveryZone.updateOne({ _id: zone.id }, { $set: { fee: 5 } });
  const tracked = ok(await store("GET", `/api/store/orders/track/${placed.trackingToken}`));
  assert.equal(tracked.total, 330); assert.equal(tracked.items[0].unitPrice, 150);
  // stock is neither reserved nor deducted at placement
  assert.equal((await Product.findById(id).lean()).inventoryCount, 50);
  // order numbers come from their own counter, apart from the invoices
  assert.equal((await Counter.findById("W").lean()).seq, 1);
  assert.equal(await Counter.exists({ _id: "INV" }), null);
});

async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const enableVat = async ({ rate = 14, includes = true } = {}) => ok(await staff("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: true, rate, pricesIncludeVat: includes } }));

for (const includes of [true, false]) {
  it(`VAT on order lines matches what a cash sale of the same lines computes (prices ${includes ? "include" : "exclude"} VAT)`, async () => {
    await startLedger();
    await enableVat({ includes });
    await openSite();
    const a = await seedProduct({ code: "V1", name: "أ", retail: 100, discount: 10, stock: 100 }); // 90
    const b = await seedProduct({ code: "V2", name: "ب", retail: 33.33, stock: 100, categoryId: a.category }); // 33.33
    const c = await seedProduct({ code: "V3", name: "ج", retail: 65, stock: 100, categoryId: a.category, exempt: true });
    const zone = await seedZone({ fee: 25 });
    const lines = [{ productId: a.id, qty: 4 }, { productId: b.id, qty: 3 }, { productId: c.id, qty: 2 }];
    const placed = ok(await store("POST", "/api/store/orders", orderBody(lines, zone.id)), 201);
    const order = await WebOrder.findById(placed.id).lean();

    const price = (id) => order.items.find((item) => String(item.productId) === id).unitPrice;
    const sale = ok(await staff("POST", "/api/sellings", {
      customerName: "نقدي", customerPhone: "01017171718", sellingDate: new Date().toISOString().slice(0, 10),
      // Online Stage 4 (decision 9): the delivery fee is part of the sale's VAT base, so the comparison sale carries it as shippingFees.
      shippingFees: order.deliveryFee,
      items: lines.map((line) => ({ productId: line.productId, quantity: line.qty, price: price(line.productId) })),
    }), 201);
    const saved = await Selling.findById(sale._id).lean();
    assert.equal(order.vat, saved.vatAmount, "invoice VAT");
    assert.equal(order.vatRate, saved.vatRate); assert.equal(order.vatIncluded, saved.vatIncluded);
    assert.deepEqual(order.items.map((item) => item.vat), saved.items.map((item) => item.vatAmount), "VAT per line");
    assert.equal(Math.round(order.total * 100), Math.round(saved.totalPrice * 100), "order total = sale total (delivery fee included)");
    assert.equal(order.vatIncluded, includes);
    // the product page shows VAT the way the shop sets it
    const product = ok(await store("GET", `/api/store/products/${a.id}`));
    assert.deepEqual(product.vat, { rate: 14, included: includes, exempt: false });
    assert.equal(ok(await store("GET", `/api/store/products/${c.id}`)).vat.rate, 0);
    assert.deepEqual(ok(await store("GET", "/api/store/settings")).vat, { rate: 14, pricesIncludeVat: includes });
  });
}

it("no VAT block when the shop has VAT off", async () => {
  await openSite();
  const { id } = await seedProduct({ code: "NV1" });
  assert.equal(ok(await store("GET", `/api/store/products/${id}`)).vat, undefined);
  assert.equal(ok(await store("GET", "/api/store/settings")).vat, null);
});

it("free delivery threshold, minimum order, inactive zone, quantity over stock, duplicates and too many lines", async () => {
  await openSite({ freeDeliveryFrom: 500, minOrderAmount: 100 });
  const { id, category } = await seedProduct({ code: "R1", retail: 100, stock: 10 });
  const other = await seedProduct({ code: "R2", name: "آخر", retail: 10, stock: 100, categoryId: category });
  const zone = await seedZone({ fee: 40 });
  const place = (items, extra, token) => store("POST", "/api/store/orders", orderBody(items, extra?.zoneId || zone.id, extra), token);

  assert.equal(ok(await place([{ productId: id, qty: 4 }]), 201).deliveryFee, 40, "400 < 500: fee applies");
  assert.equal(ok(await place([{ productId: id, qty: 5 }]), 201).deliveryFee, 0, "500 reached: free delivery");
  assert.equal(ok(await place([{ productId: id, qty: 6 }]), 201).total, 600, "free delivery above the threshold");

  const small = await place([{ productId: other.id, qty: 9 }]);
  assert.equal(small.status, 409); assert.equal(small.json.code, "MIN_ORDER_NOT_REACHED"); assert.equal(small.json.minOrderAmount, 100);
  assert.equal((await place([{ productId: other.id, qty: 10 }])).status, 201, "exactly the minimum is allowed");

  const over = await place([{ productId: id, qty: 11 }, { productId: other.id, qty: 1 }]);
  assert.equal(over.status, 409); assert.equal(over.json.code, "ORDER_ITEMS_INVALID");
  assert.deepEqual(over.json.lines, [{ productId: id, reason: "quantity_exceeds_stock", max: 10 }]);

  await staff("PUT", `/api/website/delivery-zones/${zone.id}`, { isActive: false });
  const inactive = await place([{ productId: id, qty: 1 }]);
  assert.equal(inactive.status, 409); assert.equal(inactive.json.code, "ZONE_UNAVAILABLE");
  assert.equal((await store("GET", "/api/store/delivery-zones")).json.data.length, 0, "inactive zones are not public");
  await staff("PUT", `/api/website/delivery-zones/${zone.id}`, { isActive: true });

  assert.equal((await place([{ productId: id, qty: 1 }, { productId: id, qty: 2 }])).json.code, "DUPLICATE_PRODUCT");
  assert.equal((await place(Array.from({ length: 51 }, () => ({ productId: id, qty: 1 })))).status, 400);
  assert.equal((await place([])).status, 400);
  for (const qty of [0, 100, 1.5, "2", -1]) assert.equal((await place([{ productId: id, qty }])).status, 400, `qty ${qty}`);
  assert.equal((await place([{ productId: "nope", qty: 1 }])).status, 400);
  assert.equal((await store("POST", "/api/store/orders", { ...orderBody([{ productId: id, qty: 1 }], zone.id), idempotencyKey: "not-a-uuid" })).status, 400);
  assert.equal((await store("POST", "/api/store/orders", { ...orderBody([{ productId: id, qty: 1 }], zone.id), contact: { name: "x", phone: "123", address: "y" } })).json.code, "INVALID_PHONE");
  assert.equal((await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], "a".repeat(24)))).json.code, "ZONE_UNAVAILABLE");
});

it("idempotency: the same key twice gives one order; parallel requests with the same key give one order", async () => {
  await openSite();
  const { id } = await seedProduct({ code: "I1", retail: 10 });
  const zone = await seedZone();
  const body = orderBody([{ productId: id, qty: 1 }], zone.id);
  const first = await store("POST", "/api/store/orders", body);
  const second = await store("POST", "/api/store/orders", body);
  assert.equal(first.status, 201); assert.equal(second.status, 200);
  assert.deepEqual(second.json, first.json, "the same answer, tracking token included");
  assert.equal(await WebOrder.countDocuments(), 1);

  const parallel = orderBody([{ productId: id, qty: 1 }], zone.id);
  const results = await Promise.all(Array.from({ length: 6 }, () => store("POST", "/api/store/orders", parallel)));
  assert.ok(results.every((result) => result.status === 200 || result.status === 201), results.map((r) => r.status).join());
  assert.equal(results.filter((result) => result.status === 201).length, 1, "exactly one creator");
  assert.equal(new Set(results.map((result) => result.json.number)).size, 1);
  assert.equal(await WebOrder.countDocuments(), 2);
  assert.equal((await Counter.findById("W").lean()).seq, 2, "no number is burnt by a retry");

  // the same key with a different request is refused, not silently answered with the first order
  const reused = await store("POST", "/api/store/orders", { ...body, items: [{ productId: id, qty: 2 }] });
  assert.equal(reused.status, 409); assert.equal(reused.json.code, "IDEMPOTENCY_MISMATCH");
  assert.equal(await WebOrder.countDocuments(), 2);
});

it("customer tokens are rejected by every staff route and staff tokens by every customer route", async () => {
  await openSite();
  const customer = await register();
  const customerToken = customer.token;
  for (const [method, path] of [["GET", "/api/products"], ["GET", "/api/auth/me"], ["GET", "/api/website/settings"], ["GET", "/api/users"], ["GET", "/api/shop-profile"], ["POST", "/api/sellings"]]) {
    const response = await call(method, path, { token: customerToken, body: method === "POST" ? {} : undefined });
    assert.equal(response.status, 401, `${method} ${path} with a customer token`);
  }
  for (const [method, path] of [["GET", "/api/store/me"], ["PUT", "/api/store/me"], ["GET", "/api/store/me/addresses"], ["POST", "/api/store/me/addresses"], ["GET", "/api/store/me/orders"], ["GET", `/api/store/me/orders/${"a".repeat(24)}`], ["POST", `/api/store/me/orders/${"a".repeat(24)}/cancel`]]) {
    const response = await call(method, path, { token: ownerToken, body: method === "GET" ? undefined : {} });
    assert.equal(response.status, 401, `${method} ${path} with a staff token`);
  }
  // a staff token on the optional-auth order route is refused too (never treated as a guest by mistake)
  const zone = await seedZone(); const { id } = await seedProduct({ code: "K1" });
  assert.equal((await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id), ownerToken)).status, 401);
  // same secret but no audience, and the staff secret, are refused
  const noAudience = jwt.sign({ sub: customer.customer.id, tv: 0 }, process.env.NOTA_STORE_JWT_SECRET, { algorithm: "HS256" });
  assert.equal((await store("GET", "/api/store/me", undefined, noAudience)).status, 401);
  const wrongSecret = jwt.sign({ sub: customer.customer.id, tv: 0 }, process.env.NOTA_JWT_SECRET, { algorithm: "HS256", audience: "nota-store" });
  assert.equal((await store("GET", "/api/store/me", undefined, wrongSecret)).status, 401);
  // a staff-shaped token signed with the staff secret for a real user id is still no customer
  const user = signToken({ _id: customer.customer.id, tokenVersion: 0 }, process.env.NOTA_JWT_SECRET);
  assert.equal((await store("GET", "/api/store/me", undefined, user)).status, 401);
  assert.equal((await store("GET", "/api/store/me", undefined, customerToken)).status, 200);
  // a disabled customer loses the session at once
  await StoreCustomer.updateOne({ _id: customer.customer.id }, { $set: { isActive: false } });
  assert.equal((await store("GET", "/api/store/me", undefined, customerToken)).status, 401);
});

it("a customer cannot read or cancel another customer's order; cancel works only while the order is new", async () => {
  await openSite();
  const { id } = await seedProduct({ code: "O1" }); const zone = await seedZone();
  const alice = await register("01011111111", "أليس"); const bob = await register("01022222222", "بوب");
  const aliceOrder = ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id), alice.token), 201);
  assert.equal((await store("GET", `/api/store/me/orders/${aliceOrder.id}`, undefined, bob.token)).status, 404);
  assert.equal((await store("POST", `/api/store/me/orders/${aliceOrder.id}/cancel`, {}, bob.token)).status, 404);
  assert.equal((await WebOrder.findById(aliceOrder.id).lean()).status, "new");
  assert.equal(ok(await store("GET", "/api/store/me/orders", undefined, bob.token)).data.length, 0);
  assert.equal(ok(await store("GET", "/api/store/me/orders", undefined, alice.token)).data.length, 1);
  assert.equal(ok(await store("GET", `/api/store/me/orders/${aliceOrder.id}`, undefined, alice.token)).contact.address, "شارع 1");

  const cancelled = ok(await store("POST", `/api/store/me/orders/${aliceOrder.id}/cancel`, {}, alice.token));
  assert.equal(cancelled.status, "cancelled"); assert.deepEqual(cancelled.statusHistory.map((row) => row.status), ["new", "cancelled"]);
  assert.equal((await store("POST", `/api/store/me/orders/${aliceOrder.id}/cancel`, {}, alice.token)).status, 409, "no second cancel");
  const confirmed = ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id), alice.token), 201);
  await WebOrder.updateOne({ _id: confirmed.id }, { $set: { status: "confirmed" } });
  assert.equal((await store("POST", `/api/store/me/orders/${confirmed.id}/cancel`, {}, alice.token)).json.code, "NOT_CANCELLABLE");
  // stock is untouched by every order and cancel
  assert.equal((await Product.findById(id).lean()).inventoryCount, 50);
  // a guest order has no owner: nobody's "my orders" shows it
  const guest = ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id)), 201);
  assert.equal((await store("GET", `/api/store/me/orders/${guest.id}`, undefined, alice.token)).status, 404);
});

it("tracking token: shows only the allowed fields and an unknown or guessed token is a plain 404", async () => {
  await openSite();
  const { id } = await seedProduct({ code: "TR1" }); const zone = await seedZone();
  const placed = ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id)), 201);
  const tracked = ok(await store("GET", `/api/store/orders/track/${placed.trackingToken}`));
  assert.deepEqual(Object.keys(tracked.zone).sort(), ["fee", "name"]);
  assert.deepEqual(Object.keys(tracked.items[0]).sort(), ["discountPercentage", "lineTotal", "name", "productId", "qty", "unitPrice", "vat"]);
  assert.ok(!tracked.text, "no raw text field");
  assert.ok(!JSON.stringify(tracked).includes(PHONE), "no phone number");
  assert.equal((await store("GET", "/api/store/orders/track/nope")).status, 404);
  assert.equal((await store("GET", `/api/store/orders/track/${placed.number}`)).status, 404);
  assert.equal((await store("GET", `/api/store/orders/track/${placed.id}`)).status, 404);
  const stored = await WebOrder.findById(placed.id).lean();
  assert.notEqual(stored.trackingTokenHash, placed.trackingToken, "only the hash is stored");
  assert.equal(placed.trackingToken.length >= 40, true);
});

it("STORE_CLOSED when the website is disabled (settings still answers); orderingEnabled=false blocks orders but not browsing", async () => {
  const closedBefore = await store("GET", "/api/store/products");
  assert.equal(closedBefore.status, 503); assert.equal(closedBefore.json.code, "STORE_CLOSED");
  assert.equal(ok(await store("GET", "/api/store/settings")).enabled, false, "no settings document yet: closed");

  const { id } = await seedProduct({ code: "SC1" }); const zone = await seedZone();
  await openSite({ closedMessage: "رجوع قريب" });
  const settingsPaths = ["/api/store/settings"];
  assert.equal((await store("GET", "/api/store/products")).status, 200);

  await staff("PUT", "/api/website/settings", { enabled: false });
  const closed = ok(await store("GET", "/api/store/settings"));
  assert.deepEqual(Object.keys(closed).sort(), ["closedMessage", "enabled", "shop"]);
  assert.equal(closed.closedMessage, "رجوع قريب");
  for (const path of ["/api/store/categories", "/api/store/products", `/api/store/products/${id}`, "/api/store/delivery-zones", `/api/store/images/product/${id}/0`, "/api/store/images/banner/" + "a".repeat(24), "/api/store/orders/track/x"]) {
    const response = await store("GET", path);
    assert.equal(response.status, 503, path); assert.equal(response.json.code, "STORE_CLOSED", path);
  }
  for (const path of ["/api/store/orders", "/api/store/auth/login", "/api/store/auth/register"]) assert.equal((await store("POST", path, {})).status, 503, path);
  assert.equal((await store("GET", "/api/store/me")).status, 503);
  void settingsPaths;

  await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: false });
  assert.equal((await store("GET", "/api/store/products")).status, 200, "browsing still works");
  assert.equal(ok(await store("GET", "/api/store/settings")).orderingEnabled, false);
  const blocked = await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id));
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "ORDERING_DISABLED");
  assert.equal(await WebOrder.countDocuments(), 0);
});

it("while the website is closed the logo still answers and settings still offers its URL; every other image stays closed", async () => {
  ok(await staff("PUT", "/api/shop-profile", { name: "متجر النور", logo: PNG_URI }));
  const { id, category } = await seedProduct({ code: "LG1" });
  await openSite({ banners: [{ image: PNG_URI }] });
  const banner = (await staff("GET", "/api/website/settings")).json.banners[0]._id;
  await staff("PUT", "/api/website/settings", { enabled: false });
  const settings = ok(await store("GET", "/api/store/settings"));
  assert.equal(settings.enabled, false);
  assert.match(settings.shop.logoUrl, /^\/api\/store\/images\/logo\?v=\d+$/);
  const logo = await call("GET", settings.shop.logoUrl, { raw: true });
  assert.equal(logo.status, 200); assert.equal(logo.headers.get("content-type"), "image/png");
  for (const path of [`/api/store/images/product/${id}/0`, `/api/store/images/category/${category}`, `/api/store/images/banner/${banner}`]) {
    const response = await call("GET", path, { raw: true });
    assert.equal(response.status, 503, path);
  }
});

it("staff product responses never carry website.images; only GET /api/website/products/:id returns them", async () => {
  const { id, category } = await seedProduct({ code: "NI1", name: "بصور" }); // seedProduct stores one website image
  assert.equal((await Product.findById(id).lean()).website.images.length, 1);
  const list = ok(await staff("GET", "/api/products?limit=50"));
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].website.visible, true, "the flag and description stay");
  assert.equal(list.data[0].website.images, undefined);
  for (const [label, response] of Object.entries({
    list: await staff("GET", "/api/products"),
    inCategory: await staff("GET", `/api/products?categoryId=${category}`),
    all: await staff("GET", "/api/products?includeArchived=1"),
    search: await staff("GET", "/api/products/search?q=" + encodeURIComponent("بصور")),
    byId: await staff("GET", `/api/products/${id}`),
    update: await staff("PUT", `/api/products/${id}`, { name: "بصور" }),
  })) {
    assert.equal(response.status, 200, label);
    assert.ok(!/"images"/.test(response.text), `${label}: no website.images`);
  }
  const own = ok(await staff("GET", `/api/website/products/${id}`));
  assert.deepEqual(own.website, { visible: true, description: "وصف", images: [PNG_URI] });
  assert.equal((await staff("GET", `/api/website/products/${id}`, undefined, await makeStaff("keeper2", "storekeeper"))).status, 403);
  assert.equal((await staff("GET", `/api/website/products/${"a".repeat(24)}`)).status, 404);
});

it("the access log masks order tracking tokens (both formats) and the raw token never appears", async () => {
  const express = require("express");
  const { createAccessLog, maskUrl } = require("../src/utils/accessLog");
  assert.equal(maskUrl("/api/store/orders/track/abc_DEF-123?x=1"), "/api/store/orders/track/***?x=1");
  assert.equal(maskUrl("/api/store/orders/track/abc"), "/api/store/orders/track/***");
  assert.equal(maskUrl("/api/store/products/abc"), "/api/store/products/abc");
  for (const NODE_ENV of ["production", "development"]) {
    const lines = [];
    const logged = express();
    logged.use(createAccessLog({ NODE_ENV }, { stream: { write: (line) => lines.push(line) } }));
    logged.get("/api/store/orders/track/:token", (_req, res) => res.json({}));
    const listener = logged.listen(0, "127.0.0.1"); await new Promise((resolve) => listener.once("listening", resolve));
    try { await fetch(`http://127.0.0.1:${listener.address().port}/api/store/orders/track/SECRET-TOKEN-xyz?a=1`); } finally { await new Promise((resolve) => listener.close(resolve)); }
    const text = lines.join("");
    assert.ok(text.includes("/api/store/orders/track/***"), NODE_ENV + ": " + text);
    assert.ok(!text.includes("SECRET-TOKEN-xyz"), NODE_ENV + ": token not logged");
  }
});

it("website.manage is required for every admin website route and for the product/category website fields", async () => {
  const { id, category } = await seedProduct({ code: "W1", visible: false });
  const zone = await seedZone();
  const manager = await makeStaff("mgr", "manager");
  const cashier = await makeStaff("cash", "cashier");
  const storekeeper = await makeStaff("keeper", "storekeeper");
  const routes = [
    ["GET", "/api/website/settings"], ["PUT", "/api/website/settings", { title: "x" }],
    ["GET", "/api/website/delivery-zones"], ["POST", "/api/website/delivery-zones", { name: "ز", fee: 1 }],
    ["PUT", `/api/website/delivery-zones/${zone.id}`, { fee: 2 }], ["DELETE", `/api/website/delivery-zones/${zone.id}`],
    ["GET", `/api/website/products/${id}`], ["PUT", `/api/website/products/${id}`, { visible: true }], ["PUT", `/api/website/categories/${category}`, { visible: true }],
  ];
  for (const [method, path, body] of routes) {
    for (const [who, token] of [["cashier", cashier], ["storekeeper (products.manage)", storekeeper]]) {
      const response = await staff(method, path, body, token);
      assert.equal(response.status, 403, `${who}: ${method} ${path}`);
    }
    assert.equal((await call(method, path, { body })).status, 401, `no token: ${method} ${path}`);
  }
  assert.equal(Boolean((await Product.findById(id).lean()).website?.visible), false);
  assert.equal((await staff("PUT", `/api/website/products/${id}`, { visible: true }, manager)).status, 200, "the manager template has website.manage");
  assert.equal((await Product.findById(id).lean()).website?.visible, true);

  // products.manage alone cannot change the website fields through the normal product endpoints either
  await Product.updateOne({ _id: id }, { $set: { "website.visible": false } });
  const edit = await staff("PUT", `/api/products/${id}`, { name: "اسم جديد", website: { visible: true, description: "hack", images: [PNG_URI] } }, storekeeper);
  assert.equal(edit.status, 200, edit.text);
  const after = await Product.findById(id).lean();
  assert.equal(after.name, "اسم جديد"); assert.equal(Boolean(after.website?.visible), false); assert.notEqual(after.website?.description, "hack");
  const create = await staff("POST", "/api/products", { name: "جديد", code: "NEWW", categoryId: category, inventoryCount: 1, purchasePrice: 1, wholesalePrice: 2, retailPrice: 3, website: { visible: true } }, storekeeper);
  assert.equal(create.status, 201, create.text);
  assert.equal(Boolean((await Product.findOne({ code: "NEWW" }).lean()).website?.visible), false);
  const categoryEdit = await staff("PUT", `/api/categories/${category}`, { name: "فئة جديدة", website: { visible: false, sortOrder: 9 } }, storekeeper);
  assert.equal(categoryEdit.status, 200, categoryEdit.text);
  assert.equal((await Category.findById(category).lean()).website.visible, true, "unchanged by categories.manage");
});

it("admin settings: validation, banners, featured categories and the public view of them", async () => {
  const { category } = await seedProduct({ code: "S1" });
  const hiddenCategory = await seedProduct({ code: "S2", categoryVisible: false });
  const bad = async (body, code) => { const response = await staff("PUT", "/api/website/settings", body); assert.equal(response.status, 400, JSON.stringify(body)); if (code) assert.equal(response.json.code, code); };
  await bad({ whatsapp: "abc" }); await bad({ facebook: "javascript:alert(1)" }); await bad({ instagram: "not a url" }); await bad({ minOrderAmount: -1 }); await bad({ freeDeliveryFrom: "x" });
  await bad({ banners: Array.from({ length: 6 }, () => ({ image: PNG_URI })) }); await bad({ banners: [{ image: "not base64!" }] });
  await bad({ banners: [{ image: PNG_URI, linkType: "category", linkId: "a".repeat(24) }] });
  await bad({ featuredCategoryIds: Array.from({ length: 9 }, () => category) }); await bad({ featuredCategoryIds: ["a".repeat(24)] });
  await bad({ enabled: "yes" });

  const saved = ok(await staff("PUT", "/api/website/settings", {
    enabled: true, title: "متجري", about: "نبذة", whatsapp: "+20 100 123 4567", facebook: "https://facebook.com/x", minOrderAmount: 50, freeDeliveryFrom: 0,
    banners: [{ image: PNG_URI, linkType: "category", linkId: category, sortOrder: 2 }, { image: PNG_URI, linkType: "category", linkId: hiddenCategory.category, sortOrder: 1 }],
    featuredCategoryIds: [category, hiddenCategory.category], orderNote: "التوصيل 9-5",
  }));
  assert.equal(saved.whatsapp, "+201001234567".replace("+2", "")); // normalised Egyptian number
  const admin = ok(await staff("GET", "/api/website/settings"));
  assert.equal(admin.banners.length, 2); assert.ok(admin.banners[0].image, "admin sees the images");
  const pub = ok(await store("GET", "/api/store/settings"));
  assert.deepEqual(pub.banners.map((b) => b.link?.id ?? null), [null, category], "a link to a hidden category is dropped; sorted by sortOrder");
  assert.deepEqual(pub.featuredCategoryIds, [category], "hidden categories are not featured");
  assert.ok(pub.banners.every((b) => /^\/api\/store\/images\/banner\/[0-9a-f]{24}\?v=\d+$/.test(b.imageUrl)));
  assert.equal(pub.minOrderAmount, 50); assert.equal(pub.freeDeliveryFrom, 0); assert.equal(pub.orderNote, "التوصيل 9-5");
  assert.equal((await call("GET", pub.banners[0].imageUrl, { raw: true })).status, 200);
  // clearing a value with a blank
  ok(await staff("PUT", "/api/website/settings", { minOrderAmount: "", about: "" }));
  assert.equal(ok(await store("GET", "/api/store/settings")).minOrderAmount, null);
});

it("shop identity on the public settings: name, phones, address and a logo URL (never base64)", async () => {
  ok(await staff("PUT", "/api/shop-profile", { name: "متجر النور", address: "القاهرة", phones: ["01012345678"], logo: PNG_URI, taxNumber: "999-888-777" }));
  await openSite();
  const settings = ok(await store("GET", "/api/store/settings"));
  assert.equal(settings.shop.name, "متجر النور"); assert.deepEqual(settings.shop.phones, ["01012345678"]); assert.equal(settings.shop.address, "القاهرة");
  assert.match(settings.shop.logoUrl, /^\/api\/store\/images\/logo\?v=\d+$/);
  assert.ok(!JSON.stringify(settings).includes("999-888-777"), "no tax number");
  assert.equal((await call("GET", settings.shop.logoUrl, { raw: true })).status, 200);
});

it("delivery zones: CRUD, validation, a zone used by an order can only be deactivated", async () => {
  assert.equal((await staff("POST", "/api/website/delivery-zones", { name: "", fee: 1 })).status, 400);
  assert.equal((await staff("POST", "/api/website/delivery-zones", { name: "ز", fee: -1 })).status, 400);
  assert.equal((await staff("POST", "/api/website/delivery-zones", { name: "ز" })).status, 400);
  const a = await seedZone({ name: "ب", sortOrder: 2 }); const b = await seedZone({ name: "أ", sortOrder: 1, fee: 0 });
  assert.deepEqual(ok(await staff("GET", "/api/website/delivery-zones")).data.map((z) => z.id), [b.id, a.id]);
  ok(await staff("PUT", `/api/website/delivery-zones/${a.id}`, { name: "ب2", fee: 12.5, estimatedTime: "يومين" }));
  assert.equal((await store("GET", "/api/store/delivery-zones")).status, 503, "closed site");
  await openSite();
  const pub = ok(await store("GET", "/api/store/delivery-zones")).data;
  assert.deepEqual(pub.map((z) => Object.keys(z).sort()), [["estimatedTime", "fee", "id", "name"], ["estimatedTime", "fee", "id", "name"]]);
  const { id } = await seedProduct({ code: "Z1" });
  ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], a.id)), 201);
  const blocked = await staff("DELETE", `/api/website/delivery-zones/${a.id}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "ZONE_IN_USE");
  assert.equal(ok(await staff("PUT", `/api/website/delivery-zones/${a.id}`, { isActive: false })).isActive, false);
  assert.equal((await staff("DELETE", `/api/website/delivery-zones/${b.id}`)).status, 204);
  assert.equal(await DeliveryZone.countDocuments(), 1);
  assert.equal((await staff("DELETE", `/api/website/delivery-zones/${b.id}`)).status, 404);
  assert.equal(ok(await staff("GET", "/api/website/delivery-zones")).data[0].used, true);
});

it("customer accounts: normalised phone, unique phone, password rules, login lockout, password change, addresses", async () => {
  await openSite();
  const zone = await seedZone();
  const arabic = ok(await store("POST", "/api/store/auth/register", { name: "منى", phone: "٠١٠١٢٣٤٥٦٧٨", password: "customer-pass-1" }), 201);
  assert.equal(arabic.customer.phone, PHONE);
  assert.equal((await store("POST", "/api/store/auth/register", { name: "تاني", phone: "+20 101 234 5678", password: "customer-pass-1" })).json.code, "PHONE_EXISTS");
  assert.equal((await store("POST", "/api/store/auth/register", { name: "x", phone: "12345", password: "customer-pass-1" })).json.code, "INVALID_PHONE");
  assert.equal((await store("POST", "/api/store/auth/register", { name: "x", phone: "01099999999", password: "short" })).json.code, "INVALID_PASSWORD");
  assert.equal((await store("POST", "/api/store/auth/register", { name: "", phone: "01099999999", password: "customer-pass-1" })).json.code, "INVALID_NAME");
  const stored = await StoreCustomer.findOne({ phone: PHONE }).lean();
  assert.match(stored.passwordHash, /^\$2[aby]\$/); assert.ok(!JSON.stringify(arabic).includes(stored.passwordHash));

  const login = ok(await store("POST", "/api/store/auth/login", { phone: "٠١٠١٢٣٤٥٦٧٨", password: "customer-pass-1" }));
  assert.ok(login.token); assert.ok((await StoreCustomer.findOne({ phone: PHONE }).lean()).lastLoginAt);
  assert.equal((await store("POST", "/api/store/auth/login", { phone: PHONE, password: "wrong-password" })).json.code, "INVALID_CREDENTIALS");
  assert.equal((await store("POST", "/api/store/auth/login", { phone: "01000000000", password: "wrong-password" })).json.code, "INVALID_CREDENTIALS", "an unknown phone answers the same");

  // addresses: up to 5, only the customer's own
  const token = login.token;
  assert.equal((await store("POST", "/api/store/me/addresses", { address: "" }, token)).status, 400);
  assert.equal((await store("POST", "/api/store/me/addresses", { address: "x", zoneId: "a".repeat(24) }, token)).status, 400);
  const addresses = [];
  for (let n = 1; n <= 5; n += 1) addresses.push(ok(await store("POST", "/api/store/me/addresses", { label: `ع${n}`, address: `شارع ${n}`, zoneId: zone.id, notes: "n" }, token), 201));
  assert.equal((await store("POST", "/api/store/me/addresses", { address: "السادس" }, token)).json.code, "ADDRESS_LIMIT");
  assert.equal(ok(await store("PUT", `/api/store/me/addresses/${addresses[0].id}`, { label: "جديد", address: "شارع جديد" }, token)).label, "جديد");
  assert.equal((await store("DELETE", `/api/store/me/addresses/${addresses[4].id}`, undefined, token)).status, 204);
  assert.equal(ok(await store("GET", "/api/store/me/addresses", undefined, token)).data.length, 4);
  const other = await register("01033333333", "آخر");
  assert.equal((await store("PUT", `/api/store/me/addresses/${addresses[0].id}`, { address: "x" }, other.token)).status, 404);
  assert.equal((await store("DELETE", `/api/store/me/addresses/${addresses[0].id}`, undefined, other.token)).status, 404);

  // ordering with a saved address, signed in
  const { id } = await seedProduct({ code: "A1" });
  const withAddress = ok(await store("POST", "/api/store/orders", { items: [{ productId: id, qty: 1 }], zoneId: zone.id, addressId: addresses[1].id, idempotencyKey: uuid() }, token), 201);
  const mine = ok(await store("GET", `/api/store/me/orders/${withAddress.id}`, undefined, token));
  assert.equal(mine.contact.address, "شارع 2"); assert.equal(mine.contact.phone, PHONE); assert.equal(mine.contact.name, "منى");
  assert.equal((await store("POST", "/api/store/orders", { items: [{ productId: id, qty: 1 }], zoneId: zone.id, addressId: addresses[1].id, idempotencyKey: uuid() }, other.token)).status, 400, "another customer's address id");

  // name and password change (the old token ends; the new one works)
  assert.equal(ok(await store("PUT", "/api/store/me", { name: "منى أحمد" }, token)).customer.name, "منى أحمد");
  assert.equal((await store("PUT", "/api/store/me", { newPassword: "brand-new-pass-1", currentPassword: "wrong" }, token)).json.code, "WRONG_PASSWORD");
  assert.equal((await store("PUT", "/api/store/me", { newPassword: "short", currentPassword: "customer-pass-1" }, token)).json.code, "INVALID_PASSWORD");
  const changed = ok(await store("PUT", "/api/store/me", { newPassword: "brand-new-pass-1", currentPassword: "customer-pass-1" }, token));
  assert.equal((await store("GET", "/api/store/me", undefined, token)).status, 401, "the old session ended");
  assert.equal((await store("GET", "/api/store/me", undefined, changed.token)).status, 200);
  assert.equal((await store("POST", "/api/store/auth/login", { phone: PHONE, password: "customer-pass-1" })).status, 401);
  assert.equal((await store("POST", "/api/store/auth/login", { phone: PHONE, password: "brand-new-pass-1" })).status, 200);

  // lockout per phone + IP; staff accounts are a separate counter
  for (let n = 0; n < 4; n += 1) assert.equal((await store("POST", "/api/store/auth/login", { phone: "01044444444", password: "x".repeat(10) })).status, 401);
  assert.equal((await store("POST", "/api/store/auth/login", { phone: "01044444444", password: "x".repeat(10) })).status, 429);
  const locked = await store("POST", "/api/store/auth/login", { phone: PHONE, password: "brand-new-pass-1" });
  assert.equal(locked.status, 200, "another phone is not locked");
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "s3-owner", password: "owner-pass-123" } })).status, 200, "staff login unaffected");
});

it("a StoreCustomer is separate from the shop's Customer: nothing is created, looked up or revealed", async () => {
  const Customer = require("../src/models/customer.model");
  await Customer.create({ name: "عميل المحل", phone: PHONE });
  await openSite();
  const before = await Customer.countDocuments();
  const customer = await register(PHONE, "اسم مختلف");
  assert.equal(customer.customer.name, "اسم مختلف", "the shop customer with the same phone is not revealed or reused");
  const { id } = await seedProduct({ code: "SEP1" }); const zone = await seedZone();
  ok(await store("POST", "/api/store/orders", orderBody([{ productId: id, qty: 1 }], zone.id), customer.token), 201);
  assert.equal(await Customer.countDocuments(), before, "placing an order never touches the shop's customers");
  assert.equal(await StoreCustomer.countDocuments(), 1);
});

it("migration 12 adds the website defaults to old products and categories and shows nothing; running it twice changes nothing", async () => {
  const migration = migrations.find((entry) => entry.version === 12);
  assert.ok(migration);
  const category = await Category.collection.insertOne({ name: "قديمة", createdAt: new Date(), updatedAt: new Date() });
  const product = await Product.collection.insertOne({ name: "قديم", code: "OLD", category: category.insertedId, inventoryCount: 1, retailPrice: 5, wholesalePrice: 4, purchasePrice: 3, createdAt: new Date(), updatedAt: new Date() });
  const first = await migration.run();
  assert.deepEqual(first, { products: 1, categories: 1 });
  const row = await Product.collection.findOne({ _id: product.insertedId });
  assert.equal(row.website.visible, false); assert.deepEqual(row.website.images, []);
  assert.equal((await Category.collection.findOne({ _id: category.insertedId })).website.visible, false);
  assert.deepEqual(await migration.run(), { products: 0, categories: 0 });
  // a product the shop already chose to show is never reset
  await Product.collection.updateOne({ _id: product.insertedId }, { $set: { "website.visible": true } });
  await migration.run();
  assert.equal((await Product.collection.findOne({ _id: product.insertedId })).website.visible, true);
  await openSite();
  assert.equal((await store("GET", "/api/store/products")).json.data.length, 0, "category still hidden: nothing is shown automatically");
});

it("website fields: product description and images are validated like the main image", async () => {
  const { id } = await seedProduct({ code: "VAL1" });
  const put = (body) => staff("PUT", `/api/website/products/${id}`, body);
  assert.equal((await put({ description: "x".repeat(2001) })).status, 400);
  assert.equal((await put({ images: [PNG_URI, PNG_URI, PNG_URI, PNG_URI, PNG_URI] })).status, 400);
  assert.equal((await put({ images: ["not base64!!"] })).status, 400);
  assert.equal((await put({ visible: "yes" })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ images: [PNG_URI, PNG_URI, PNG_URI, PNG_URI] })).status, 200);
  assert.equal((await staff("PUT", `/api/website/products/${"a".repeat(24)}`, { visible: true })).status, 404);
  assert.equal((await staff("PUT", `/api/website/categories/${"a".repeat(24)}`, { visible: true })).status, 404);
  assert.equal((await staff("PUT", `/api/website/categories/${(await Product.findById(id).lean()).category}`, { sortOrder: "abc" })).status, 400);
});

it("category order: sortOrder then name", async () => {
  await openSite();
  const names = [["ج", 2], ["ب", 2], ["أ", 1]];
  for (const [index, [name, sortOrder]] of names.entries()) {
    const created = ok(await staff("POST", "/api/categories", { name }), 201);
    ok(await staff("PUT", `/api/website/categories/${created._id || created.id}`, { visible: true, sortOrder }));
    void index;
  }
  assert.deepEqual(ok(await store("GET", "/api/store/categories")).data.map((c) => c.name), ["أ", "ب", "ج"]);
});

it("the store API has its own small body limit and bad JSON is a 400, while staff routes keep the big limit", async () => {
  await openSite();
  const big = await call("POST", "/api/store/auth/login", { body: { phone: PHONE, password: "x".repeat(70 * 1024) } });
  assert.equal(big.status, 413);
  const malformed = await fetch(`${baseUrl}/api/store/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(malformed.status, 400);
  const staffBig = await staff("PUT", "/api/website/settings", { about: "x".repeat(100) });
  assert.equal(staffBig.status, 200);
  assert.equal((await staff("PUT", "/api/website/products/" + "a".repeat(24), { images: ["data:image/png;base64," + "A".repeat(100000)] })).status, 404, "a staff body well over 64kb is still parsed");
});

it("unit: Egyptian phone normalisation and Arabic slugs", () => {
  for (const input of ["01012345678", "+201012345678", "00201012345678", "201012345678", "1012345678", "٠١٠١٢٣٤٥٦٧٨", "۰۱۰۱۲۳۴۵۶۷۸", "0101 234 5678", "010-1234-5678"]) assert.equal(normalizeStorePhone(input), "01012345678", input);
  for (const input of ["", "123", "01312345678", "0101234567", "abc", null, undefined, {}, "0101234567890"]) assert.equal(normalizeStorePhone(input), null, String(input));
  assert.equal(normalizeStorePhone("01112345678"), "01112345678"); assert.equal(normalizeStorePhone("01212345678"), "01212345678"); assert.equal(normalizeStorePhone("01512345678"), "01512345678");
  assert.equal(storeSlug("هاتف  سامسونج (S24)!"), "هاتف-سامسونج-s24");
  assert.equal(storeSlug("!!!"), "product");
  assert.equal(storeSlug("A  b").length > 0, true);
  void signStoreToken;
});
