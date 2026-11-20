// "Today" and day filters are the SHOP's local business day (Africa/Cairo), never the UTC date: between 00:00 and 02:00 in Cairo (03:00 in
// summer) the UTC date is still yesterday. Every case here pins the clock (or stamps a document) at 00:30 LOCAL on 2026-11-16, which is
// 22:30 UTC of 2026-11-15 in Cairo. In a timezone behind UTC the local and UTC days agree, so those runs pass either way; in Cairo the
// buggy code fails. Real throwaway mongod (port 27134).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "local-day-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "local-day-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const Counter = require("../src/models/counter.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const ReturnLog = require("../src/models/returnLog.model");
const WebOrder = require("../src/models/webOrder.model");
const { runMigrations } = require("../src/migrations");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const clock = require("../src/utils/clock");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");
const { today, dayString, atLocal, storedDay } = require("./helpers/shopDay");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let seq = 0;
let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27134 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { clock.setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  clock.setClock(null);
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "ld-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "ld-owner", password: "owner-pass-123" } })).json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}
const staff = (method, path, body) => call(method, path, { token: ownerToken, body });
const store = (method, path, body) => call(method, path, { body });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };

async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function seedProduct({ stock = 100, retail = 100 } = {}) {
  const created = ok(await staff("POST", "/api/categories", { name: `فئة ${++seq}`, image: PNG_URI }), 201);
  const category = created._id || created.id || created.category?._id;
  ok(await staff("PUT", `/api/website/categories/${category}`, { visibility: "show", sortOrder: 1 }));
  const product = ok(await staff("POST", "/api/products", { name: "منتج", code: `LD${seq}`, categoryId: category, inventoryCount: stock, purchasePrice: 40, wholesalePrice: Math.min(60, retail), retailPrice: retail }), 201);
  const id = product._id || product.product?._id;
  ok(await staff("PUT", `/api/website/products/${id}`, { visibility: "show", description: "وصف", images: [PNG_URI] }));
  return { id, category };
}

// ------------------------------------------------------------------------------------------------ the helpers

it("the shared helper and the clock agree on the shop day at 00:30 Africa/Cairo on 2026-11-16", () => {
  clock.setClock(() => atLocal(2026, 11, 16, 0, 30));
  assert.equal(today(), "2026-11-16");
  assert.equal(dayString(-1), "2026-11-15"); assert.equal(dayString(1), "2026-11-17"); assert.equal(dayString(-100), "2026-08-08");
  assert.equal(clock.localDayString(), "2026-11-16");
  assert.equal(storedDay(clock.localDayAsUtc()), "2026-11-16", "the business day of 'now' is the UTC midnight of the LOCAL day");
  assert.equal(clock.businessDay(atLocal(2026, 11, 16, 0, 30)).toISOString(), "2026-11-16T00:00:00.000Z", "an instant at 00:30 local belongs to that local day");
});

it("a date-only filter value is a LOCAL day: its first and last instant; garbage and impossible dates are invalid", () => {
  const first = clock.filterBoundary("2026-11-16"); const last = clock.filterBoundary("2026-11-16", true);
  assert.equal(first.getTime(), atLocal(2026, 11, 16, 0, 0).getTime());
  assert.equal(last.getTime(), new Date(2026, 10, 16, 23, 59, 59, 999).getTime());
  assert.ok(atLocal(2026, 11, 16, 0, 30) >= first && atLocal(2026, 11, 16, 0, 30) <= last, "00:30 local is inside its own day");
  assert.ok(atLocal(2026, 11, 15, 23, 59) < first, "23:59 the day before is outside");
  assert.ok(new Date("2026-11-16T00:00:00.000Z") >= first && new Date("2026-11-16T00:00:00.000Z") <= last, "a business date stored at UTC midnight is inside its day (shops ahead of UTC)");
  assert.ok(Number.isNaN(clock.filterBoundary("2026-02-30").getTime())); assert.ok(Number.isNaN(clock.filterBoundary("nope").getTime()));
  assert.equal(clock.filterBoundary("2026-11-16T10:00:00Z").toISOString(), "2026-11-16T10:00:00.000Z", "anything else is parsed as given");
});

// ------------------------------------------------------------------------------------------------ list filters on documents stamped at an instant

it("purchases: a purchase stamped at 00:30 local on 2026-11-16 is found by the 2026-11-16 filter and not by the day before", async () => {
  await startLedger();
  const { id: productId } = await seedProduct();
  const supplier = ok(await staff("POST", "/api/suppliers", { name: "مورد", phone: "01011111111" }), 201);
  const instant = atLocal(2026, 11, 16, 0, 30).toISOString(); // 22:30Z of the 15th in Cairo
  ok(await staff("POST", "/api/purchases", { supplierId: supplier._id || supplier.supplier?._id, date: instant, items: [{ productId, qty: 5, unitPrice: 40 }] }), 201);
  const list = async (day) => ok(await staff("GET", `/api/purchases?from=${day}&to=${day}`));
  assert.equal((await list("2026-11-16")).data.length, 1, "found on its own local day");
  assert.equal((await list("2026-11-15")).data.length, 0, "not on the day before");
  assert.equal((await list("2026-11-17")).data.length, 0, "not on the day after");
});

it("returns: a return stamped at 00:30 local on 2026-11-16 is found by dateFrom/dateTo 2026-11-16 and not by the day before", async () => {
  await startLedger();
  const { id: productId } = await seedProduct();
  const sale = ok(await staff("POST", "/api/sellings", { customerName: "نقدي", customerPhone: "01017171718", sellingDate: today(), items: [{ productId, price: 100, quantity: 2 }] }), 201);
  ok(await staff("POST", "/api/returns", { returnType: "cash", invoiceId: sale._id || sale.id, items: [{ productId, quantity: 1, returnReason: "x" }] }), 201);
  await ReturnLog.collection.updateMany({}, { $set: { returnDate: atLocal(2026, 11, 16, 0, 30) } });
  const list = async (day) => ok(await staff("GET", `/api/returns?dateFrom=${day}&dateTo=${day}`));
  assert.equal((await list("2026-11-16")).data.length, 1);
  assert.equal((await list("2026-11-15")).data.length, 0);
});

it("website orders: an order placed at 00:30 local on 2026-11-16 is found by from/to 2026-11-16 and not by the day before", async () => {
  await startLedger();
  ok(await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر" }));
  const { id: productId } = await seedProduct();
  const zone = ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة" }), 201);
  const placed = ok(await store("POST", "/api/store/orders", { items: [{ productId, qty: 1 }], zoneId: zone.id || zone._id, idempotencyKey: require("node:crypto").randomUUID(), contact: { name: "عميل", phone: "01012345678", address: "شارع 1", notes: "" } }), 201);
  await WebOrder.collection.updateOne({ _id: new (require("mongoose").Types.ObjectId)(placed.id) }, { $set: { createdAt: atLocal(2026, 11, 16, 0, 30) } });
  const list = async (day) => ok(await staff("GET", `/api/orders?from=${day}&to=${day}`));
  assert.equal((await list("2026-11-16")).data.length, 1);
  assert.equal((await list("2026-11-15")).data.length, 0);
});

// ------------------------------------------------------------------------------------------------ defaults built from "now"

it("the profit-by-month default year is the local year: 00:30 on 2027-01-01 is 2027 (the UTC year is still 2026)", async () => {
  await startLedger();
  clock.setClock(() => atLocal(2027, 1, 1, 0, 30));
  assert.equal(ok(await staff("GET", "/api/products/profit-bar")).year, 2027);
  clock.setClock(() => atLocal(2026, 12, 31, 23, 30));
  assert.equal(ok(await staff("GET", "/api/products/profit-bar")).year, 2026);
});

it("export file names carry the local day: products-2026-11-16.xlsx and categories-2026-11-16.xlsx at 00:30 local", async () => {
  await startLedger();
  clock.setClock(() => atLocal(2026, 11, 16, 0, 30));
  const products = await staff("GET", "/api/products/export/excel");
  assert.equal(products.status, 200); assert.match(products.headers.get("content-disposition"), /products-2026-11-16\.xlsx/);
  const categories = await staff("GET", "/api/categories/export");
  assert.equal(categories.status, 200); assert.match(categories.headers.get("content-disposition"), /categories-2026-11-16\.xlsx/);
});

it("the dashboard 'today' and the expenses default month follow the local day at 00:30 (the first of a month)", async () => {
  await startLedger();
  clock.setClock(() => atLocal(2026, 12, 1, 0, 30));
  assert.equal(ok(await staff("GET", "/api/dashboard/summary")).date, "2026-12-01");
  assert.equal(ok(await staff("GET", "/api/expenses")).month, "2026-12", "the default month is December, not November");
});
