process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const app = require("../src/app");
const Category = require("../src/models/category.model");
const CreditSale = require("../src/models/creditSale.model");
const Customer = require("../src/models/customer.model");
const Product = require("../src/models/product.model");
const Selling = require("../src/models/selling.model");
const { localTodayAsUtcDay } = require("../src/controllers/dashboard.controller");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

// Stage 12 backend additions, against a real throwaway mongod (aggregations need a database):
// GET /api/dashboard/summary, GET /api/categories productCount, GET /api/products without categoryId
// (+ search), Product.lowStockThreshold, discountPercentage on create, and unchanged existing responses.

const DAY = 24 * 60 * 60 * 1000;
const today = localTodayAsUtcDay();
const daysAgo = (n) => new Date(today.getTime() - n * DAY);

let stop;
let baseUrl;
let server;

test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod();
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (stop) await stop();
});

test.beforeEach(async () => {
  if (!mongodSkipReason) await clearDatabase();
});

const call = async (method, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

const seedCategory = (name = "لمبات") => Category.create({ name });
const seedProduct = (category, fields = {}) =>
  Product.create({ name: "صنف", code: `P-${Math.random().toString(36).slice(2, 8)}`, inventoryCount: 10, category: category._id,
    wholesalePrice: 40, purchasePrice: 30, retailPrice: 50, ...fields });
// One-line cash invoice, shaped like the ones POST /api/sellings stores.
const cash = (sellingDate, totalPrice, extra = {}) =>
  Selling.create({ customerName: "زبون نقدي", customerPhone: "0100", sellingDate, totalPrice, totalQuantity: 1, discountAmount: 0, shippingFees: 0,
    items: [{ product: new mongoose.Types.ObjectId(), productName: "صنف", quantity: 1, unitPrice: totalPrice, totalPrice }], ...extra });
const credit = async (sellingDate, totalPrice, remainingAmount, extra = {}) => {
  const customer = extra.customer || (await Customer.create({ name: `عميل ${Math.random()}`, phone: `01${Math.floor(Math.random() * 1e9)}` }))._id;
  return CreditSale.create({ customer, customerName: "عميل", customerPhone: "0111", sellingDate, totalQuantity: 1, totalPrice,
    paidAmount: totalPrice - remainingAmount, remainingAmount, status: remainingAmount ? "partially_paid" : "paid", ...extra });
};

// ---------- dashboard summary ----------

it("dashboard summary on an empty database: zeros, 7 empty days, no lists", async () => {
  const { status, json } = await call("GET", "/api/dashboard/summary");
  assert.equal(status, 200);
  assert.equal(json.date, today.toISOString().slice(0, 10));
  assert.ok(json.timeZone);
  assert.deepEqual(json.today, { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } });
  assert.deepEqual(json.yesterday, { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } });
  assert.deepEqual(json.credit, { outstanding: 0, customersWithBalance: 0, overdueAmount: 0, overdueCount: 0 });
  assert.equal(json.last7Days.length, 7);
  assert.ok(json.last7Days.every((day) => day.cash === 0 && day.credit === 0));
  assert.equal(json.last7Days[6].date, json.date);
  assert.deepEqual(json.recentInvoices, []);
  assert.deepEqual(json.lowStock, []);
});

it("dashboard summary: today / yesterday split and the 7-day series (older days excluded)", async () => {
  await cash(today, 100);
  await cash(today, 250.5);
  await cash(daysAgo(1), 80);
  await cash(daysAgo(3), 40);
  await cash(daysAgo(7), 999); // outside the 7 days
  await credit(today, 300, 300);
  await credit(daysAgo(1), 120, 0);

  const { json } = await call("GET", "/api/dashboard/summary");
  assert.deepEqual(json.today, { cash: { total: 350.5, count: 2 }, credit: { total: 300, count: 1 } });
  assert.deepEqual(json.yesterday, { cash: { total: 80, count: 1 }, credit: { total: 120, count: 1 } });
  assert.deepEqual(json.last7Days.map((day) => [day.cash, day.credit]), [[0, 0], [0, 0], [0, 0], [40, 0], [0, 0], [80, 120], [350.5, 300]]);
  assert.equal(json.last7Days[0].date, daysAgo(6).toISOString().slice(0, 10));
});

it("dashboard summary: a cash invoice with a return counts net of the returned items, as the invoice screens show it", async () => {
  const productId = (await seedProduct(await seedCategory()))._id;
  const selling = await Selling.create({ customerName: "زبون", customerPhone: "0100", sellingDate: today, totalQuantity: 3, discountAmount: 0, shippingFees: 0,
    totalPrice: 300, items: [{ product: productId, productName: "صنف", quantity: 3, unitPrice: 100, totalPrice: 300 }] });
  selling.refunds.push({ refundDate: today, items: [{ invoiceItemId: selling.items[0]._id, product: productId, productName: "صنف", quantity: 1, unitPrice: 100, totalPrice: 100 }],
    totalQuantity: 1, totalAmount: 100 });
  selling.refundedQuantity = 1;
  selling.refundedAmount = 100;
  selling.refundStatus = "partial";
  await selling.save();

  const shown = await call("GET", `/api/sellings/${selling._id}`);
  const { json } = await call("GET", "/api/dashboard/summary");
  assert.equal(shown.status, 200, JSON.stringify(shown.json));
  assert.equal(shown.json.totalPrice, 300);
  assert.equal(shown.json.netTotal, 200);
  assert.deepEqual(json.today.cash, { total: 200, count: 1 });
  assert.equal(json.recentInvoices[0].total, 200);
});

it("dashboard summary: outstanding, customers with a balance, overdue = dueDate before today and money remaining", async () => {
  const customer = (await Customer.create({ name: "م. سامي", phone: "01001234567" }))._id;
  await credit(daysAgo(20), 1000, 400, { customer, dueDate: daysAgo(5) }); // overdue
  await credit(daysAgo(2), 500, 500, { customer, dueDate: today }); // due today: not overdue
  await credit(daysAgo(30), 700, 200); // no due date: not overdue, other customer
  await credit(daysAgo(30), 900, 0, { dueDate: daysAgo(10) }); // paid: ignored

  const { json } = await call("GET", "/api/dashboard/summary");
  assert.deepEqual(json.credit, { outstanding: 1100, customersWithBalance: 2, overdueAmount: 400, overdueCount: 1 });
});

it("dashboard summary: latest 5 invoices across cash and credit, newest first", async () => {
  const base = Date.now() - 60000;
  const created = [];
  for (let i = 0; i < 4; i += 1) {
    const doc = await cash(today, 10 + i);
    await Selling.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(base + i * 2000) } });
    created.push(doc);
  }
  for (let i = 0; i < 3; i += 1) {
    const doc = await credit(today, 100 + i, 0);
    await CreditSale.collection.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(base + i * 2000 + 1000) } });
  }
  const { json } = await call("GET", "/api/dashboard/summary");
  assert.equal(json.recentInvoices.length, 5);
  assert.deepEqual(json.recentInvoices.map((row) => [row.type, row.total]), [["cash", 13], ["credit", 102], ["cash", 12], ["credit", 101], ["cash", 11]]);
  const first = json.recentInvoices[0];
  assert.equal(first.id, String(created[3]._id));
  assert.equal(first.reference, String(created[3]._id));
  assert.equal(first.customerId, null);
  assert.ok(json.recentInvoices[1].customerId);
});

it("dashboard summary: low stock uses each product's threshold, default 5, lowest first, at most 8", async () => {
  const category = await seedCategory();
  await seedProduct(category, { name: "خمسة", inventoryCount: 5 }); // default 5 → low
  await seedProduct(category, { name: "ستة", inventoryCount: 6 }); // default 5 → ok
  await seedProduct(category, { name: "عشرين", inventoryCount: 18, lowStockThreshold: 20 }); // custom → low
  await seedProduct(category, { name: "صفر حد", inventoryCount: 1, lowStockThreshold: 0 }); // custom 0 → ok
  await seedProduct(category, { name: "نافد", inventoryCount: 0 });
  for (let i = 0; i < 8; i += 1) await seedProduct(category, { name: `x${i}`, inventoryCount: 3 });

  const { json } = await call("GET", "/api/dashboard/summary");
  assert.equal(json.lowStock.length, 8);
  assert.equal(json.lowStock[0].name, "نافد");
  assert.deepEqual(Object.keys(json.lowStock[0]).sort(), ["code", "id", "inventoryCount", "name", "threshold"]);
  assert.equal(json.lowStock[0].threshold, 5);
  assert.ok(json.lowStock.every((row, i, rows) => i === 0 || rows[i - 1].inventoryCount <= row.inventoryCount));

  await Product.deleteMany({ name: /^x/ });
  const again = await call("GET", "/api/dashboard/summary");
  assert.deepEqual(again.json.lowStock.map((row) => [row.name, row.threshold]), [["نافد", 5], ["خمسة", 5], ["عشرين", 20]]);
});

// ---------- categories ----------

it("GET /api/categories adds productCount and keeps every existing field", async () => {
  const lamps = await seedCategory("لمبات");
  await seedCategory("شواحن");
  await seedProduct(lamps);
  await seedProduct(lamps);

  const { status, json } = await call("GET", "/api/categories");
  assert.equal(status, 200);
  assert.deepEqual(json.map((c) => [c.name, c.productCount]), [["لمبات", 2], ["شواحن", 0]]);
  const raw = JSON.parse(JSON.stringify(await Category.find().sort({ createdAt: 1 })));
  assert.deepEqual(json.map(({ productCount, ...rest }) => rest), raw);
});

// ---------- products list ----------

it("GET /api/products without categoryId lists all products with the same paging and shape", async () => {
  const lamps = await seedCategory("لمبات");
  const chargers = await seedCategory("شواحن");
  for (let i = 0; i < 3; i += 1) await seedProduct(lamps, { name: `لمبة ${i}`, code: `L-${i}` });
  for (let i = 0; i < 2; i += 1) await seedProduct(chargers, { name: `شاحن ${i}`, code: `C-${i}` });

  const all = await call("GET", "/api/products?page=1&limit=4");
  assert.equal(all.status, 200);
  assert.equal(all.json.success, true);
  assert.equal(all.json.data.length, 4);
  assert.deepEqual(all.json.pagination, { page: 1, limit: 4, totalItems: 5, totalPages: 2, hasNextPage: true, hasPrevPage: false });
  assert.equal(typeof all.json.data[0].category, "object"); // populated, as with categoryId

  const second = await call("GET", "/api/products?page=2&limit=4");
  assert.equal(second.json.data.length, 1);

  const one = await call("GET", `/api/products?categoryId=${chargers._id}`);
  assert.equal(one.json.pagination.totalItems, 2);
  assert.ok(one.json.data.every((p) => p.category._id === String(chargers._id)));

  const searched = await call("GET", "/api/products?search=c-");
  assert.deepEqual(searched.json.data.map((p) => p.code).sort(), ["C-0", "C-1"]);
  const searchedInCategory = await call("GET", `/api/products?categoryId=${lamps._id}&search=${encodeURIComponent("لمبة 2")}`);
  assert.deepEqual(searchedInCategory.json.data.map((p) => p.code), ["L-2"]);

  const missing = await call("GET", `/api/products?categoryId=${new mongoose.Types.ObjectId()}`);
  assert.equal(missing.status, 404);
});

// ---------- product fields ----------

const productBody = (categoryId, extra = {}) => ({
  name: "لمبة", code: "L-1", inventoryCount: 10, categoryId, wholesalePrice: 40, purchasePrice: 30, retailPrice: 50, ...extra,
});

it("POST /api/products without the new fields: same response as before (no lowStockThreshold key, discount 0)", async () => {
  const category = await seedCategory();
  const { status, json } = await call("POST", "/api/products", productBody(category._id));
  assert.equal(status, 201);
  assert.equal("lowStockThreshold" in json, false);
  assert.equal(json.discountPercentage, 0);
  assert.equal(json.priceAfterDiscount, 50);
  assert.deepEqual(Object.keys(json).sort(), ["__v", "_id", "category", "code", "createdAt", "discountPercentage", "inventoryCount", "name",
    "priceAfterDiscount", "purchasePrice", "retailPrice", "soldItemCount", "specifications", "updatedAt", "wholesalePrice"]);
});

it("POST /api/products accepts discountPercentage (0–100) and lowStockThreshold (≥ 0); invalid values → 400", async () => {
  const category = await seedCategory();
  const created = await call("POST", "/api/products", productBody(category._id, { discountPercentage: 10, lowStockThreshold: 3 }));
  assert.equal(created.status, 201);
  assert.equal(created.json.discountPercentage, 10);
  assert.equal(created.json.priceAfterDiscount, 45);
  assert.equal(created.json.lowStockThreshold, 3);
  assert.equal((await call("GET", `/api/products/${created.json._id}`)).json.lowStockThreshold, 3);

  assert.equal((await call("POST", "/api/products", productBody(category._id, { code: "L-2", discountPercentage: 120 }))).status, 400);
  assert.equal((await call("POST", "/api/products", productBody(category._id, { code: "L-3", lowStockThreshold: -1 }))).status, 400);
  assert.equal((await call("POST", "/api/products", productBody(category._id, { code: "L-4", lowStockThreshold: "abc" }))).status, 400);
  const empty = await call("POST", "/api/products", productBody(category._id, { code: "L-5", lowStockThreshold: "" }));
  assert.equal(empty.status, 201);
  assert.equal("lowStockThreshold" in empty.json, false);
});

it("PUT /api/products/:id sets, keeps and clears lowStockThreshold; other fields untouched", async () => {
  const category = await seedCategory();
  const product = await seedProduct(category);
  const put = (body) => call("PUT", `/api/products/${product._id}`, body);

  let response = await put({ lowStockThreshold: 12 });
  assert.equal(response.status, 200);
  assert.equal(response.json.lowStockThreshold, 12);
  assert.equal(response.json.inventoryCount, 10);

  response = await put({ name: "اسم جديد" });
  assert.equal(response.json.lowStockThreshold, 12);

  response = await put({ lowStockThreshold: null });
  assert.equal("lowStockThreshold" in response.json, false);

  assert.equal((await put({ lowStockThreshold: -3 })).status, 400);
});
