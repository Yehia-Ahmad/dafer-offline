process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage26-test-secret-0123456789abcdef-0123456789";

// Stage 26: product barcodes. Validation (check digits), 0-5 per product, uniqueness across non-archived
// products (the partial unique index, proved with parallel saves), archive/unarchive, the in-store EAN-13
// generator (single + bulk), the by-barcode lookup, the search, the audit, migration 13, the permission.

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const AuditLog = require("../src/models/auditLog.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const ShopProfile = require("../src/models/shopProfile.model");
const { runMigrations, migrations } = require("../src/migrations");
const { ROLE_TEMPLATES, PERMISSIONS } = require("../src/auth/permissions");
const { barcodeProblem, barcodeType, normalizeBarcode, parseBarcodeList, ean13CheckDigit } = require("../src/utils/barcode");
const { ean13FromSeq, COUNTER_ID } = require("../src/services/barcodeGenerator");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27166 });
  await Product.init(); // the unique partial barcode index must exist before the race tests
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage26-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
}
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };
const login = async (username, password) => ok(await call("POST", "/api/auth/login", { username, password })).token;
const makeUser = async (username, role, permissions) => {
  ok(await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return login(username, "secret-pass-1");
};
const as = async (userToken, fn) => { const previous = token; token = userToken; try { return await fn(); } finally { token = previous; } };

// One category per test, made in beforeEach (parallel creates in the race tests share it).
let defaultCategory = null;
test.beforeEach(async () => { if (!mongodSkipReason) defaultCategory = await Category.create({ name: "S26 default" }); });
const category = async () => defaultCategory;
const body = async (code, barcodes, extra = {}) => ({ name: `منتج ${code}`, code, categoryId: String((extra.category || await category())._id), inventoryCount: 10, purchasePrice: 20, wholesalePrice: 25, retailPrice: 40, ...(barcodes !== undefined ? { barcodes } : {}), ...extra, category: undefined });
const create = async (code, barcodes, extra) => call("POST", "/api/products", await body(code, barcodes, extra));

// Real check digits: EAN-13 4006381333931, EAN-8 96385074, UPC-A 036000291452.
const EAN13 = "4006381333931";
const EAN8 = "96385074";
const UPCA = "036000291452";

// ---------- pure rules ----------

test("validation: Code 128-safe ASCII, 4-48 chars, EAN-13/EAN-8/UPC-A check digits", () => {
  assert.equal(barcodeProblem(EAN13), null);
  assert.equal(barcodeProblem(EAN8), null);
  assert.equal(barcodeProblem(UPCA), null);
  assert.equal(barcodeType(EAN13), "EAN-13");
  assert.equal(barcodeType(EAN8), "EAN-8");
  assert.equal(barcodeType(UPCA), "UPC-A");
  assert.equal(barcodeType("ABC-123"), "Code 128");
  assert.match(barcodeProblem("4006381333932"), /رقم التحقق/); // wrong EAN-13 check digit
  assert.match(barcodeProblem("96385075"), /رقم التحقق/); // wrong EAN-8
  assert.match(barcodeProblem("036000291453"), /رقم التحقق/); // wrong UPC-A
  assert.equal(barcodeProblem("1234567"), null); // 7 digits: not a checked length → Code 128
  assert.equal(barcodeType("1234567"), "Code 128");
  assert.equal(barcodeProblem("SKU-1.2/3+4"), null);
  assert.match(barcodeProblem("abc"), /من 4/);
  assert.match(barcodeProblem("x".repeat(49)), /48/);
  assert.match(barcodeProblem("AB CD"), /يقبل/);
  assert.match(barcodeProblem("منتج123"), /يقبل/);
  // Arabic-Indic / Persian digits and invisible marks are cleaned first.
  assert.equal(normalizeBarcode("‏٤٠٠٦٣٨١٣٣٣٩٣١​ "), EAN13);
  assert.equal(normalizeBarcode("۹۶۳۸۵۰۷۴"), EAN8);
  assert.deepEqual(parseBarcodeList([" ABC-1 ", EAN13]), ["ABC-1", EAN13]);
  assert.throws(() => parseBarcodeList(["A1B2", "A1B2"]), /متكرر/);
  assert.throws(() => parseBarcodeList(["AAAA1", "AAAA2", "AAAA3", "AAAA4", "AAAA5", "AAAA6"]), /5/);
  assert.equal(parseBarcodeList(undefined), undefined);
  assert.deepEqual(parseBarcodeList(null), []);
});

test("generator format: 290 + 9 digits + EAN-13 check digit", () => {
  const code = ean13FromSeq(125);
  assert.equal(code.length, 13);
  assert.equal(code.slice(0, 3), "290");
  assert.equal(code.slice(3, 12), "000000125");
  assert.equal(Number(code[12]), ean13CheckDigit(code.slice(0, 12)));
  assert.equal(barcodeType(code), "EAN-13");
});

test("permission: products.printLabels in the catalog; owner, manager, storekeeper have it, cashier does not", () => {
  assert.ok(PERMISSIONS["products.printLabels"]);
  assert.equal(PERMISSIONS["products.printLabels"].group, "products");
  for (const role of ["owner", "manager", "storekeeper"]) assert.ok(ROLE_TEMPLATES[role].includes("products.printLabels"), role);
  for (const role of ["cashier", "accountant"]) assert.equal(ROLE_TEMPLATES[role].includes("products.printLabels"), false, role);
});

// ---------- API ----------

it("create/update: barcodes validated (400 INVALID_BARCODE), 0-5, no repeats, normalized and stored", async () => {
  const created = ok(await create("B1", [EAN13, "‎abc-12", "٩٦٣٨٥٠٧٤"]), 201);
  assert.deepEqual(created.barcodes, [EAN13, "abc-12", EAN8]);
  const none = ok(await create("B2"), 201);
  assert.deepEqual(none.barcodes, []);

  let bad = await create("B3", ["4006381333932"]);
  assert.equal(bad.status, 400); assert.equal(bad.json.code, "INVALID_BARCODE"); assert.equal(bad.json.barcode, "4006381333932"); assert.match(bad.json.message, /رقم التحقق/);
  bad = await create("B3", ["A1B2", "A1B2"]);
  assert.equal(bad.status, 400); assert.equal(bad.json.code, "INVALID_BARCODE"); assert.match(bad.json.message, /متكرر/);
  bad = await create("B3", ["AAAA1", "AAAA2", "AAAA3", "AAAA4", "AAAA5", "AAAA6"]);
  assert.equal(bad.status, 400); assert.equal(bad.json.code, "INVALID_BARCODE");
  bad = await create("B3", "not-a-list");
  assert.equal(bad.status, 400);
  assert.equal(await Product.countDocuments({ code: "B3" }), 0);

  const updated = ok(await call("PUT", `/api/products/${none._id}`, { barcodes: [UPCA] }));
  assert.deepEqual(updated.barcodes, [UPCA]);
  // Absent → unchanged; null → cleared.
  assert.deepEqual(ok(await call("PUT", `/api/products/${none._id}`, { name: "اسم جديد" })).barcodes, [UPCA]);
  assert.deepEqual(ok(await call("PUT", `/api/products/${none._id}`, { barcodes: null })).barcodes, []);
  bad = await call("PUT", `/api/products/${none._id}`, { barcodes: ["036000291453"] });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, "INVALID_BARCODE");
});

it("uniqueness: 409 BARCODE_TAKEN with the other product's name and code (create and update)", async () => {
  const first = ok(await create("U1", [EAN13]), 201);
  const taken = await create("U2", ["X-9999", EAN13]);
  assert.equal(taken.status, 409);
  assert.equal(taken.json.code, "BARCODE_TAKEN");
  assert.equal(taken.json.barcode, EAN13);
  assert.equal(taken.json.product.name, "منتج U1");
  assert.equal(taken.json.product.code, "U1");
  assert.match(taken.json.message, /منتج U1/);
  const second = ok(await create("U2", ["X-9999"]), 201);
  const clash = await call("PUT", `/api/products/${second._id}`, { barcodes: ["X-9999", EAN13] });
  assert.equal(clash.status, 409); assert.equal(clash.json.code, "BARCODE_TAKEN"); assert.equal(String(clash.json.product._id), String(first._id));
  // A product may keep (re-save) its own barcode.
  ok(await call("PUT", `/api/products/${first._id}`, { barcodes: [EAN13, "NEW-1"] }));
});

it("race: two products saving the same barcode at once → exactly one wins, the other gets 409 BARCODE_TAKEN", async () => {
  for (let round = 0; round < 5; round += 1) {
    const code = `RACE-${round}`;
    const results = await Promise.all([create(`R${round}a`, [code]), create(`R${round}b`, [code])]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify(results.map((result) => result.json)));
    const loser = results.find((result) => result.status === 409);
    assert.equal(loser.json.code, "BARCODE_TAKEN");
    assert.match(loser.json.product.name, new RegExp(`R${round}[ab]`));
    assert.equal(await Product.countDocuments({ barcodes: code }), 1);
  }
  // An update racing a create.
  const target = ok(await create("RU", []), 201);
  const results = await Promise.all([call("PUT", `/api/products/${target._id}`, { barcodes: ["RACE-U"] }), create("RC", ["RACE-U"])]);
  // Exactly one of them wins: either the update (200) and the create loses (409), or the create (201) and the update loses.
  const [updateResult, createResult] = results;
  assert.ok(
    (updateResult.status === 200 && createResult.status === 409) || (updateResult.status === 409 && createResult.status === 201),
    JSON.stringify(results.map((result) => [result.status, result.json?.code]))
  );
  assert.equal(results.find((result) => result.status === 409).json.code, "BARCODE_TAKEN");
  assert.equal(await Product.countDocuments({ barcodes: "RACE-U" }), 1);
});

it("the database index itself refuses a duplicate written around the API (same barcode on two active products)", async () => {
  const cat = await category();
  await Product.create({ name: "a", code: "IA", category: cat._id, inventoryCount: 0, wholesalePrice: 1, retailPrice: 2, barcodes: ["IDX-1"] });
  await assert.rejects(
    Product.create({ name: "b", code: "IB", category: cat._id, inventoryCount: 0, wholesalePrice: 1, retailPrice: 2, barcodes: ["IDX-1"] }),
    (error) => error.code === 11000
  );
  // Many products with no barcode at all coexist (empty arrays are not indexed).
  await Product.create({ name: "c", code: "IC", category: cat._id, inventoryCount: 0, wholesalePrice: 1, retailPrice: 2, barcodes: [] });
  await Product.create({ name: "d", code: "ID", category: cat._id, inventoryCount: 0, wholesalePrice: 1, retailPrice: 2, barcodes: [] });
  await Product.create({ name: "e", code: "IE", category: cat._id, inventoryCount: 0, wholesalePrice: 1, retailPrice: 2 });
  const index = (await Product.collection.indexes()).find((entry) => entry.name === "barcodes_unique_active");
  assert.ok(index && index.unique);
  assert.deepEqual(index.partialFilterExpression, { isArchived: { $in: [false, null] }, barcodes: { $type: "string" } });
  // "Not archived" covers a missing flag and false alike: a raw document without isArchived clashes too.
  await assert.rejects(Product.collection.insertOne({ name: "raw", code: "IR", barcodes: ["IDX-1"] }), (error) => error.code === 11000);
  await assert.rejects(Product.collection.insertOne({ name: "raw", code: "IR", barcodes: ["IDX-1"], isArchived: null }), (error) => error.code === 11000);
  // An archived product may hold it.
  await Product.collection.insertOne({ name: "raw", code: "IR", barcodes: ["IDX-1"], isArchived: true });
});

async function archive(productId) {
  // A product referenced by an invoice is archived (not deleted) by DELETE.
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
  const customer = await Customer.create({ name: "عميل 26", phone: "01026262626" });
  const pad = (value) => String(value).padStart(2, "0");
  const d = new Date();
  ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, items: [{ productId, quantity: 1, price: 40 }] }), 201);
  const removed = ok(await call("DELETE", `/api/products/${productId}`));
  assert.equal(removed.action, "archived");
}

it("archive frees the barcode; unarchive with a conflict is blocked with a clear message", async () => {
  const old = ok(await create("A1", [EAN13]), 201);
  await archive(old._id);
  // Freed: another product may take it now.
  const replacement = ok(await create("A2", [EAN13]), 201);
  const restore = await call("POST", `/api/products/${old._id}/restore`);
  assert.equal(restore.status, 409);
  assert.equal(restore.json.code, "BARCODE_TAKEN");
  assert.match(restore.json.message, /مينفعش ترجّع المنتج/);
  assert.equal(String(restore.json.product._id), String(replacement._id));
  assert.equal((await Product.findById(old._id).lean()).isArchived, true);
  // Free it again → the unarchive works.
  ok(await call("PUT", `/api/products/${replacement._id}`, { barcodes: [] }));
  ok(await call("POST", `/api/products/${old._id}/restore`));
  assert.equal((await Product.findById(old._id).lean()).isArchived, false);
});

it("generate: an in-store EAN-13 (prefix 290, valid check digit) that skips numbers already taken", async () => {
  // Someone typed the next generated numbers by hand earlier (one on an archived product).
  await Counter.deleteMany({ _id: COUNTER_ID });
  ok(await create("G1", [ean13FromSeq(1)]), 201);
  const cat = await category();
  await Product.create({ name: "archived", code: "GA", category: cat._id, inventoryCount: 0, wholesalePrice: 1, retailPrice: 2, barcodes: [ean13FromSeq(2)], isArchived: true });
  const generated = ok(await call("POST", "/api/products/barcodes/generate"), 201);
  assert.equal(generated.barcode, ean13FromSeq(3));
  assert.equal(generated.type, "EAN-13");
  assert.equal(generated.barcode.slice(0, 3), "290");
  assert.equal(barcodeProblem(generated.barcode), null);
  const next = ok(await call("POST", "/api/products/barcodes/generate"), 201);
  assert.equal(next.barcode, ean13FromSeq(4));
});

it("bulk generate: count first, then one barcode for each product with none (category or all), reports the count", async () => {
  await Counter.deleteMany({ _id: COUNTER_ID });
  const catA = await Category.create({ name: "S26 A" });
  const catB = await Category.create({ name: "S26 B" });
  const withCode = ok(await create("K1", ["KEEP-1"], { category: catA }), 201);
  for (const code of ["K2", "K3", "K4"]) ok(await create(code, [], { category: catA }), 201);
  for (const code of ["K5", "K6"]) ok(await create(code, undefined, { category: catB }), 201);
  assert.equal(ok(await call("GET", `/api/products/barcodes/missing-count?categoryId=${catA._id}`)).count, 3);
  assert.equal(ok(await call("GET", "/api/products/barcodes/missing-count")).count, 5);

  assert.equal(ok(await call("POST", "/api/products/barcodes/generate-missing", { categoryId: String(catA._id) })).done, 3);
  assert.deepEqual((await Product.findById(withCode._id).lean()).barcodes, ["KEEP-1"]); // untouched
  const catAProducts = await Product.find({ category: catA._id, code: { $ne: "K1" } }).lean();
  for (const product of catAProducts) {
    assert.equal(product.barcodes.length, 1);
    assert.equal(barcodeType(product.barcodes[0]), "EAN-13");
    assert.equal(product.barcodes[0].slice(0, 3), "290");
  }
  assert.equal(new Set(catAProducts.map((product) => product.barcodes[0])).size, 3);
  assert.equal(ok(await call("GET", `/api/products/barcodes/missing-count?categoryId=${catB._id}`)).count, 2);
  assert.equal(ok(await call("POST", "/api/products/barcodes/generate-missing", {})).done, 2);
  assert.equal(ok(await call("POST", "/api/products/barcodes/generate-missing", {})).done, 0);
  assert.equal(await AuditLog.countDocuments({ action: "product.barcodes_changed", "details.generated": true }), 5);
});

it("by-barcode: exact match only, archived → 404 (archived flag), same fields and permission as the POS search, no cost for a cashier", async () => {
  const p = ok(await create("L1", [EAN13, "LOOK-1"]), 201);
  const found = ok(await call("GET", `/api/products/by-barcode/${EAN13}`));
  assert.equal(String(found._id), String(p._id));
  // Normalized: Arabic-Indic digits and an RLM still find it.
  assert.equal(String(ok(await call("GET", `/api/products/by-barcode/${encodeURIComponent("‏٤٠٠٦٣٨١٣٣٣٩٣١")}`))._id), String(p._id));
  // Exact only: a prefix, a suffix or a different case is not a match.
  for (const partial of ["400638133393", "LOOK", "look-1", "LOOK-12"]) {
    const missing = await call("GET", `/api/products/by-barcode/${partial}`);
    assert.equal(missing.status, 404, partial);
    assert.equal(missing.json.code, "BARCODE_NOT_FOUND");
    assert.equal(missing.json.archived, false);
  }
  // The internal code is not a barcode (the frontend helper looks codes up separately).
  assert.equal((await call("GET", "/api/products/by-barcode/L1")).status, 404);

  // Same fields as the POS search for the same user; the cashier sees no cost.
  const searchRow = ok(await call("GET", "/api/products/search?q=L1")).find((row) => String(row._id) === String(p._id));
  assert.deepEqual(Object.keys(found).sort(), Object.keys(searchRow).sort());
  assert.ok("purchasePrice" in found);
  const cashier = await makeUser("cashier26", "cashier");
  const asCashier = await as(cashier, () => call("GET", `/api/products/by-barcode/${EAN13}`));
  assert.equal(asCashier.status, 200);
  assert.equal("purchasePrice" in asCashier.json, false);
  const cashierSearch = (await as(cashier, () => call("GET", "/api/products/search?q=L1"))).json.find((row) => String(row._id) === String(p._id));
  assert.deepEqual(Object.keys(asCashier.json).sort(), Object.keys(cashierSearch).sort());
  // No products.view → 403 (same as the search).
  const nobody = await makeUser("nobody26", "custom", ["dashboard.view"]);
  assert.equal((await as(nobody, () => call("GET", `/api/products/by-barcode/${EAN13}`))).status, 403);
  assert.equal((await as(nobody, () => call("GET", "/api/products/search?q=L1"))).status, 403);

  // Archived → 404 with archived: true.
  await archive(p._id);
  const archived = await call("GET", `/api/products/by-barcode/${EAN13}`);
  assert.equal(archived.status, 404);
  assert.equal(archived.json.code, "BARCODE_NOT_FOUND");
  assert.equal(archived.json.archived, true);
  assert.match(archived.json.message, /متأرشف/);
});

it("search: GET products/search and GET products?search match a barcode exactly (never partially)", async () => {
  const p = ok(await create("S1", ["SCAN-777"]), 201);
  ok(await create("S2", ["OTHER-1"]), 201);
  const hit = ok(await call("GET", "/api/products/search?q=SCAN-777"));
  assert.deepEqual(hit.map((row) => String(row._id)), [String(p._id)]);
  assert.deepEqual(ok(await call("GET", "/api/products/search?q=SCAN-77")), []);
  assert.deepEqual(ok(await call("GET", "/api/products/search?code=SCAN-777")).map((row) => String(row._id)), [String(p._id)]);
  const list = ok(await call("GET", "/api/products?search=SCAN-777"));
  assert.deepEqual(list.data.map((row) => String(row._id)), [String(p._id)]);
  assert.equal(ok(await call("GET", "/api/products?search=SCAN-7")).data.length, 0);
});

it("generate permissions: products.manage (a cashier gets 403); by-barcode works for the cashier", async () => {
  ok(await create("P1", ["PERM-1"]), 201);
  const cashier = await makeUser("cashier26b", "cashier");
  assert.equal((await as(cashier, () => call("POST", "/api/products/barcodes/generate"))).status, 403);
  assert.equal((await as(cashier, () => call("GET", "/api/products/barcodes/missing-count"))).status, 403);
  assert.equal((await as(cashier, () => call("POST", "/api/products/barcodes/generate-missing", {}))).status, 403);
  assert.equal((await as(cashier, () => call("GET", "/api/products/by-barcode/PERM-1"))).status, 200);
  const keeper = await makeUser("keeper26", "storekeeper");
  assert.equal((await as(keeper, () => call("POST", "/api/products/barcodes/generate"))).status, 201);
  const me = ok(await as(keeper, () => call("GET", "/api/auth/me")));
  assert.ok((me.permissions || me.user?.permissions || []).includes("products.printLabels"));
});

it("audit: barcode changes are recorded on the product (before → after), other edits are not", async () => {
  const p = ok(await create("AU1", ["AUD-1"]), 201);
  ok(await call("PUT", `/api/products/${p._id}`, { barcodes: ["AUD-1", "AUD-2"] }));
  ok(await call("PUT", `/api/products/${p._id}`, { name: "اسم تاني", barcodes: ["AUD-1", "AUD-2"] })); // unchanged list
  ok(await call("PUT", `/api/products/${p._id}`, { barcodes: [] }));
  const entries = await AuditLog.find({ action: "product.barcodes_changed", entityId: String(p._id) }).sort({ at: 1, _id: 1 }).lean();
  assert.deepEqual(entries.map((entry) => [entry.details.before, entry.details.after]), [
    [[], ["AUD-1"]],
    [["AUD-1"], ["AUD-1", "AUD-2"]],
    [["AUD-1", "AUD-2"], []],
  ]);
  assert.equal(entries[0].entity, "Product");
});

it("migration 13: existing products get barcodes []; isArchived untouched; nothing generated", async () => {
  const cat = await category();
  await Product.collection.insertMany([
    { name: "old1", code: "M1", category: cat._id, inventoryCount: 1, wholesalePrice: 1, retailPrice: 2 },
    { name: "old2", code: "M2", category: cat._id, inventoryCount: 1, wholesalePrice: 1, retailPrice: 2, isArchived: null },
    { name: "old3", code: "M3", category: cat._id, inventoryCount: 1, wholesalePrice: 1, retailPrice: 2, isArchived: true },
    { name: "old4", code: "M4", category: cat._id, inventoryCount: 1, wholesalePrice: 1, retailPrice: 2, isArchived: false, barcodes: ["KEPT-1"] },
  ]);
  const migration = migrations.find((entry) => entry.version === 13);
  assert.ok(migration);
  await migration.run(null);
  const rows = Object.fromEntries((await Product.collection.find({ code: /^M/ }).toArray()).map((row) => [row.code, row]));
  assert.deepEqual(rows.M1.barcodes, []); assert.equal("isArchived" in rows.M1, false);
  assert.deepEqual(rows.M2.barcodes, []); assert.equal(rows.M2.isArchived, null);
  assert.deepEqual(rows.M3.barcodes, []); assert.equal(rows.M3.isArchived, true);
  assert.deepEqual(rows.M4.barcodes, ["KEPT-1"]); assert.equal(rows.M4.isArchived, false);
  assert.equal(rows.M1.updatedAt, undefined); // not an edit
  // Twice is harmless.
  await migration.run(null);
  assert.equal(await Product.countDocuments({ code: /^M/, barcodes: { $size: 0 } }), 3);
  // Full run from an older schema also applies the next migration.
  await Meta.deleteMany({}); await Meta.create({ _id: "schema", version: 12 });
  assert.equal(await runMigrations(), 14);
});

it("migration 14: existing shop profiles get retail as the default sale price without overwriting a choice", async () => {
  await ShopProfile.collection.insertMany([
    { key: "default", name: "old shop" },
    { key: "other", name: "chosen shop", defaultSalePriceType: "wholesalePrice" },
  ]);
  const migration = migrations.find((entry) => entry.version === 14);
  assert.ok(migration);
  await migration.run(null);
  assert.equal((await ShopProfile.collection.findOne({ key: "default" })).defaultSalePriceType, "retailPrice");
  assert.equal((await ShopProfile.collection.findOne({ key: "other" })).defaultSalePriceType, "wholesalePrice");
  await migration.run(null);
  assert.equal(await ShopProfile.countDocuments({ defaultSalePriceType: "retailPrice" }), 1);
});

it("Excel workbook: export writes a Barcodes column, import reads it and refuses a barcode another product holds", async () => {
  const { exportCategories } = require("../src/services/categoryImportExport.service");
  const XLSX = require("xlsx");
  const cat = await Category.create({ name: "S26 Excel" });
  ok(await create("E1", ["XL-1", EAN13], { category: cat }), 201);
  const buffer = await exportCategories();
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Products, { defval: "" });
  const row = rows.find((entry) => entry.Code === "E1");
  assert.equal(row.Barcodes, `XL-1 ${EAN13}`);
  const headers = XLSX.utils.sheet_to_json(workbook.Sheets.Products, { header: 1 })[0];
  assert.equal(headers[headers.indexOf("Code") + 1], "Barcodes");

  // Import: new rows (no ProductId) into a new category: one with a free barcode, one with a held barcode, one invalid.
  const { importCategories } = require("../src/services/categoryImportExport.service");
  const { withTransaction } = require("../src/utils/transaction");
  const base = { ProductId: "", CategoryId: "", CategoryName: "S26 Import", InventoryCount: 0, ImageBase64: "", WholesalePrice: 5, PurchasePrice: 1, RetailPrice: 6, SoldItemCount: 0, Specifications: "", CreatedAt: "", UpdatedAt: "" };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ Name: "S26 Import", ImageBase64: "", Specifications: "" }]), "Categories");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([
    { ...base, Name: "free", Code: "E2", Barcodes: "XL-2 XL-3" },
    { ...base, Name: "held", Code: "E3", Barcodes: "XL-1" },
    { ...base, Name: "bad", Code: "E4", Barcodes: "4006381333932" },
  ], { header: [...Object.keys(base).slice(0, 3), "Name", "Code", "Barcodes", ...Object.keys(base).slice(3)] }), "Products");
  const result = await withTransaction((session) => importCategories(XLSX.write(book, { type: "buffer", bookType: "xlsx" }), session));
  assert.equal(result.productImportedCount, 1, JSON.stringify(result));
  assert.deepEqual((await Product.findOne({ code: "E2" }).lean()).barcodes, ["XL-2", "XL-3"]);
  const messages = result.productErrors.map((entry) => entry.message).join(" | ");
  assert.match(messages, /XL-1/);
  assert.match(messages, /منتج E1/);
  assert.match(messages, /رقم التحقق/);
  assert.equal(await Product.countDocuments({ code: { $in: ["E3", "E4"] } }), 0);
});
