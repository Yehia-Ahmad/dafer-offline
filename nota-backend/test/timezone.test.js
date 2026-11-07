// The shop PC runs in Africa/Cairo (UTC+2). A business date is stored as the UTC midnight of the day the user picked,
// so between 00:00 and 02:00 local time a document dated "today" lies after `new Date()`. Every default cut-off must be
// the END of the local day instead. This file runs the whole stack with a fake clock at 00:30 Cairo time.
process.env.TZ = "Africa/Cairo";
process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "timezone-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const Supplier = require("../src/models/supplier.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const { runMigrations } = require("../src/migrations");
const { setClock, endOfLocalDay } = require("../src/utils/clock");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

// 2026-11-07 00:30 in Cairo = 2026-11-06 22:30 UTC
const FAKE_NOW = new Date("2026-11-06T22:30:00.000Z");
const TODAY = "2026-11-07";

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27123 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(() => new Date(FAKE_NOW)); await clearDatabase(); token = null;
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "tz-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);
async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); return { status: response.status, json: text ? JSON.parse(text) : null };
}
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const flat = (rows) => rows.flatMap((row) => [row, ...flat(row.children || [])]);

it("the fake clock is 00:30 local on the 7th, and the default cut-off is the end of that local day", () => {
  assert.equal(new Date(FAKE_NOW).getDate(), 7); assert.equal(new Date(FAKE_NOW).getHours(), 0);
  const cutoff = endOfLocalDay(new Date(FAKE_NOW));
  assert.equal(cutoff.toISOString(), "2026-11-07T21:59:59.999Z");
  assert.ok(new Date(`${TODAY}T00:00:00.000Z`) > FAKE_NOW, "a document dated today is after the real 'now'");
  assert.ok(new Date(`${TODAY}T00:00:00.000Z`) <= cutoff);
});

it("a sale, a credit sale and a purchase dated today at 00:30 local show up in the accounts tree, ledger, journal, dashboard, statements and health", async () => {
  await startLedger();
  const customer = await Customer.create({ name: "TZ Customer", phone: "01012345678" });
  const supplier = await Supplier.create({ name: "TZ Supplier", paymentTermsDays: 30 });
  const category = await Category.create({ name: "TZ" });
  const made = await call("POST", "/api/products", { name: "TZ product", code: "TZ-1", categoryId: String(category._id), inventoryCount: 10, purchasePrice: 20, wholesalePrice: 30, retailPrice: 40 });
  assert.equal(made.status, 201, JSON.stringify(made.json)); const product = made.json;
  const sale = await call("POST", "/api/sellings", { customerName: "Walk-in", customerPhone: "01017171718", sellingDate: TODAY, items: [{ productId: product._id, quantity: 1, price: 100 }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  const credit = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: [{ productId: product._id, quantity: 1, price: 150 }] });
  assert.equal(credit.status, 201, JSON.stringify(credit.json));
  const purchase = await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: TODAY, items: [{ productId: product._id, qty: 5, unitPrice: 30 }] });
  assert.equal(purchase.status, 201, JSON.stringify(purchase.json));

  // accounts tree: the default asOf is the end of the local day, so today's entries count
  const tree = await call("GET", "/api/accounting/accounts"); assert.equal(tree.status, 200);
  const rows = flat(tree.json.accounts); const byKey = (key) => rows.find((row) => row.systemKey === key);
  assert.equal(byKey("CASH_MAIN").balance, 100, "the cash sale is in the tree");
  assert.equal(byKey("CUSTOMERS").balance, 150);
  assert.equal(byKey("SUPPLIERS").balance, -150, "the purchase is in the tree (credit)");
  assert.equal(new Date(tree.json.asOf).toISOString(), "2026-11-07T21:59:59.999Z");
  // an explicit date-only asOf is the same value; yesterday's cut-off does not see them
  const explicit = await call("GET", `/api/accounting/accounts?asOf=${TODAY}`);
  assert.equal(flat(explicit.json.accounts).find((row) => row.systemKey === "CASH_MAIN").balance, 100);
  const yesterday = await call("GET", "/api/accounting/accounts?asOf=2026-11-06");
  assert.equal(flat(yesterday.json.accounts).find((row) => row.systemKey === "CASH_MAIN").balance, 0);

  // ledger and journal (no default upper bound)
  const cash = byKey("CASH_MAIN");
  const ledger = await call("GET", `/api/accounting/accounts/${cash.id || cash._id}/ledger`); assert.equal(ledger.status, 200);
  assert.ok((ledger.json.lines || ledger.json.data || []).length >= 1);
  const journal = await call("GET", `/api/accounting/journal?sourceType=sale&sourceId=${sale.json._id}`);
  assert.equal(journal.json.data.length, 1);

  // dashboard: "today" is the local calendar day
  const dash = await call("GET", "/api/dashboard/summary"); assert.equal(dash.status, 200);
  assert.equal(dash.json.date, TODAY); assert.equal(dash.json.today.cash.total, 100); assert.equal(dash.json.today.credit.total, 150);
  assert.deepEqual(dash.json.suppliersDue, { owed: 150, suppliersWithBalance: 1 });

  // statements: nothing is overdue today, and the documents are on them
  const customerStatement = await call("GET", `/api/customers/${customer._id}/statement`); assert.equal(customerStatement.status, 200);
  assert.equal(customerStatement.json.totals.balance, 150);
  const supplierStatement = await call("GET", `/api/suppliers/${supplier._id}/statement`); assert.equal(supplierStatement.status, 200);
  assert.equal(supplierStatement.json.balance, 150); assert.equal(supplierStatement.json.aging.current, 150);
  const toToday = await call("GET", `/api/suppliers/${supplier._id}/statement?to=${TODAY}`);
  assert.equal(toToday.json.lines.length, 1);

  // health
  const health = await call("GET", "/api/accounting/health"); assert.equal(health.status, 200);
  for (const [name, check] of Object.entries(health.json)) { assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`); if ("ok" in check) assert.equal(check.ok, true, name); }
});

it("days overdue are local calendar days: at 00:30 local an item due yesterday is 1 day overdue, one due today is not overdue", () => {
  const { overdueDays, ageOpenItems } = require("../src/services/customerOpenItems.service");
  const { computeSupplierStatement } = require("../src/services/supplierStatement.service");
  const yesterday = new Date("2026-11-06T00:00:00.000Z"); const today = new Date(`${TODAY}T00:00:00.000Z`);
  assert.equal(overdueDays({ kind: "invoice", dueDate: yesterday, date: yesterday }, FAKE_NOW), 1, "customer invoice due yesterday");
  assert.equal(overdueDays({ kind: "invoice", dueDate: today, date: today }, FAKE_NOW), 0, "due today");
  assert.equal(ageOpenItems([{ kind: "invoice", dueDate: yesterday, date: yesterday, remaining: 40 }, { kind: "invoice", dueDate: today, date: today, remaining: 60 }], FAKE_NOW).days1to30, 40);
  const statement = computeSupplierStatement({
    supplier: { paymentTermsDays: 0 }, now: FAKE_NOW,
    purchases: [{ _id: "a", number: "PO-000001", date: yesterday, createdAt: yesterday, total: 70 }, { _id: "b", number: "PO-000002", date: today, createdAt: today, total: 30 }],
  });
  assert.equal(statement.aging.d1_30, 70, "supplier purchase due yesterday is 1 day overdue"); assert.equal(statement.aging.current, 30);
  // the same item an hour later in the day and the next morning still counts whole local days
  assert.equal(overdueDays({ kind: "invoice", dueDate: yesterday, date: yesterday }, new Date("2026-11-07T08:00:00.000Z")), 1);
  assert.equal(overdueDays({ kind: "invoice", dueDate: yesterday, date: yesterday }, new Date("2026-11-07T22:30:00.000Z")), 2);
});

it("a cancel line made at 00:30 local is dated, sorted and filtered as TODAY on the supplier and the customer statements", () => {
  const { computeSupplierStatement } = require("../src/services/supplierStatement.service");
  const { computeCustomerStatement } = require("../src/services/customerStatement.service");
  const today = new Date(`${TODAY}T00:00:00.000Z`);
  // FAKE_NOW (22:30 UTC on the 6th) is 00:30 on the 7th locally
  const purchase = { _id: "p", number: "PO-000001", date: today, createdAt: new Date("2026-11-06T22:00:00.000Z"), total: 500, status: "cancelled", cancelledAt: FAKE_NOW };
  const payment = { _id: "v", number: "PV-000001", date: today, createdAt: new Date("2026-11-06T22:05:00.000Z"), amount: 200, status: "cancelled", cancelledAt: FAKE_NOW };
  const supplier = computeSupplierStatement({ supplier: {}, purchases: [purchase], payments: [payment], from: today, to: new Date("2026-11-07T23:59:59.999Z"), now: FAKE_NOW });
  const cancels = supplier.lines.filter((row) => row.type.endsWith("_cancel"));
  assert.equal(cancels.length, 2);
  assert.ok(cancels.every((row) => new Date(row.date).toISOString() === `${TODAY}T00:00:00.000Z`), "dated by the local business day");
  assert.equal(supplier.lines.length, 4, "all four lines are in a statement that starts today");
  assert.deepEqual(supplier.lines.map((row) => row.type), ["purchase", "payment", "purchase_cancel", "payment_cancel"], "cancelledAt only breaks ties: after their own documents");
  // yesterday's statement does not show them
  const before = computeSupplierStatement({ supplier: {}, purchases: [purchase], payments: [payment], to: new Date("2026-11-06T23:59:59.999Z"), now: FAKE_NOW });
  assert.equal(before.lines.length, 0);

  const invoice = { _id: "i", number: "CR-000001", sellingDate: today, createdAt: new Date("2026-11-06T22:00:00.000Z"), totalPrice: 150, status: "cancelled", cancelledAt: FAKE_NOW, payments: [], refunds: [], cancelRefundAmount: 0 };
  const customer = computeCustomerStatement({ invoices: [invoice], returnById: new Map(), from: today, to: new Date("2026-11-07T23:59:59.999Z") });
  const lines = customer.lines.filter((row) => row.type === "invoice" || row.type === "cancel");
  assert.deepEqual(lines.map((row) => row.type), ["invoice", "cancel"]);
  assert.equal(new Date(lines[1].date).toISOString(), `${TODAY}T00:00:00.000Z`);
  assert.equal(customer.totals.balance, 0);
});
