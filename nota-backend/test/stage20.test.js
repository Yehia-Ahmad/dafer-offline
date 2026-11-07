process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage20-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const CashBox = require("../src/models/cashBox.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const Purchase = require("../src/models/purchase.model");
const Supplier = require("../src/models/supplier.model");
const PartyOpening = require("../src/models/partyOpening.model");
const SupplierPayment = require("../src/models/supplierPayment.model");
const { runMigrations } = require("../src/migrations");
const { allocateCosts, weightedAverage } = require("../src/accounting/purchaseCost");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27121 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage20-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token; ownerToken = token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text(); return { status: response.status, json: text ? JSON.parse(text) : null };
}
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function product({ code, stock = 50, cost = 20, name } = {}) {
  const category = await Category.create({ name: `Stage20 ${code || Math.random()}` });
  const response = await call("POST", "/api/products", { name: name || code || "Product", code: code || `P-${Math.random()}`, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 10 });
  assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json;
}
const stockOf = async (p) => (await Product.findById(p._id).lean());
const sold = async (p, price = 100, quantity = 1) => {
  const sale = await call("POST", "/api/sellings", { customerName: "Cash customer", customerPhone: "01017171718", sellingDate: "2026-11-05", items: [{ productId: p._id, quantity, price }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.json)); return sale.json;
};
async function keyed(entry) {
  const accounts = await Account.find({}).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey || account.code]));
  return entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit, partyId: row.partyId }));
}
const entriesOf = async (type, id) => Promise.all((await JournalEntry.find({ "source.type": type, "source.id": id }).sort({ createdAt: 1 }).lean()).map(async (entry) => ({ type: entry.type, lines: await keyed(entry) })));
const lineOf = (entry, key, side) => entry.lines.find((row) => row.key === key && row[side] > 0);
async function health() { const response = await call("GET", "/api/accounting/health"); assert.equal(response.status, 200); return response.json; }
async function assertHealthy() {
  const report = await health();
  for (const [name, check] of Object.entries(report)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
  return report;
}
const login = async (username, password) => { const response = await call("POST", "/api/auth/login", { username, password }); assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json.token; };
const makeUser = async (username, role, permissions) => {
  const created = await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return login(username, "secret-pass-1");
};
const createBox = async (body, headers = {}) => { const response = await call("POST", "/api/cashbox/boxes", body, headers); assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json; };
const balanceOf = async (box) => (await call("GET", `/api/cashbox/boxes/${box._id}`)).json.balance;

/** The design's shop: main box 18,400, Banque Misr 41,000, the lighting supplier with an opening of 4,200. */
async function shop({ withProducts = true } = {}) {
  await startLedger();
  const supplier = await Supplier.create({ name: "الشركة المصرية للإضاءة", paymentTermsDays: 30 });
  const other = await Supplier.create({ name: "مؤسسة الفتح للأسلاك" });
  const saved = await call("POST", "/api/accounting/opening", { cash: 18400, banks: [{ name: "بنك مصر", type: "bank", amount: 41000 }], suppliers: [{ supplierId: String(supplier._id), amount: 4200 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const list = (await call("GET", "/api/cashbox/boxes")).json.data;
  const out = { supplier, other, main: list.find((box) => box.isMain), bank: list.find((box) => box.type === "bank") };
  if (withProducts) {
    out.led = await product({ code: "LED12", stock: 32, cost: 70, name: "لمبة LED ١٢ وات" });
    out.charger = await product({ code: "CHG25", stock: 13, cost: 240, name: "شاحن تايب سي ٢٥ وات" });
    out.outlet = await product({ code: "OUT3", stock: 6, cost: 55, name: "بريزة ثلاثية" });
  }
  return out;
}
const supplierBalance = async (supplier) => (await call("GET", `/api/suppliers/${supplier._id}`)).json.balance;
const buy = async (body, expected = 201) => { const response = await call("POST", "/api/purchases", body); assert.equal(response.status, expected, JSON.stringify(response.json)); return response.json; };
const designInvoice = (s, extra = {}) => ({
  supplierId: String(s.supplier._id), supplierInvoiceNo: "EL-8841", date: "2026-11-03",
  items: [{ productId: s.led._id, qty: 20, unitPrice: 70 }, { productId: s.charger._id, qty: 10, unitPrice: 240 }, { productId: s.outlet._id, qty: 30, unitPrice: 55 }],
  paidAmount: 3000, boxId: s.main._id, ...extra,
});

// ------------------------------------------------------------ pure rules

it("cost rules: weighted average and allocation are exact", () => {
  assert.equal(weightedAverage(10, 20, 10, 300), 25);
  assert.equal(weightedAverage(0, 20, 10, 300), 30);
  assert.equal(weightedAverage(-4, 20, 10, 300), 30);
  assert.equal(weightedAverage(3, 10, 7, 72.31), 10.23);
  for (const [totals, discount, other] of [[[1400, 2400, 1650], 0, 0], [[100, 100, 100], 10, 0], [[333.33, 666.67, 1], 7.77, 12.34], [[10, 20, 30, 40], 0.01, 0.02], [[5], 1, 0]]) {
    const { lineCosts, subtotal, total } = allocateCosts(totals, discount, other);
    assert.equal(Math.round(lineCosts.reduce((sum, value) => sum + value, 0) * 100) / 100, total, JSON.stringify({ totals, discount, other, lineCosts }));
    assert.equal(total, Math.round((subtotal - discount + other) * 100) / 100);
  }
});

// ------------------------------------------------------------ the design's numbers

it("the design's invoice: 5,450, 3,000 from the main box, two entries, supplier balance 4,200 -> 6,650", async () => {
  const s = await shop();
  assert.equal(await supplierBalance(s.supplier), 4200);
  const mainBefore = await balanceOf(s.main);
  const purchase = await buy(designInvoice(s));
  assert.equal(purchase.number, "PO-000001"); assert.equal(purchase.pvNumber, "PV-000001");
  assert.equal(purchase.subtotal, 5450); assert.equal(purchase.total, 5450); assert.equal(purchase.paidAmount, 3000);
  assert.equal(purchase.supplierBalanceAfter, 6650);
  const [entry] = await entriesOf("purchase", purchase._id);
  assert.equal(lineOf(entry, "INVENTORY", "debit").debit, 5450); assert.equal(lineOf(entry, "SUPPLIERS", "credit").credit, 5450);
  assert.equal(entry.lines.length, 2, "no rounding on the design's invoice");
  const pv = await SupplierPayment.findById(purchase.pvId).lean();
  assert.equal(pv.number, "PV-000001"); assert.equal(String(pv.purchaseId), purchase._id);
  const [pvEntry] = await entriesOf("supplier_payment", pv._id);
  assert.equal(lineOf(pvEntry, "SUPPLIERS", "debit").debit, 3000); assert.equal(lineOf(pvEntry, "CASH_MAIN", "credit").credit, 3000);
  assert.equal(await supplierBalance(s.supplier), 6650);
  assert.equal(await balanceOf(s.main), mainBefore - 3000);
  assert.deepEqual([(await stockOf(s.led)).inventoryCount, (await stockOf(s.charger)).inventoryCount, (await stockOf(s.outlet)).inventoryCount], [52, 23, 36]);
  assert.deepEqual(purchase.items.map((row) => row.unitCost), [70, 240, 55]);
  assert.equal((await stockOf(s.led)).purchasePrice, 70, "32 at 70 + 20 at 70");
  await assertHealthy();
});

it("the design's payment: 2,500 from the bank takes 6,650 to 4,150", async () => {
  const s = await shop();
  await buy(designInvoice(s));
  const bankBefore = await balanceOf(s.bank);
  const paid = await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 2500, boxId: s.bank._id, reference: "CHQ-77", note: "دفعة" });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.equal(paid.json.number, "PV-000002"); assert.equal(paid.json.balanceAfter, 4150);
  assert.equal(await supplierBalance(s.supplier), 4150); assert.equal(await balanceOf(s.bank), bankBefore - 2500);
  await assertHealthy();
});

// ------------------------------------------------------------ weighted average

it("weighted average: 10 at 20 + 10 at 30 -> 25; stock 0 and negative stock take the purchase price; health 0", async () => {
  const s = await shop({ withProducts: false });
  const a = await product({ code: "AVG-A", stock: 10, cost: 20 }); const b = await product({ code: "AVG-B", stock: 0, cost: 99 });
  await buy({ supplierId: String(s.supplier._id), items: [{ productId: a._id, qty: 10, unitPrice: 30 }, { productId: b._id, qty: 4, unitPrice: 12 }] });
  assert.equal((await stockOf(a)).purchasePrice, 25); assert.equal((await stockOf(a)).inventoryCount, 20);
  assert.equal((await stockOf(b)).purchasePrice, 12);
  await assertHealthy();
  // negative stock (forced): the purchase price wins, whatever the old cost was
  const c = await product({ code: "AVG-C", stock: 5, cost: 20 });
  await Product.updateOne({ _id: c._id }, { $set: { inventoryCount: -3 } });
  await buy({ supplierId: String(s.supplier._id), items: [{ productId: c._id, qty: 10, unitPrice: 30 }] });
  assert.equal((await stockOf(c)).purchasePrice, 30); assert.equal((await stockOf(c)).inventoryCount, 7);
});

it("rounding: 3 at 10 + 7 at 10.33 posts the cent to INVENTORY_ADJUSTMENT and health stays 0 (largest rounding seen: 0.01)", async () => {
  const s = await shop({ withProducts: false });
  const p = await product({ code: "ROUND", stock: 3, cost: 10 });
  const purchase = await buy({ supplierId: String(s.supplier._id), items: [{ productId: p._id, qty: 7, unitPrice: 10.33 }] });
  assert.equal(purchase.total, 72.31); assert.equal((await stockOf(p)).purchasePrice, 10.23);
  const [entry] = await entriesOf("purchase", purchase._id);
  assert.equal(lineOf(entry, "INVENTORY", "debit").debit, 72.3); assert.equal(lineOf(entry, "INVENTORY_ADJUSTMENT", "debit").debit, 0.01);
  assert.equal(lineOf(entry, "SUPPLIERS", "credit").credit, 72.31);
  await assertHealthy();
  // a spread of awkward prices: the rounding is never more than a few piasters and health never moves
  let largest = 0;
  for (const [qty, price] of [[3, 3.33], [7, 7.77], [11, 0.99], [13, 1.01], [17, 19.99], [19, 4.57]]) {
    const q = await product({ code: `R-${qty}`, stock: qty, cost: 5.05 });
    const bought = await buy({ supplierId: String(s.supplier._id), items: [{ productId: q._id, qty: 7, unitPrice: price }] });
    const [e] = await entriesOf("purchase", bought._id);
    const adjustment = e.lines.find((row) => row.key === "INVENTORY_ADJUSTMENT");
    largest = Math.max(largest, adjustment ? adjustment.debit + adjustment.credit : 0);
  }
  assert.ok(largest <= 0.1, `largest rounding ${largest}`); console.log(`# largest rounding seen: ${largest}`);
  await assertHealthy();
});

it("discount and other costs are allocated by line value; Σ line costs = the total; they live in the product cost", async () => {
  const s = await shop({ withProducts: false });
  const a = await product({ code: "ALLOC-A", stock: 0, cost: 1 }); const b = await product({ code: "ALLOC-B", stock: 0, cost: 1 }); const c = await product({ code: "ALLOC-C", stock: 0, cost: 1 });
  const purchase = await buy({ supplierId: String(s.supplier._id), discountAmount: 100, otherCosts: 50.5, items: [{ productId: a._id, qty: 3, unitPrice: 111.11 }, { productId: b._id, qty: 7, unitPrice: 33.33 }, { productId: c._id, qty: 1, unitPrice: 5 }] });
  assert.equal(purchase.subtotal, 571.64); assert.equal(purchase.total, 522.14);
  assert.equal(Math.round(purchase.items.reduce((sum, row) => sum + row.lineCost, 0) * 100) / 100, 522.14);
  assert.equal(purchase.items[0].unitCost, Math.round((purchase.items[0].lineCost / 3) * 10000) / 10000);
  const [entry] = await entriesOf("purchase", purchase._id);
  assert.equal(lineOf(entry, "SUPPLIERS", "credit").credit, 522.14);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "cost_revaluation" }), 0, "a purchase is not a cost revaluation");
  await assertHealthy();
  assert.equal((await call("POST", "/api/purchases", { supplierId: String(s.supplier._id), discountAmount: 999, items: [{ productId: a._id, qty: 1, unitPrice: 5 }] })).status, 400);
});

// ------------------------------------------------------------ payment modes and permissions

it("payment modes: all cash, part cash, all credit; paid above the total is refused; box balance and shifts apply", async () => {
  const s = await shop();
  const body = (paid) => designInvoice(s, { paidAmount: paid, boxId: paid ? s.main._id : undefined });
  const full = await buy(body(5450)); assert.equal(full.supplierBalanceAfter, 4200);
  const part = await buy(body(1000)); assert.equal(part.supplierBalanceAfter, 8650);
  const credit = await buy(body(0)); assert.equal(credit.pvNumber, null); assert.equal(credit.pvId, undefined); assert.equal(credit.supplierBalanceAfter, 14100);
  assert.equal((await call("POST", "/api/purchases", body(5451))).json.code, "PAID_EXCEEDS_TOTAL");
  assert.equal((await call("POST", "/api/purchases", body(1e9))).status, 400);
  assert.equal(await SupplierPayment.countDocuments({}), 2);
  await assertHealthy();
  // the box must cover the paid amount
  const poor = await createBox({ name: "Poor wallet", type: "wallet" });
  assert.equal((await call("POST", "/api/purchases", designInvoice(s, { paidAmount: 100, boxId: poor._id }))).json.code, "INSUFFICIENT_BALANCE");
  // a shift box needs an open shift
  const shifty = await createBox({ name: "Shift bank", type: "bank", shiftsEnabled: true, openingAmount: 0 });
  assert.equal((await call("POST", "/api/purchases", designInvoice(s, { paidAmount: 10, boxId: shifty._id }))).status, 409);
  assert.equal(await Purchase.countDocuments({}), 3, "a refused purchase leaves nothing behind");
});

it("permissions: a storekeeper buys on credit only; the cashier has no purchase access; the viewCost dependency", async () => {
  const s = await shop();
  const keeper = await makeUser("keeper", "storekeeper"); const cashier = await makeUser("cashier", "cashier"); const accountant = await makeUser("acc", "accountant");
  token = keeper;
  const credit = await buy(designInvoice(s, { paidAmount: 0, boxId: undefined })); assert.equal(credit.paidAmount, 0);
  assert.equal((await call("POST", "/api/purchases", designInvoice(s, { paidAmount: 100 }))).status, 403);
  assert.equal((await call("GET", "/api/purchases")).status, 200);
  assert.equal((await call("POST", `/api/purchases/${credit._id}/cancel`, { reason: "no" })).status, 403);
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 10, boxId: s.main._id })).status, 403);
  token = cashier;
  assert.equal((await call("GET", "/api/purchases")).status, 403); assert.equal((await call("POST", "/api/purchases", designInvoice(s, { paidAmount: 0 }))).status, 403);
  assert.equal((await call("GET", `/api/suppliers/${s.supplier._id}/statement`)).status, 403);
  token = accountant;
  assert.equal((await call("GET", "/api/purchases")).status, 200); assert.equal((await call("POST", "/api/purchases", designInvoice(s, { paidAmount: 0 }))).status, 403);
  const bankPay = await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 100, boxId: s.bank._id }); assert.equal(bankPay.status, 201, JSON.stringify(bankPay.json));
  token = ownerToken;
  for (const role of ["manager", "owner"]) assert.ok(["purchases.view", "purchases.create", "purchases.cancel", "suppliers.pay"].every((key) => ROLE_TEMPLATES[role].includes(key)));
  assert.ok(!ROLE_TEMPLATES.cashier.some((key) => key.startsWith("purchases.") || key === "suppliers.pay"));
  for (const key of ["purchases.view", "purchases.create", "purchases.cancel"]) {
    const refused = await call("POST", "/api/users", { name: "x", username: `dep-${key}`, password: "secret-pass-1", role: "custom", permissions: [key] });
    assert.equal(refused.status, 400); assert.equal(refused.json.code, "PERMISSION_DEPENDENCY"); assert.deepEqual(refused.json.permissions, ["products.viewCost"]);
  }
  assert.equal((await call("POST", "/api/users", { name: "ok", username: "dep-ok", password: "secret-pass-1", role: "custom", permissions: ["purchases.view", "products.viewCost"] })).status, 201);
});

// ------------------------------------------------------------ supplier payments

it("a payment above what we owe needs an explicit confirm and becomes an advance (لينا); cancel puts it back", async () => {
  const s = await shop();
  const url = `/api/suppliers/${s.supplier._id}/payments`;
  const refused = await call("POST", url, { amount: 5000, boxId: s.main._id });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "ADVANCE_NOT_CONFIRMED"); assert.equal(refused.json.balance, 4200); assert.equal(refused.json.advance, 800);
  assert.equal(await SupplierPayment.countDocuments({}), 0);
  const advance = await call("POST", url, { amount: 5000, boxId: s.main._id, confirmAdvance: true }); assert.equal(advance.status, 201);
  assert.equal(advance.json.balanceAfter, -800); assert.equal(await supplierBalance(s.supplier), -800);
  const list = (await call("GET", "/api/suppliers")).json.find((row) => row._id === String(s.supplier._id)); assert.equal(list.balance, -800);
  await assertHealthy();
  // an exact payment needs no confirm
  assert.equal((await call("POST", url, { amount: 100, boxId: s.main._id })).status, 409, "more than we owe now (we owe nothing)");
  const cancelled = await call("POST", `/api/supplier-payments/${advance.json._id}/cancel`, { reason: "paid by mistake" }); assert.equal(cancelled.status, 200);
  assert.equal(await supplierBalance(s.supplier), 4200);
  assert.equal((await call("POST", `/api/supplier-payments/${advance.json._id}/cancel`, { reason: "again" })).status, 409);
  assert.equal((await call("POST", `/api/supplier-payments/${advance.json._id}/cancel`, { reason: "" })).status, 400, "the reason is checked first");
  await assertHealthy();
});

it("payments: validation, box rules and the cancel into an inactive box (409)", async () => {
  const s = await shop();
  const url = `/api/suppliers/${s.supplier._id}/payments`;
  assert.equal((await call("POST", url, { amount: 0, boxId: s.main._id })).status, 400); assert.equal((await call("POST", url, { amount: 10.123, boxId: s.main._id })).status, 400);
  assert.equal((await call("POST", url, { amount: 99999, boxId: s.main._id, confirmAdvance: true })).json.code, "INSUFFICIENT_BALANCE");
  assert.equal((await call("POST", "/api/suppliers/64b7f0f0f0f0f0f0f0f0f0f0/payments", { amount: 10, boxId: s.main._id })).status, 404);
  const wallet = await createBox({ name: "Temp wallet", type: "wallet" });
  const funding = await call("POST", "/api/cashbox/transfers", { fromBoxId: s.main._id, toBoxId: wallet._id, amount: 1000 }); assert.equal(funding.status, 201);
  const paid = await call("POST", url, { amount: 400, boxId: wallet._id }); assert.equal(paid.status, 201);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${wallet._id}`, { isActive: false })).status, 409, "a box with a balance cannot be closed");
  assert.equal((await call("POST", "/api/cashbox/transfers", { fromBoxId: wallet._id, toBoxId: s.main._id, amount: 600 })).status, 201);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${wallet._id}`, { isActive: false })).status, 200);
  const refused = await call("POST", `/api/supplier-payments/${paid.json._id}/cancel`, { reason: "box is closed" });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "BOX_INACTIVE");
  assert.equal(await supplierBalance(s.supplier), 3800);
});

// ------------------------------------------------------------ returns and refunds

it("purchase return: partial, then the rest; over-return 409; the cost difference goes to INVENTORY_ADJUSTMENT; health 0", async () => {
  const s = await shop();
  await buy(designInvoice(s));
  // 20 more LED at 100: the average becomes (52 x 70 + 2,000) / 72 = 78.33
  const purchase = await buy({ supplierId: String(s.supplier._id), items: [{ productId: s.led._id, qty: 20, unitPrice: 100 }] });
  assert.equal((await stockOf(s.led)).purchasePrice, 78.33); assert.equal((await stockOf(s.led)).inventoryCount, 72);
  const balanceBefore = await supplierBalance(s.supplier);
  const item = purchase.items[0];
  const first = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: item._id, qty: 5 }], reason: "damaged" });
  assert.equal(first.status, 201, JSON.stringify(first.json)); assert.equal(first.json.number, "PR-000001"); assert.equal(first.json.total, 500);
  assert.equal(first.json.supplierBalanceAfter, balanceBefore - 500);
  assert.equal((await stockOf(s.led)).inventoryCount, 67); assert.equal((await stockOf(s.led)).purchasePrice, 78.33, "the average is unchanged");
  const [entry] = await entriesOf("purchase_return", first.json._id);
  assert.equal(lineOf(entry, "SUPPLIERS", "debit").debit, 500); assert.equal(lineOf(entry, "INVENTORY", "credit").credit, 391.65);
  assert.equal(lineOf(entry, "INVENTORY_ADJUSTMENT", "credit").credit, 108.35, "the goods left at 78.33 but the supplier credits 100 each");
  await assertHealthy();
  const over = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: item._id, qty: 16 }] });
  assert.equal(over.status, 409); assert.equal(over.json.code, "OVER_RETURN"); assert.equal(over.json.available, 15);
  const rest = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: item._id, qty: 15 }] });
  assert.equal(rest.status, 201); assert.equal(rest.json.total, 1500, "5 + 15 returns add up to the line cost exactly");
  assert.equal((await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: item._id, qty: 1 }] })).json.code, "OVER_RETURN");
  assert.equal((await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [] })).status, 400);
  assert.equal((await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: "64b7f0f0f0f0f0f0f0f0f0f0", qty: 1 }] })).status, 400);
  assert.equal((await call("GET", `/api/purchases/${purchase._id}`)).json.returns.length, 2);
  await assertHealthy();
});

it("purchase return: stock already sold is refused (409 STOCK_ALREADY_USED) and nothing changes", async () => {
  const s = await shop({ withProducts: false });
  const p = await product({ code: "SOLD-OUT", stock: 0, cost: 10 });
  const purchase = await buy({ supplierId: String(s.supplier._id), items: [{ productId: p._id, qty: 5, unitPrice: 10 }] });
  await sold(p, 100, 4);
  const refused = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[0]._id, qty: 2 }] });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "STOCK_ALREADY_USED");
  assert.equal((await stockOf(p)).inventoryCount, 1); assert.equal((await Purchase.findById(purchase._id).lean()).items[0].returnedQty, 0);
  assert.equal((await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[0]._id, qty: 1 }] })).status, 201);
  await assertHealthy();
});

it("supplier refunds: cash only comes back for what the supplier owes US (return refund capped at min(value, advance)); standalone refunds; SR into a box", async () => {
  const s = await shop();
  const purchase = await buy(designInvoice(s, { paidAmount: 5450 })); // fully paid; the 4,200 opening is still owed
  const mainBefore = await balanceOf(s.main);
  const chargers = purchase.items[1]; const outlets = purchase.items[2];
  const returnUrl = `/api/purchases/${purchase._id}/returns`;
  // while we still owe the supplier a return only reduces what we owe: no cash comes back, and nothing is posted
  const refused = await call("POST", returnUrl, { items: [{ itemId: chargers._id, qty: 2 }], refundAmount: 480, boxId: s.main._id, reason: "wrong model" });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "REFUND_EXCEEDS_DUE"); assert.equal(refused.json.due, 0);
  assert.equal((await call("GET", `/api/purchases/${purchase._id}`)).json.returns.length, 0, "the refused return left nothing behind");
  assert.equal((await stockOf(s.charger)).inventoryCount, 23); assert.equal(await balanceOf(s.main), mainBefore);
  const plain = await call("POST", returnUrl, { items: [{ itemId: chargers._id, qty: 2 }], reason: "wrong model" });
  assert.equal(plain.status, 201, JSON.stringify(plain.json)); assert.equal(plain.json.supplierBalanceAfter, 4200 - 480);
  // an advance: 4,000 paid over what we owe turns the balance into -280
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 4000, boxId: s.bank._id, confirmAdvance: true })).status, 201);
  assert.equal(await supplierBalance(s.supplier), -280);
  // a return of 55 with a refund of 56: capped at min(55, 335) = 55
  const over = await call("POST", returnUrl, { items: [{ itemId: outlets._id, qty: 1 }], refundAmount: 56, boxId: s.main._id });
  assert.equal(over.status, 409); assert.equal(over.json.code, "REFUND_EXCEEDS_DUE"); assert.equal(over.json.due, 55);
  const returned = await call("POST", returnUrl, { items: [{ itemId: outlets._id, qty: 1 }], refundAmount: 55, boxId: s.main._id });
  assert.equal(returned.status, 201, JSON.stringify(returned.json)); assert.equal(returned.json.refund.number, "SR-000001");
  assert.equal(returned.json.supplierBalanceAfter, -280, "55 returned, 55 refunded");
  assert.equal(await balanceOf(s.main), mainBefore + 55);
  const [srEntry] = await entriesOf("supplier_refund", returned.json.refund._id);
  assert.equal(lineOf(srEntry, "CASH_MAIN", "debit").debit, 55); assert.equal(lineOf(srEntry, "SUPPLIERS", "credit").credit, 55);
  // the advance left is 280: a standalone refund up to it
  const tooMuch = await call("POST", `/api/suppliers/${s.supplier._id}/refunds`, { amount: 281, boxId: s.main._id });
  assert.equal(tooMuch.status, 409); assert.equal(tooMuch.json.code, "REFUND_EXCEEDS_DUE");
  const bankBefore = await balanceOf(s.bank);
  const standalone = await call("POST", `/api/suppliers/${s.supplier._id}/refunds`, { amount: 280, boxId: s.bank._id, note: "advance back" });
  assert.equal(standalone.status, 201, JSON.stringify(standalone.json)); assert.equal(standalone.json.number, "SR-000002");
  assert.equal(await balanceOf(s.bank), bankBefore + 280); assert.equal(await supplierBalance(s.supplier), 0);
  assert.equal((await call("GET", `/api/suppliers/${s.supplier._id}/refunds`)).json.data.length, 2);
  await assertHealthy();
  // storekeeper cannot take money back
  token = await makeUser("keeper2", "storekeeper");
  assert.equal((await call("POST", returnUrl, { items: [{ itemId: outlets._id, qty: 1 }], refundAmount: 10, boxId: s.main._id })).status, 403);
  assert.equal((await call("POST", returnUrl, { items: [{ itemId: outlets._id, qty: 1 }] })).status, 201);
});

it("a credit purchase of 100 returned in full with a refund of 100 is refused (409 REFUND_EXCEEDS_DUE): we still owe the supplier", async () => {
  const s = await shop({ withProducts: false });
  const p = await product({ code: "CREDIT-RET", stock: 0, cost: 10 });
  const purchase = await buy({ supplierId: String(s.other._id), items: [{ productId: p._id, qty: 10, unitPrice: 10 }] });
  assert.equal(await supplierBalance(s.other), 100);
  const refused = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[0]._id, qty: 10 }], refundAmount: 100, boxId: s.main._id });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "REFUND_EXCEEDS_DUE");
  assert.equal((await stockOf(p)).inventoryCount, 10);
  const ok = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[0]._id, qty: 10 }] });
  assert.equal(ok.status, 201); assert.equal(await supplierBalance(s.other), 0);
  await assertHealthy();
});

it("two concurrent payments that would each pass the advance check alone: one wins, the other retries and is told it is an advance", async () => {
  const s = await shop();
  const url = `/api/suppliers/${s.supplier._id}/payments`;
  // balance 4,200: 3,000 is fine alone, two of them are 6,000 (an advance). Different boxes, so only the supplier document can serialise them.
  const [a, b] = await Promise.all([call("POST", url, { amount: 3000, boxId: s.main._id }), call("POST", url, { amount: 3000, boxId: s.bank._id })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.json, b.json]));
  const refused = a.status === 409 ? a : b; assert.equal(refused.json.code, "ADVANCE_NOT_CONFIRMED");
  assert.equal(await supplierBalance(s.supplier), 1200); assert.equal(await SupplierPayment.countDocuments({}), 1);
  await assertHealthy();
});

it("two concurrent refunds that would each fit the advance alone: one wins, the other is refused (REFUND_EXCEEDS_DUE)", async () => {
  const s = await shop();
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 5000, boxId: s.bank._id, confirmAdvance: true })).status, 201); // balance -800
  const url = `/api/suppliers/${s.supplier._id}/refunds`;
  const [a, b] = await Promise.all([call("POST", url, { amount: 500, boxId: s.main._id }), call("POST", url, { amount: 500, boxId: s.bank._id })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.json, b.json]));
  assert.equal((a.status === 409 ? a : b).json.code, "REFUND_EXCEEDS_DUE");
  assert.equal(await supplierBalance(s.supplier), -300);
  await assertHealthy();
});

it("a deactivated supplier can still be paid and refunded (we may owe them) but purchases refuse it (SUPPLIER_INACTIVE)", async () => {
  const s = await shop();
  assert.equal((await call("PUT", `/api/suppliers/${s.supplier._id}`, { isActive: false })).status, 200);
  assert.equal((await call("POST", "/api/purchases", designInvoice(s))).json.code, "SUPPLIER_INACTIVE");
  const paid = await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 1000, boxId: s.main._id });
  assert.equal(paid.status, 201, JSON.stringify(paid.json)); assert.equal(paid.json.balanceAfter, 3200);
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 4000, boxId: s.main._id, confirmAdvance: true })).status, 201); // -800
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/refunds`, { amount: 300, boxId: s.main._id })).status, 201);
  assert.equal((await call("GET", `/api/suppliers/${s.supplier._id}/statement`)).status, 200);
  await assertHealthy();
});

it("aging leaves a cancelled purchase and a cancelled payment out together with their cancel lines", async () => {
  const { computeSupplierStatement } = require("../src/services/supplierStatement.service");
  const now = new Date("2026-11-07T10:00:00.000Z"); const day = 86400000;
  const opening = { amount: 1000, date: new Date(now - 120 * day), number: "OB-000001" };
  const ledgerStartAt = new Date(now - 120 * day);
  const purchase = { _id: "p1", number: "PO-000001", date: new Date(now - day), createdAt: new Date(now - day), total: 500, status: "cancelled", cancelledAt: new Date(now - 3600000) };
  const statement = computeSupplierStatement({ supplier: { paymentTermsDays: 0 }, opening, ledgerStartAt, purchases: [purchase], now });
  assert.equal(statement.balance, 1000);
  assert.deepEqual(statement.lines.map((row) => row.type), ["opening_balance", "purchase", "purchase_cancel"], "the lines stay on the statement");
  assert.equal(statement.aging.d90plus, 1000); assert.equal(statement.aging.total, 1000);
  assert.equal(statement.aging.current + statement.aging.d1_30 + statement.aging.d31_60 + statement.aging.d61_90, 0);
  // a cancelled payment: its debit and its credit are both left out, so the old debt keeps its full age
  const payment = { _id: "pv1", number: "PV-000001", date: new Date(now - 2 * day), createdAt: new Date(now - 2 * day), amount: 300, status: "cancelled", cancelledAt: new Date(now - 3600000) };
  const second = computeSupplierStatement({ supplier: { paymentTermsDays: 0 }, opening, ledgerStartAt, payments: [payment], now });
  assert.equal(second.balance, 1000); assert.equal(second.aging.d90plus, 1000); assert.equal(second.aging.total, 1000);
  // a live payment still settles the oldest credit first
  const live = computeSupplierStatement({ supplier: { paymentTermsDays: 0 }, opening, ledgerStartAt, payments: [{ ...payment, status: "posted", cancelledAt: undefined }], now });
  assert.equal(live.aging.d90plus, 700);
});
// ------------------------------------------------------------ cancel

it("cancel a purchase: allowed, stock and INVENTORY follow the current cost, the PV stays as an advance; health 0", async () => {
  const s = await shop();
  const purchase = await buy(designInvoice(s)); // paid 3000
  const cancelled = await call("POST", `/api/purchases/${purchase._id}/cancel`, { reason: "wrong supplier" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json)); assert.equal(cancelled.json.status, "cancelled");
  assert.deepEqual([(await stockOf(s.led)).inventoryCount, (await stockOf(s.charger)).inventoryCount, (await stockOf(s.outlet)).inventoryCount], [32, 13, 6]);
  assert.equal((await stockOf(s.led)).purchasePrice, 70, "the cost stays at the current average");
  assert.equal(await supplierBalance(s.supplier), 4200 - 3000, "the PV is not reversed: 3,000 paid against the 4,200 opening");
  assert.equal((await SupplierPayment.findById(purchase.pvId).lean()).status, "posted");
  await assertHealthy();
  assert.equal((await call("POST", `/api/purchases/${purchase._id}/cancel`, { reason: "again" })).status, 409);
  assert.equal((await call("POST", `/api/purchases/${purchase._id}/cancel`, { reason: "" })).status, 400);
  // cancel the PV separately: the money comes back and the balance returns
  assert.equal((await call("POST", `/api/supplier-payments/${purchase.pvId}/cancel`, { reason: "money came back" })).status, 200);
  assert.equal(await supplierBalance(s.supplier), 4200);
  await assertHealthy();
  // an invoice at another price: the average moves, the cancel takes INVENTORY out at the CURRENT cost and the difference is adjusted
  const dearer = await buy({ supplierId: String(s.supplier._id), items: [{ productId: s.led._id, qty: 20, unitPrice: 100 }] });
  assert.equal((await stockOf(s.led)).purchasePrice, 81.54, "32 at 70 + 20 at 100");
  assert.equal((await call("POST", `/api/purchases/${dearer._id}/cancel`, { reason: "dearer one" })).status, 200);
  assert.equal((await stockOf(s.led)).inventoryCount, 32); assert.equal((await stockOf(s.led)).purchasePrice, 81.54);
  const adjustments = await entriesOf("purchase_cancel", dearer._id); assert.equal(adjustments.length, 1);
  assert.ok(lineOf(adjustments[0], "INVENTORY_ADJUSTMENT", "debit") || lineOf(adjustments[0], "INVENTORY_ADJUSTMENT", "credit"));
  await assertHealthy();
});

it("cancel a purchase is refused with returns (HAS_RETURNS) or when the stock was used (STOCK_ALREADY_USED)", async () => {
  const s = await shop({ withProducts: false });
  const p = await product({ code: "CANCEL-1", stock: 0, cost: 10 }); const q = await product({ code: "CANCEL-2", stock: 0, cost: 10 });
  const withReturn = await buy({ supplierId: String(s.supplier._id), items: [{ productId: p._id, qty: 5, unitPrice: 10 }] });
  assert.equal((await call("POST", `/api/purchases/${withReturn._id}/returns`, { items: [{ itemId: withReturn.items[0]._id, qty: 1 }] })).status, 201);
  const blocked = await call("POST", `/api/purchases/${withReturn._id}/cancel`, { reason: "has a return" }); assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "HAS_RETURNS");
  const used = await buy({ supplierId: String(s.supplier._id), items: [{ productId: q._id, qty: 5, unitPrice: 10 }] });
  await sold(q, 100, 3);
  const refused = await call("POST", `/api/purchases/${used._id}/cancel`, { reason: "already sold" }); assert.equal(refused.status, 409); assert.equal(refused.json.code, "STOCK_ALREADY_USED");
  assert.equal((await stockOf(q)).inventoryCount, 2); assert.equal((await Purchase.findById(used._id).lean()).status, "posted");
  await assertHealthy();
});

// ------------------------------------------------------------ COGS, setup mode, inline product

it("a sale after a purchase uses the new average cost in COGS", async () => {
  const s = await shop({ withProducts: false });
  const p = await product({ code: "COGS-1", stock: 10, cost: 20 });
  await buy({ supplierId: String(s.supplier._id), items: [{ productId: p._id, qty: 10, unitPrice: 30 }] });
  const sale = await sold(p, 100);
  assert.equal((await stockOf(p)).inventoryCount, 19);
  const [entry] = await entriesOf("sale", sale._id);
  assert.equal(lineOf(entry, "COGS", "debit").debit, 25); assert.equal(lineOf(entry, "INVENTORY", "credit").credit, 25);
  await assertHealthy();
});

it("setup mode ends on the first purchase; an inline new product starts at stock 0 and the purchase sets its stock and cost", async () => {
  const s = await shop({ withProducts: false });
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, true);
  const created = await call("POST", "/api/products", { name: "صنف جديد", code: "NEW-1", categoryId: String((await Category.create({ name: "New cat" }))._id), inventoryCount: 0, purchasePrice: 0, wholesalePrice: 50, retailPrice: 60 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, true, "a product with no stock does not end setup mode");
  const purchase = await buy({ supplierId: String(s.supplier._id), items: [{ productId: created.json._id, qty: 12, unitPrice: 31.5 }] });
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, false);
  const product = await stockOf(created.json); assert.equal(product.inventoryCount, 12); assert.equal(product.purchasePrice, 31.5);
  assert.equal(purchase.items[0].newAverageCost, 31.5);
  await assertHealthy();
});

// ------------------------------------------------------------ statement, aging, dashboard, delete

it("statement: lines oldest first with running balance, totals, cancel lines, aging by due date, one balance source", async () => {
  const s = await shop();
  const longAgo = new Date(Date.now() - 200 * 86400000);
  await PartyOpening.updateOne({ partyType: "supplier" }, { $set: { date: longAgo } }); await Meta.updateOne({ _id: "schema" }, { $set: { ledgerStartAt: longAgo } });
  const old = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  await buy(designInvoice(s, { date: old, paidAmount: 0, boxId: undefined, supplierInvoiceNo: "OLD-1", items: [{ productId: s.led._id, qty: 1, unitPrice: 5000 }] })); // 5,000 due 70 days ago
  const second = await buy(designInvoice(s, { paidAmount: 3000, supplierInvoiceNo: "EL-8841", date: new Date().toISOString().slice(0, 10) }));
  const statement = (await call("GET", `/api/suppliers/${s.supplier._id}/statement`)).json;
  assert.deepEqual(statement.lines.map((row) => row.type), ["opening_balance", "purchase", "purchase", "payment"]);
  assert.deepEqual(statement.lines.map((row) => row.balance), [4200, 9200, 14650, 11650]);
  assert.equal(statement.lines[0].description, "رصيد أول المدة");
  assert.deepEqual([statement.lines[2].number, statement.lines[2].supplierInvoiceNo, statement.lines[3].number], [second.number, "EL-8841", "PV-000001"]);
  assert.deepEqual(statement.totals, { debit: 3000, credit: 14650, balance: 11650 });
  assert.equal(statement.balance, 11650); assert.equal(statement.ledgerBalance, 11650); assert.equal(await supplierBalance(s.supplier), 11650);
    // aging: the 3,000 payment settles the oldest due date first (the opening, due 200 days ago): 1,200 of it is left, then the 5,000 invoice (70 days overdue); the new invoice is not due yet
  assert.equal(statement.aging.total, 11650); assert.equal(statement.aging.advance, 0);
  assert.equal(statement.aging.d90plus, 1200); assert.equal(statement.aging.d61_90, 5000); assert.equal(statement.aging.d1_30 + statement.aging.d31_60, 0);
  assert.equal(statement.aging.current, 5450, "due in 30 days: not overdue yet");
  // period filter keeps the balance forward
  const period = (await call("GET", `/api/suppliers/${s.supplier._id}/statement?from=${new Date().toISOString().slice(0, 10)}`)).json;
  assert.deepEqual(period.lines.map((row) => row.type), ["purchase", "payment"]); assert.equal(period.openingBalance, 9200); assert.equal(period.totals.balance, 11650);
  // cancel lines
  await call("POST", `/api/purchases/${second._id}/cancel`, { reason: "cancel for statement" });
  const after = (await call("GET", `/api/suppliers/${s.supplier._id}/statement`)).json;
  assert.deepEqual(after.lines.map((row) => row.type), ["opening_balance", "purchase", "purchase", "payment", "purchase_cancel"]);
  assert.equal(after.balance, 4200 + 5000 - 3000, "9,200 owed - the 3,000 PV that stays");
  assert.equal(after.balance, after.ledgerBalance);
  assert.equal((await call("GET", `/api/suppliers/${s.supplier._id}/statement?from=bad`)).status, 400);
  await assertHealthy();
});

it("the dashboard shows what we owe suppliers (suppliers.view only) and the list shows the last purchase date", async () => {
  const s = await shop();
  await buy(designInvoice(s));
  const dash = await call("GET", "/api/dashboard/summary"); assert.equal(dash.status, 200);
  assert.deepEqual(dash.json.suppliersDue, { owed: 6650, suppliersWithBalance: 1 });
  const list = (await call("GET", "/api/suppliers")).json;
  assert.equal(list.find((row) => row._id === String(s.supplier._id)).lastPurchaseAt.slice(0, 10), "2026-11-03");
  assert.equal(list.find((row) => row._id === String(s.other._id)).lastPurchaseAt, null);
  token = await makeUser("cashier3", "cashier");
  assert.equal((await call("GET", "/api/dashboard/summary")).json.suppliersDue, undefined, "no suppliers.view: the figure is not there at all");
});

it("supplier delete is blocked by any document (SUPPLIER_HAS_DOCUMENTS) and by a balance", async () => {
  const s = await shop();
  assert.equal((await call("DELETE", `/api/suppliers/${s.supplier._id}`)).json.code, "SUPPLIER_HAS_BALANCE");
  await buy(designInvoice(s));
  assert.equal((await call("DELETE", `/api/suppliers/${s.supplier._id}`)).json.code, "SUPPLIER_HAS_DOCUMENTS");
  assert.equal((await call("DELETE", `/api/suppliers/${s.other._id}`)).status, 200);
});

it("purchase list: filters by supplier, date, number and status; number search like Stage 16", async () => {
  const s = await shop();
  const a = await buy(designInvoice(s, { date: "2026-10-01", supplierInvoiceNo: "AAA-1" }));
  const b = await buy({ supplierId: String(s.other._id), date: "2026-11-02", supplierInvoiceNo: "BBB-2", items: [{ productId: s.led._id, qty: 1, unitPrice: 10 }] });
  await call("POST", `/api/purchases/${b._id}/cancel`, { reason: "filter test" });
  const ids = async (query) => (await call("GET", `/api/purchases?${query}`)).json.data.map((row) => row.number);
  assert.deepEqual(await ids(""), ["PO-000002", "PO-000001"]);
  assert.deepEqual(await ids(`supplier=${s.supplier._id}`), ["PO-000001"]);
  assert.deepEqual(await ids("status=cancelled"), ["PO-000002"]);
  assert.deepEqual(await ids("from=2026-10-15&to=2026-11-30"), ["PO-000002"]);
  assert.deepEqual(await ids("search=po-1"), ["PO-000001"]); assert.deepEqual(await ids("search=PO-000002"), ["PO-000002"]);
  assert.deepEqual(await ids("search=BBB"), ["PO-000002"]);
  assert.equal((await call("GET", "/api/purchases?status=nope")).status, 400);
  const detail = await call("GET", `/api/purchases/${a._id}`); assert.equal(detail.json.payment.number, "PV-000001"); assert.equal(detail.json.boxName, "الخزنة الرئيسية");
  assert.equal((await call("GET", "/api/purchases/not-an-id")).status, 404);
});

// ------------------------------------------------------------ boxes, shifts, health

it("a PV and an SR on a shift box: expected cash includes them as their own lines", async () => {
  const s = await shop();
  const drawer = await createBox({ name: "Drawer 2", type: "cash", shiftsEnabled: true, openingAmount: 2000 });
  const opened = await call("POST", "/api/shifts", { boxId: drawer._id, openingFloat: 2000 }); assert.equal(opened.status, 201, JSON.stringify(opened.json));
  const purchase = await buy(designInvoice(s, { paidAmount: 5450, boxId: s.main._id }));
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 500, boxId: drawer._id })).status, 201);
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 300, boxId: drawer._id })).status, 201);
  // an advance (paid from the bank) so the supplier owes US money and a cash refund may come back
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 4000, boxId: s.bank._id, confirmAdvance: true })).status, 201);
  const returned = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[1]._id, qty: 3 }], refundAmount: 720, boxId: drawer._id });
  assert.equal(returned.status, 201, JSON.stringify(returned.json));
  const report = (await call("GET", `/api/shifts/${opened.json._id}`)).json;
  const amount = (key) => report.lines.find((row) => row.key === key)?.amount;
  assert.equal(amount("supplierPayments"), 800); assert.equal(amount("supplierRefunds"), 720);
  assert.equal(report.expected, 2000 - 800 + 720);
  const cancelled = await call("POST", `/api/supplier-payments/${(await SupplierPayment.findOne({ amount: 300 }).lean())._id}/cancel`, { reason: "wrong box" }); assert.equal(cancelled.status, 200);
  assert.equal((await call("GET", `/api/shifts/${opened.json._id}`)).json.expected, 2000 - 800 + 720 + 300, "a cancelled PV is its original event plus a reversing event");
  const closed = await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 2220 }); assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.equal(closed.json.difference, 0);
  await assertHealthy();
});

it("health after a mixed day is all zero, and each supplier check can fail", async () => {
  const s = await shop();
  const wallet = await createBox({ name: "Wallet", type: "wallet" });
  const p1 = await buy(designInvoice(s));
  const p2 = await buy({ supplierId: String(s.other._id), supplierInvoiceNo: "OTH-1", discountAmount: 25, otherCosts: 40, items: [{ productId: s.led._id, qty: 7, unitPrice: 33.33 }, { productId: s.outlet._id, qty: 3, unitPrice: 12.5 }] });
  assert.equal((await call("POST", `/api/purchases/${p1._id}/returns`, { items: [{ itemId: p1.items[2]._id, qty: 4 }], refundAmount: 0 })).status, 201);
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 1000, boxId: s.bank._id })).status, 201);
  assert.equal((await call("POST", `/api/purchases/${p2._id}/cancel`, { reason: "mixed day" })).status, 200);
  const report = await assertHealthy();
  assert.equal(report.suppliers.difference, 0); assert.equal(report.inventory.difference, 0); assert.equal(report.entries.difference, 0); assert.equal(report.boxes.difference, 0);
  assert.ok(report.entries.bySource.purchase.expected >= 2 && report.entries.bySource.supplier_payment.expected >= 2 && report.entries.bySource.purchase_return.expected === 1);

  // 1. suppliers: an entry posted straight into the ledger moves a supplier's party balance away from the statement
  const accounts = await Account.find({ systemKey: { $in: ["SUPPLIERS", "CAPITAL"] } }).lean();
  const suppliersAccount = accounts.find((a) => a.systemKey === "SUPPLIERS"); const capital = accounts.find((a) => a.systemKey === "CAPITAL");
  const { postEntry, line } = require("../src/accounting/posting"); const { withTransaction } = require("../src/utils/transaction");
  await withTransaction((session) => postEntry({ date: new Date(), source: { type: "manual_test", id: s.supplier._id }, session, lines: [
    line(capital, 77, "debit"), line(suppliersAccount, 77, "credit", { partyType: "supplier", partyId: s.supplier._id }),
  ] }));
  let broken = await health(); assert.equal(broken.suppliers.difference, 77); assert.equal(broken.suppliers.bySupplier[0].supplierId, String(s.supplier._id));
  await JournalEntry.deleteOne({ "source.type": "manual_test" }); await assertHealthy();

  // 2. entries: a PV without its entry, a purchase without its entry
  const pvEntry = await JournalEntry.findOne({ "source.type": "supplier_payment", type: "auto" }).lean();
  await JournalEntry.deleteOne({ _id: pvEntry._id });
  broken = await health(); assert.ok(broken.entries.difference >= 1); assert.equal(broken.entries.bySource.supplier_payment.missing, 1);
  assert.ok(broken.suppliers.difference > 0 && broken.boxes.difference > 0, "the same loss shows on the supplier and on the box");
  await JournalEntry.collection.insertOne(pvEntry); await assertHealthy();

  // 3. boxes: a PV document that the box never saw (deleted document, entry kept) and a refund amount edited behind the ledger's back
  const pv = await SupplierPayment.findOne({ amount: 1000 }).lean(); await SupplierPayment.deleteOne({ _id: pv._id });
  broken = await health(); assert.ok(broken.boxes.difference >= 1000, JSON.stringify(broken.boxes)); assert.ok(broken.entries.bySource.supplier_payment.orphaned >= 1);
  await SupplierPayment.collection.insertOne(pv); await assertHealthy();

  // 4. inventory: stock edited behind the ledger's back
  await Product.updateOne({ _id: s.led._id }, { $inc: { inventoryCount: 1 } });
  broken = await health(); assert.ok(broken.inventory.difference !== 0); await Product.updateOne({ _id: s.led._id }, { $inc: { inventoryCount: -1 } }); await assertHealthy();
  void wallet;
});

it("a supplier refund can fail the boxes check too", async () => {
  const s = await shop();
  const purchase = await buy(designInvoice(s, { paidAmount: 5450 }));
  assert.equal((await call("POST", `/api/suppliers/${s.supplier._id}/payments`, { amount: 5000, boxId: s.bank._id, confirmAdvance: true })).status, 201); // an advance: they owe us
  const refunded = await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[1]._id, qty: 1 }], refundAmount: 240, boxId: s.main._id }); assert.equal(refunded.status, 201);
  await assertHealthy();
  const SupplierRefund = require("../src/models/supplierRefund.model");
  await SupplierRefund.updateOne({ _id: refunded.json.refund._id }, { $set: { amount: 200 } });
  const broken = await health(); assert.ok(broken.boxes.difference >= 40, JSON.stringify(broken.boxes));
  await SupplierRefund.deleteOne({ _id: refunded.json.refund._id });
  assert.ok((await health()).entries.bySource.supplier_refund.orphaned >= 1);
});

it("the payment-box list carries each box's balance only for users with cashbox.view (the supplier payment dialog shows it)", async () => {
  const s = await shop();
  const owner = (await call("GET", "/api/cashbox/payment-boxes")).json.data;
  assert.equal(owner.find((box) => box.isMain).balance, 18400); assert.equal(owner.find((box) => box._id === s.bank._id).balance, 41000);
  token = await makeUser("acc-boxes", "accountant");
  const accountant = (await call("GET", "/api/cashbox/payment-boxes")).json.data;
  assert.equal(accountant.find((box) => box._id === s.bank._id).balance, 41000);
  token = ownerToken; token = await makeUser("cashier-boxes", "cashier");
  const cashier = (await call("GET", "/api/cashbox/payment-boxes")).json.data;
  assert.ok(cashier.length >= 1); assert.ok(cashier.every((box) => !("balance" in box)), "names only without cashbox.view");
  assert.equal(JSON.stringify(cashier).includes("41000"), false);
});
