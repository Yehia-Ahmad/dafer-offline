// Stage 21 regression guard: with VAT OFF every posted line and the money fields of the API responses must be identical to
// Stage 20. The fixture (test/fixtures/stage21-baseline.json) was captured on the Stage 20 code, BEFORE any VAT change:
//   STAGE21_WRITE_BASELINE=1 node --test test/stage21-baseline.test.js   (only ever run on unchanged Stage 20 code)
process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage21-baseline-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Supplier = require("../src/models/supplier.model");
const { runMigrations } = require("../src/migrations");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const FIXTURE = path.join(__dirname, "fixtures", "stage21-baseline.json");

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27131 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage21-base-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text(); return { status: response.status, json: text ? JSON.parse(text) : null };
}
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function product({ code, stock, cost, price }) {
  const category = await Category.create({ name: `Base ${code}` });
  const response = await call("POST", "/api/products", { name: code, code, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: price, retailPrice: price });
  assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json;
}
const ok = (response, status = 201) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };
const pick = (object, fields) => Object.fromEntries(fields.filter((field) => object[field] !== undefined).map((field) => [field, object[field]]));
const MONEY = ["subtotal", "discountAmount", "shippingFees", "totalPrice", "netTotal", "paidAmount", "remainingAmount", "refundedAmount", "total", "otherCosts", "amount", "finalReturnedAmount", "subtotalReturnedAmount", "supplierBalanceAfter"];

async function keyedEntries() {
  const accounts = await Account.find({}).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey || account.code]));
  const entries = await JournalEntry.find({}).sort({ createdAt: 1, _id: 1 }).lean();
  return entries.filter((entry) => entry.source?.type !== "opening").map((entry) => ({
    source: entry.source?.type, type: entry.type, reversal: Boolean(entry.reversalOf),
    lines: entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit, party: Boolean(row.partyId) })),
  }));
}

async function scenario() {
  await startLedger();
  const opening = await call("POST", "/api/accounting/opening", { cash: 5000 });
  ok(opening, 200);
  const a = await product({ code: "A35", stock: 100, cost: 20, price: 35 });
  const b = await product({ code: "B65", stock: 100, cost: 40, price: 65 });
  const customer = await Customer.create({ name: "Base customer", phone: "01011111111" });
  const supplier = await Supplier.create({ name: "Base supplier" });
  const out = { documents: {} };
  const items = (quantityA = 4, quantityB = 2) => [{ productId: a._id, quantity: quantityA, price: 35 }, { productId: b._id, quantity: quantityB, price: 65 }];

  const cash = ok(await call("POST", "/api/sellings", { customerName: "Cash", customerPhone: "01017171718", sellingDate: "2026-11-05", discountAmount: 20, shippingFees: 10, items: items() }));
  out.documents.cashSale = pick(cash, MONEY);
  const cashReturn1 = ok(await call("POST", "/api/returns", { returnType: "cash", invoiceId: cash._id, items: [{ productId: a._id, quantity: 1, returnReason: "x" }] }));
  const cashReturn2 = ok(await call("POST", "/api/returns", { returnType: "cash", invoiceId: cash._id, items: [{ productId: a._id, quantity: 3, returnReason: "x" }, { productId: b._id, quantity: 2, returnReason: "x" }] }));
  out.documents.cashReturns = [cashReturn1, cashReturn2].map((row) => ({ invoice: pick(row.data.invoice, MONEY), log: pick(row.data.returnLog, MONEY) }));

  const credit =ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", discountAmount: 20, shippingFees: 10, downPayment: 50, items: items() }));
  out.documents.creditSale = pick(credit, MONEY);
  const creditReturn1 = ok(await call("POST", "/api/returns", { returnType: "credit", invoiceId: credit._id, items: [{ productId: a._id, quantity: 1, returnReason: "x" }] }));
  const creditReturn2 = ok(await call("POST", "/api/returns", { returnType: "credit", invoiceId: credit._id, items: [{ productId: a._id, quantity: 3, returnReason: "x" }, { productId: b._id, quantity: 2, returnReason: "x" }] }));
  out.documents.creditReturns = [creditReturn1, creditReturn2].map((row) => pick(row.data || row, MONEY));

  const cashCancel = ok(await call("POST", "/api/sellings", { customerName: "Cash", customerPhone: "01017171718", sellingDate: "2026-11-05", items: items(1, 1) }));
  ok(await call("POST", `/api/sellings/${cashCancel._id}/cancel`, { reason: "baseline" }), 200);
  const creditEdit = ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: items(1, 1) }));
  const edited = await call("PUT", `/api/credit-sales/${creditEdit._id}`, { items: items(2, 1), discountAmount: 5 });
  out.documents.creditEditStatus = edited.status;

  const main = (await call("GET", "/api/cashbox/boxes")).json.data.find((box) => box.isMain);
  const purchase = ok(await call("POST", "/api/purchases", {
    supplierId: String(supplier._id), supplierInvoiceNo: "BASE-1", date: "2026-11-04", discountAmount: 30, otherCosts: 45,
    items: [{ productId: a._id, qty: 20, unitPrice: 21 }, { productId: b._id, qty: 10, unitPrice: 42.5 }], paidAmount: 300, boxId: main._id,
  }));
  out.documents.purchase = pick(purchase, MONEY);
  const purchaseReturn = ok(await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: purchase.items[0]._id, qty: 5 }], reason: "x" }));
  out.documents.purchaseReturn = pick(purchaseReturn.data || purchaseReturn, MONEY);

  const expenseCategory = String((await Account.findOne({ code: "521" }).lean())._id);
  const expense = ok(await call("POST", "/api/expenses", { accountId: expenseCategory, amount: 250, boxId: main._id, note: "baseline" }));
  out.documents.expense = pick(expense.data || expense, MONEY);

  out.entries = await keyedEntries();
  return out;
}

it("VAT off posts exactly what Stage 20 posted (sale, credit sale, returns, cancel, purchase, purchase return, expense)", async () => {
  const actual = JSON.parse(JSON.stringify(await scenario()));
  if (process.env.STAGE21_WRITE_BASELINE === "1") {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(actual, expected);
});
