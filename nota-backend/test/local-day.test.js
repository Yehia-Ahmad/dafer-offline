// "Today" and day filters are the SHOP's local business day (Africa/Cairo), never the UTC date: between 00:00 and 02:00 in Cairo (03:00 in
// summer) the UTC date is still yesterday. Every case here pins the clock (or stamps a document) at 00:30 LOCAL on 2026-11-16, which is
// 22:30 UTC of 2026-11-15. TZ is forced to Africa/Cairo so the old UTC-based code fails on any machine. Real throwaway mongod (port 27134).
process.env.TZ = "Africa/Cairo";
process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "local-day-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Supplier = require("../src/models/supplier.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const ReturnLog = require("../src/models/returnLog.model");
const { runMigrations } = require("../src/migrations");
const clock = require("../src/utils/clock");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const atLocal = (year, month, day, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute, 0, 0);

let stop; let server; let baseUrl; let token;
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
  clock.setClock(null); await clearDatabase(); token = null;
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "ld-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);
async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function seedProduct() {
  const category = await Category.create({ name: "LD" });
  const made = await call("POST", "/api/products", { name: "LD product", code: "LD-1", categoryId: String(category._id), inventoryCount: 100, purchasePrice: 40, wholesalePrice: 60, retailPrice: 100 });
  assert.equal(made.status, 201, made.text); return made.json._id;
}

it("the clock helpers agree on the shop day at 00:30 Africa/Cairo on 2026-11-16", () => {
  assert.equal(atLocal(2026, 11, 16, 0, 30).toISOString(), "2026-11-15T22:30:00.000Z", "the test really runs in Cairo");
  clock.setClock(() => atLocal(2026, 11, 16, 0, 30));
  assert.equal(clock.localDayString(), "2026-11-16");
  assert.equal(clock.localDayAsUtc().toISOString(), "2026-11-16T00:00:00.000Z");
});

it("a date-only filter value is a LOCAL day: its first and last instant; garbage and impossible dates are invalid", () => {
  const first = clock.filterBoundary("2026-11-16"); const last = clock.filterBoundary("2026-11-16", true);
  assert.equal(first.getTime(), atLocal(2026, 11, 16, 0, 0).getTime());
  assert.equal(last.getTime(), new Date(2026, 10, 16, 23, 59, 59, 999).getTime());
  assert.ok(atLocal(2026, 11, 16, 0, 30) >= first && atLocal(2026, 11, 16, 0, 30) <= last, "00:30 local is inside its own day");
  assert.ok(atLocal(2026, 11, 15, 23, 59) < first, "23:59 the day before is outside");
  assert.ok(new Date("2026-11-16T00:00:00.000Z") >= first && new Date("2026-11-16T00:00:00.000Z") <= last, "a business date stored at UTC midnight is inside its day");
  assert.ok(Number.isNaN(clock.filterBoundary("2026-02-30").getTime())); assert.ok(Number.isNaN(clock.filterBoundary("nope").getTime()));
  assert.equal(clock.filterBoundary("2026-11-16T10:00:00Z").toISOString(), "2026-11-16T10:00:00.000Z", "anything else is parsed as given");
});

it("purchases: a purchase stamped at 00:30 local on 2026-11-16 is found by the 2026-11-16 filter and not by the day before", async () => {
  await startLedger();
  const productId = await seedProduct();
  const supplier = await Supplier.create({ name: "LD Supplier", paymentTermsDays: 30 });
  const instant = atLocal(2026, 11, 16, 0, 30).toISOString(); // 22:30Z of the 15th
  const made = await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: instant, items: [{ productId, qty: 5, unitPrice: 40 }] });
  assert.equal(made.status, 201, made.text);
  const list = async (day) => { const response = await call("GET", `/api/purchases?from=${day}&to=${day}`); assert.equal(response.status, 200, response.text); return response.json.data; };
  assert.equal((await list("2026-11-16")).length, 1, "found on its own local day");
  assert.equal((await list("2026-11-15")).length, 0, "not on the day before");
  assert.equal((await list("2026-11-17")).length, 0, "not on the day after");
});

it("returns: a return stamped at 00:30 local on 2026-11-16 is found by dateFrom/dateTo 2026-11-16 and not by the day before", async () => {
  await startLedger();
  const productId = await seedProduct();
  const sale = await call("POST", "/api/sellings", { customerName: "Walk-in", customerPhone: "01017171718", sellingDate: "2026-11-16", items: [{ productId, price: 100, quantity: 2 }] });
  assert.equal(sale.status, 201, sale.text);
  const returned = await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ productId, quantity: 1, returnReason: "x" }] });
  assert.ok([200, 201].includes(returned.status), returned.text);
  await ReturnLog.collection.updateMany({}, { $set: { returnDate: atLocal(2026, 11, 16, 0, 30) } });
  const list = async (day) => { const response = await call("GET", `/api/returns?dateFrom=${day}&dateTo=${day}`); assert.equal(response.status, 200, response.text); return response.json.data; };
  assert.equal((await list("2026-11-16")).length, 1);
  assert.equal((await list("2026-11-15")).length, 0);
});

it("the profit-by-month default year is the local year: 00:30 on 2027-01-01 is 2027 (the UTC year is still 2026)", async () => {
  await startLedger();
  clock.setClock(() => atLocal(2027, 1, 1, 0, 30));
  const response = await call("GET", "/api/products/profit-bar"); assert.equal(response.status, 200, response.text);
  assert.equal(response.json.year, 2027);
  clock.setClock(() => atLocal(2026, 12, 31, 23, 30));
  assert.equal((await call("GET", "/api/products/profit-bar")).json.year, 2026);
});

it("export file names carry the local day: products-2026-11-16.xlsx and categories-2026-11-16.xlsx at 00:30 local", async () => {
  await startLedger();
  clock.setClock(() => atLocal(2026, 11, 16, 0, 30));
  const products = await call("GET", "/api/products/export/excel");
  assert.equal(products.status, 200); assert.match(products.headers.get("content-disposition"), /products-2026-11-16\.xlsx/);
  const categories = await call("GET", "/api/categories/export");
  assert.equal(categories.status, 200); assert.match(categories.headers.get("content-disposition"), /categories-2026-11-16\.xlsx/);
});

