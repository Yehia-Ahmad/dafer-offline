process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage18-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const { forgetBoxes } = require("./helpers/oldData");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const AuditLog = require("../src/models/auditLog.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Product = require("../src/models/product.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const CreditSale = require("../src/models/creditSale.model");
const Selling = require("../src/models/selling.model");
const Supplier = require("../src/models/supplier.model");
const PartyOpening = require("../src/models/partyOpening.model");
const Meta = require("../src/models/meta.model");
const Receipt = require("../src/models/receipt.model");
const mongoose = require("mongoose");
const { runMigrations } = require("../src/migrations");
const { postEntry, accountMap, line } = require("../src/accounting/posting");
const { importCategories } = require("../src/services/categoryImportExport.service");
const { createCategoryWorkbook } = require("../src/helpers/categoryWorkbook.helper");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { withTransaction } = require("../src/utils/transaction");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27118 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null;
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage18-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token; ownerToken = token;
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
async function product({ code, stock = 20, cost = 20, retail = 100 } = {}) {
  const category = await Category.create({ name: `Stage18 ${code || Math.random()}` });
  const response = await call("POST", "/api/products", { name: code || "Product", code: code || `P-${Math.random()}`, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: Math.max(cost, retail), retailPrice: retail });
  assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json;
}
const saleBody = (items, extra = {}) => ({ customerName: "Cash customer", customerPhone: "01017171718", sellingDate: "2026-11-05", items, ...extra });
const sell = async (p) => { const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 100 }])); assert.equal(sale.status, 201, JSON.stringify(sale.json)); return sale.json; };
async function keyedLines(entry) {
  const accounts = await Account.find({ _id: { $in: entry.lines.map((row) => row.accountId) } }).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey || account.code]));
  return entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit, party: row.partyType || null }));
}
const find = (rows, key, party = null) => rows.find((row) => row.key === key && (party === null || row.party === party));
async function assertHealthy() {
  const response = await call("GET", "/api/accounting/health"); assert.equal(response.status, 200);
  for (const [name, check] of Object.entries(response.json)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
  return response.json;
}
const customer = (name, phone) => Customer.create({ name, phone });
const supplier = async (name) => { const response = await call("POST", "/api/suppliers", { name, phone: "0100000" }); assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json; };
const currentOpening = async () => { const meta = await Meta.findById("schema").lean(); return JournalEntry.findById(meta.opening.entryId).lean(); };
const stockEntries = (sourceType) => JournalEntry.find({ "source.type": sourceType }).sort({ createdAt: 1 }).lean();
const login = async (username, password) => { const response = await call("POST", "/api/auth/login", { username, password }); assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json.token; };
const makeUser = async (username, permissions) => {
  const created = await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role: "custom", permissions });
  assert.equal(created.status, 201, JSON.stringify(created.json)); return login(username, "secret-pass-1");
};

// ------------------------------------------------------------ setup mode

it("setup mode: on for a fresh shop, ended by the first sale, a return or a receipt, never by opening documents", async () => {
  await startLedger();
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, true);
  const c = await customer("Opening Setup", "01010000101");
  assert.equal((await call("POST", "/api/accounting/opening", { customers: [{ customerId: String(c._id), amount: 500 }] })).status, 200);
  const state = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(state.setupMode, true, "opening documents do not end setup mode");
  assert.equal(state.status, "setup");
  const p = await product({ code: "SETUP-END", stock: 5 });
  await sell(p);
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, false, "the first sale ends it");
  // A receipt alone ends it too.
  await startLedger();
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, true);
  await Receipt.create({ number: "RC-000900", customer: c._id, amount: 5, paymentDate: new Date(), kind: "payment", allocations: [] });
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, false);
});

it("setup mode: product create, stock edit, price revaluation and write-off post to CAPITAL as opening_inventory", async () => {
  await startLedger();
  const p = await product({ code: "SETUP-STOCK", stock: 10, cost: 20 });
  const created = (await stockEntries("opening_inventory"))[0];
  assert.deepEqual((await keyedLines(created)).map(({ key, debit, credit }) => ({ key, debit, credit })), [{ key: "INVENTORY", debit: 200, credit: 0 }, { key: "CAPITAL", debit: 0, credit: 200 }]);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "product_create" }), 0);
  assert.equal((await call("PUT", `/api/products/${p._id}`, { inventoryCount: 4 })).status, 200);
  const down = (await stockEntries("opening_inventory"))[1];
  assert.ok(find(await keyedLines(down), "INVENTORY").credit === 120 && find(await keyedLines(down), "CAPITAL").debit === 120, "stock down reverses the capital posting");
  assert.equal((await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 })).status, 200);
  const reval = (await stockEntries("opening_inventory"))[2];
  assert.ok(find(await keyedLines(reval), "INVENTORY").debit === 20 && find(await keyedLines(reval), "CAPITAL").credit === 20, "4 units × +5 against CAPITAL");
  assert.equal(await JournalEntry.countDocuments({ "source.type": { $in: ["inventory_adjustment", "cost_revaluation"] } }), 0);
  assert.equal((await call("DELETE", `/api/products/${p._id}`)).status, 200);
  const writeoff = (await stockEntries("opening_inventory"))[3];
  assert.equal(find(await keyedLines(writeoff), "CAPITAL").debit, 100, "typed-in goods removed during setup are an opening correction");
  assert.equal(await JournalEntry.countDocuments({ "source.type": "product_writeoff" }), 0);
  await assertHealthy();
});

it("setup mode: category import with stock posts to CAPITAL", async () => {
  await startLedger();
  const categoryId = new mongoose.Types.ObjectId(); const productId = new mongoose.Types.ObjectId();
  const workbook = createCategoryWorkbook([{ _id: categoryId, name: "Setup import", image: "", specifications: [] }], [{ productId: String(productId), categoryId: String(categoryId), categoryName: "Setup import", name: "Imported", code: "IMP-18", inventoryCount: 3, imageBase64: "", wholesalePrice: 30, purchasePrice: 20, retailPrice: 40, soldItemCount: 0, specifications: [] }]);
  await withTransaction((session) => importCategories(workbook, session));
  const entry = await JournalEntry.findOne({ "source.type": "opening_inventory", "source.id": productId }).lean();
  assert.ok(entry, "import with stock in setup mode posts opening_inventory");
  assert.deepEqual((await keyedLines(entry)).map(({ key, debit, credit }) => ({ key, debit, credit })), [{ key: "INVENTORY", debit: 60, credit: 0 }, { key: "CAPITAL", debit: 0, credit: 60 }]);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "product_create", "source.id": productId }), 0);
  await assertHealthy();
});

it("after the first sale the normal INVENTORY_ADJUSTMENT rules apply again", async () => {
  await startLedger();
  const p = await product({ code: "AFTER-SALE", stock: 10, cost: 20 });
  await sell(p);
  assert.equal((await call("PUT", `/api/products/${p._id}`, { inventoryCount: 20 })).status, 200);
  const adjustment = await JournalEntry.findOne({ "source.type": "inventory_adjustment" }).lean();
  assert.ok(adjustment && find(await keyedLines(adjustment), "INVENTORY_ADJUSTMENT").credit === 220, "9 units left after the sale, 20 counted: 11 x 20");
  const second = await product({ code: "AFTER-SALE-2", stock: 3, cost: 10 });
  assert.ok(await JournalEntry.findOne({ "source.type": "product_create", "source.id": second._id }));
  assert.equal(await JournalEntry.countDocuments({ "source.type": "opening_inventory", "source.id": second._id }), 0);
  await assertHealthy();
});

// ------------------------------------------------------------ wizard

const designNumbers = async () => {
  await startLedger();
  await product({ code: "DESIGN-1", stock: 842, cost: 100 });
  const a = await customer("Ahmed", "01010000201"); const b = await customer("Mona", "01010000202");
  const s1 = await supplier("Light Co"); const s2 = await supplier("Wire Co");
  return { a, b, s1, s2, body: {
    cash: 15000, banks: [{ name: "Banque Misr", type: "bank", amount: 30000 }], fixedAssets: 0,
    customers: [{ customerId: String(a._id), amount: 4000 }, { customerId: String(b._id), amount: 2300 }],
    suppliers: [{ supplierId: s1._id, amount: 6650 }, { supplierId: s2._id, amount: 1850 }],
  } };
};

it("wizard save posts the design's numbers: cash 15,000 + bank 30,000 + inventory 84,200 + customers 6,300 - suppliers 8,500 = capital 127,000", async () => {
  const { body, a, s1 } = await designNumbers();
  const saved = await call("POST", "/api/accounting/opening", body);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.totals.capital, 127000);
  const entry = await currentOpening();
  assert.equal(entry.type, "opening"); assert.match(entry.number, /^OB-\d{6}$/);
  const lines = await keyedLines(entry);
  assert.equal(lines.length, 8);
  assert.deepEqual(find(lines, "CASH_MAIN"), { key: "CASH_MAIN", debit: 15000, credit: 0, party: null });
  assert.deepEqual(find(lines, "11201"), { key: "11201", debit: 30000, credit: 0, party: null });
  assert.deepEqual(find(lines, "INVENTORY"), { key: "INVENTORY", debit: 84200, credit: 0, party: null });
  assert.equal(lines.filter((row) => row.key === "CUSTOMERS").reduce((sum, row) => sum + row.debit, 0), 6300);
  assert.equal(lines.filter((row) => row.key === "SUPPLIERS").reduce((sum, row) => sum + row.credit, 0), 8500);
  assert.deepEqual(find(lines, "CAPITAL"), { key: "CAPITAL", debit: 0, credit: 127000, party: null });
  assert.equal(entry.totalDebit, entry.totalCredit);
  assert.equal(entry.date.toISOString(), (await Meta.findById("schema").lean()).ledgerStartAt.toISOString());
  const bank = await Account.findOne({ code: "11201" }).lean();
  assert.equal(bank.kind, "bank"); assert.equal(bank.isSystem, false); assert.equal(bank.isGroup, false);
  const supplierLine = entry.lines.find((row) => row.partyType === "supplier" && String(row.partyId) === String(s1._id));
  assert.equal(supplierLine.credit, 6650);
  assert.equal(entry.lines.find((row) => String(row.partyId) === String(a._id)).debit, 4000);
  const audit = await AuditLog.findOne({ action: "opening.saved" }).lean();
  assert.equal(audit.details.capital, 127000);
  await assertHealthy();
});

it("re-saving reverses the old OB, folds the opening_inventory entries and posts a new OB; health stays 0", async () => {
  const { body } = await designNumbers();
  assert.equal((await call("POST", "/api/accounting/opening", body)).status, 200);
  const first = await currentOpening();
  await product({ code: "LATE-STOCK", stock: 10, cost: 10 }); // setup mode: Dr INVENTORY / Cr CAPITAL 100
  const second = await call("POST", "/api/accounting/opening", { ...body, cash: 16000 });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const next = await currentOpening();
  assert.notEqual(String(next._id), String(first._id)); assert.notEqual(next.number, first.number);
  const reloaded = await JournalEntry.findById(first._id).lean();
  assert.ok(reloaded.reversedBy, "the old OB is reversed, never edited");
  assert.equal((await keyedLines(next)).find((row) => row.key === "INVENTORY").debit, 84300, "folded: one clean entry carries the full inventory");
  const folded = await JournalEntry.findOne({ "source.type": "opening_inventory", type: "auto" }).lean();
  assert.ok(folded.reversedBy);
  assert.equal(second.json.totals.capital, 128100);
  const inventory = await Account.findOne({ systemKey: "INVENTORY" }).lean();
  const ledger = await call("GET", `/api/accounting/accounts/${inventory._id}/ledger`);
  assert.equal(ledger.json.balance, 84300);
  await assertHealthy();
});

it("finalize: re-save and a second finalize return 409 OPENING_FINALIZED; finalize needs a saved opening and a confirmation", async () => {
  const { body } = await designNumbers();
  assert.equal((await call("POST", "/api/accounting/opening/finalize", { confirm: true })).json.code, "OPENING_NOT_SAVED");
  assert.equal((await call("POST", "/api/accounting/opening", body)).status, 200);
  assert.equal((await call("POST", "/api/accounting/opening/finalize", {})).status, 400);
  const done = await call("POST", "/api/accounting/opening/finalize", { confirm: true });
  assert.equal(done.status, 200); assert.equal(done.json.status, "finalized"); assert.equal(done.json.setupMode, false);
  const again = await call("POST", "/api/accounting/opening", body);
  assert.equal(again.status, 409); assert.equal(again.json.code, "OPENING_FINALIZED");
  assert.equal((await call("POST", "/api/accounting/opening/finalize", { confirm: true })).json.code, "OPENING_FINALIZED");
  assert.ok(await AuditLog.findOne({ action: "opening.finalized" }));
  // Setup mode is off for good: stock edits now go to the adjustment account.
  const p = await Product.findOne({ code: "DESIGN-1" });
  assert.equal((await call("PUT", `/api/products/${p._id}`, { inventoryCount: 840 })).status, 200);
  assert.ok(await JournalEntry.findOne({ "source.type": "inventory_adjustment" }));
  assert.equal((await call("GET", "/api/accounting/opening")).json.figures.inventory.editable, false);
  await assertHealthy();
});

it("wizard validation: decimals, negatives for cash, duplicates, unknown parties, zero rows dropped", async () => {
  await startLedger();
  const c = await customer("Validate", "01010000301");
  const post = (body) => call("POST", "/api/accounting/opening", body);
  assert.equal((await post({ cash: 10.123 })).status, 400);
  assert.equal((await post({ cash: -5 })).status, 400);
  assert.equal((await post({ customers: [{ customerId: String(c._id), amount: 1 }, { customerId: String(c._id), amount: 2 }] })).json.code, "DUPLICATE_ROW");
  assert.equal((await post({ customers: [{ customerId: "64b7f0f0f0f0f0f0f0f0f0f0", amount: 1 }] })).status, 404);
  assert.equal((await post({ suppliers: [{ supplierId: "64b7f0f0f0f0f0f0f0f0f0f0", amount: 1 }] })).status, 404);
  assert.equal((await post({ banks: [{ name: "X", type: "cheque", amount: 5 }] })).status, 400);
  const ok = await post({ cash: 100, customers: [{ customerId: String(c._id), amount: 0 }], banks: [{ name: "Empty", type: "wallet", amount: 0 }] });
  assert.equal(ok.status, 200);
  assert.equal(await PartyOpening.countDocuments(), 0, "zero rows are dropped");
  assert.equal(await Account.countDocuments({ code: "11201" }), 0);
  assert.equal(await JournalEntry.countDocuments({ type: "opening" }), 1);
  assert.equal((await post({ cash: 5, banks: [{ name: "W", type: "wallet", amount: 7 }, { name: "B", type: "bank", amount: 9 }] })).status, 200);
  assert.deepEqual((await Account.find({ code: { $in: ["11201", "11202"] } }).sort({ code: 1 }).lean()).map((row) => row.kind), ["wallet", "bank"]);
  assert.equal((await post({ banks: [{ accountId: String((await Account.findOne({ code: "11201" }))._id), amount: 11 }] })).status, 200);
  await assertHealthy();
});

it("negative customer and negative supplier openings: credit on 113 and debit on 21", async () => {
  await startLedger();
  const c = await customer("We owe", "01010000401"); const s = await supplier("Owes us");
  const saved = await call("POST", "/api/accounting/opening", { cash: 1000, customers: [{ customerId: String(c._id), amount: -300 }], suppliers: [{ supplierId: s._id, amount: -200 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const lines = await keyedLines(await currentOpening());
  assert.deepEqual(find(lines, "CUSTOMERS"), { key: "CUSTOMERS", debit: 0, credit: 300, party: "customer" });
  assert.deepEqual(find(lines, "SUPPLIERS"), { key: "SUPPLIERS", debit: 200, credit: 0, party: "supplier" });
  assert.equal(saved.json.totals.capital, 1000 - 300 + 200);
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.lines[0].description, "رصيد أول المدة"); assert.equal(statement.lines[0].credit, 300);
  assert.equal(statement.totals.balance, -300);
  assert.equal(statement.outstanding, 0, "a credit is not an outstanding debt");
  assert.equal(statement.aging.credit, 300);
  const list = (await call("GET", "/api/customers")).json.find((row) => row.name === "We owe");
  assert.equal(list.balance, -300); assert.equal(list.isIndebted, false);
  await assertHealthy();
});

// ------------------------------------------------------------ customer opening: statement, aging, collection

const openingCustomer = async (amount = 1000) => {
  await startLedger();
  const c = await customer("Collect Me", "01010000501");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 10, customers: [{ customerId: String(c._id), amount }] })).status, 200);
  return c;
};

it("statement, outstanding, aging, customer list and dashboard include the customer opening", async () => {
  const c = await openingCustomer(1000);
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.lines[0].description, "رصيد أول المدة"); assert.equal(statement.lines[0].type, "opening_balance");
  assert.equal(statement.lines[0].debit, 1000); assert.equal(statement.lines[0].balance, 1000);
  assert.equal(statement.totals.balance, 1000); assert.equal(statement.outstanding, 1000);
  assert.equal(statement.aging.total, 1000);
  assert.equal(statement.aging.current, 1000, "dated on the ledger start (today): not overdue yet, so it sits in current");
  const list = (await call("GET", "/api/customers")).json[0];
  assert.equal(list.isIndebted, true); assert.equal(list.outstanding, 1000); assert.equal(list.balance, 1000);
  const dashboard = (await call("GET", "/api/dashboard/summary")).json;
  assert.equal(dashboard.credit.outstanding, 1000); assert.equal(dashboard.credit.customersWithBalance, 1); assert.equal(dashboard.credit.overdueAmount, 0);
  const detail = (await call("GET", `/api/customers/${c._id}`)).json;
  assert.equal(detail.opening.amount, 1000); assert.equal(detail.opening.remaining, 1000); assert.equal(detail.outstanding, 1000);
  await assertHealthy();
});

it("aging buckets use the opening date and invoice dueDate (or sellingDate)", async () => {
  const c = await openingCustomer(100);
  const p = await product({ code: "AGING", stock: 10, cost: 5 });
  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  for (const [days, due] of [[10, daysAgo(5)], [100, null], [40, daysAgo(40)]]) {
    const invoice = await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: daysAgo(days), ...(due ? { dueDate: due } : {}), items: [{ productId: p._id, quantity: 1, price: 10 }] });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));
  }
  await PartyOpening.updateOne({ partyId: c._id }, { $set: { date: new Date(Date.now() - 70 * 86400000) } });
  const { aging, outstanding } = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(outstanding, 130);
  assert.deepEqual({ current: aging.current, d1: aging.days1to30, d2: aging.days31to60, over: aging.over60 }, { current: 0, d1: 10, d2: 10, over: 110 });
});

it("receipts collect the opening in both payment routes: partly, then fully", async () => {
  const c = await openingCustomer(1000);
  const part = await call("POST", `/api/customers/${c._id}/payments`, { amount: 400, firstInvoice: true });
  assert.equal(part.status, 201, JSON.stringify(part.json));
  assert.equal(part.json.openingCollected, 400);
  let statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.totals.balance, 600); assert.equal(statement.outstanding, 600);
  assert.deepEqual(statement.lines.map((row) => [row.type, row.debit, row.credit]), [["opening_balance", 1000, 0], ["payment", 0, 400]]);
  const receipt = await Receipt.findOne({ number: part.json.receiptNumber }).lean();
  assert.equal(receipt.allocations.length, 1); assert.ok(receipt.allocations[0].opening);
  // Route 2 (by invoice) with an open invoice: the invoice first, the opening last.
  const p = await product({ code: "ROUTE-2", stock: 5, cost: 5 });
  const invoice = await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 50 }] });
  assert.equal(invoice.status, 201);
  const second = await call("POST", `/api/credit-sales/${invoice.json._id}/payments`, { amount: 650 });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  assert.equal(second.json.allocatedInvoices[0].remainingAmount, 0);
  statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.totals.balance, 0); assert.equal(statement.outstanding, 0);
  assert.equal((await call("GET", "/api/customers")).json[0].isIndebted, false);
  assert.equal((await call("GET", "/api/dashboard/summary")).json.credit.outstanding, 0);
  const doc = await PartyOpening.findOne({ partyId: c._id }).lean();
  assert.equal(doc.payments.reduce((sum, row) => sum + row.amount, 0), 1000);
  await assertHealthy();
  // Nothing open any more: a payment is refused as before.
  assert.equal((await call("POST", `/api/customers/${c._id}/payments`, { amount: 1, firstInvoice: true })).status, 404);
});

it("lastInvoice collects invoices newest first and the opening last; firstInvoice pays the opening first and caps at it", async () => {
  const c = await openingCustomer(100);
  const p = await product({ code: "ORDER", stock: 5, cost: 5 });
  await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 50 }] });
  const overpay = await call("POST", `/api/customers/${c._id}/payments`, { amount: 120, firstInvoice: true });
  assert.equal(overpay.status, 400, "firstInvoice only pays the first (opening) item");
  const last = await call("POST", `/api/customers/${c._id}/payments`, { amount: 60, lastInvoice: true });
  assert.equal(last.status, 201, JSON.stringify(last.json));
  assert.equal(last.json.invoices[0].remainingAmount, 0, "the invoice is paid first");
  assert.equal(last.json.openingCollected, 10, "then the opening");
  const first = await call("POST", `/api/customers/${c._id}/payments`, { amount: 90, firstInvoice: true });
  assert.equal(first.status, 201); assert.equal(first.json.openingCollected, 90);
});

it("a re-save cannot lower a customer opening below what was collected (409 OPENING_BELOW_COLLECTED)", async () => {
  const c = await openingCustomer(1000);
  await call("POST", `/api/customers/${c._id}/payments`, { amount: 400, firstInvoice: true });
  const lower = await call("POST", "/api/accounting/opening", { cash: 10, customers: [{ customerId: String(c._id), amount: 300 }] });
  assert.equal(lower.status, 409); assert.equal(lower.json.code, "OPENING_BELOW_COLLECTED");
  assert.equal(lower.json.customerName, "Collect Me"); assert.equal(lower.json.collected, 400);
  const removed = await call("POST", "/api/accounting/opening", { cash: 10 });
  assert.equal(removed.json.code, "OPENING_BELOW_COLLECTED");
  const raised = await call("POST", "/api/accounting/opening", { cash: 10, customers: [{ customerId: String(c._id), amount: 1500 }] });
  assert.equal(raised.status, 200, JSON.stringify(raised.json));
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.totals.balance, 1100);
  await assertHealthy();
});

it("the opening is not a sale: no invoice, no sales or profit figures, and it cannot be edited, cancelled or returned", async () => {
  const c = await openingCustomer(1000);
  const doc = await PartyOpening.findOne({ partyId: c._id }).lean();
  assert.equal(await CreditSale.countDocuments(), 0); assert.equal(await Selling.countDocuments(), 0);
  const dashboard = (await call("GET", "/api/dashboard/summary")).json;
  assert.equal(dashboard.today.credit.total, 0); assert.equal(dashboard.recentInvoices.length, 0);
  for (const row of dashboard.last7Days) assert.equal(row.credit, 0);
  assert.equal((await call("GET", `/api/credit-sales/${doc._id}`)).status, 404);
  assert.equal((await call("PUT", `/api/credit-sales/${doc._id}`, { notes: "x" })).status, 404);
  assert.ok([400, 404].includes((await call("POST", `/api/credit-sales/${doc._id}/cancel`, { reason: "x" })).status), "cancel refuses an opening id");
  assert.equal((await call("POST", `/api/credit-sales/${doc._id}/payments`, { amount: 5 })).status, 404);
  assert.equal((await call("POST", "/api/returns", { returnType: "credit", invoiceId: String(doc._id), items: [] })).status >= 400, true);
  const profit = await call("GET", "/api/products/profit-report");
  assert.equal(profit.status, 200);
  assert.equal(JSON.stringify(profit.json).includes("1000"), false);
  const health = await assertHealthy();
  assert.equal(health.netSales.actual, 0); assert.equal(health.cogs.actual, 0);
  // A customer with an opening cannot be deleted.
  const removed = await call("DELETE", `/api/customers/${c._id}`);
  assert.equal(removed.status, 409); assert.equal(removed.json.code, "CUSTOMER_HAS_OPENING");
});

// ------------------------------------------------------------ suppliers

it("suppliers: CRUD with the design's optional fields, search, balance from the ledger and the delete rules", async () => {
  await startLedger();
  const created = await call("POST", "/api/suppliers", { name: "الشركة المصرية للإضاءة", phone: "01027784410", contactPerson: "م. وائل", address: "العبور", supplies: "لمبات وبانلات", taxNumber: "123-456", paymentTermsDays: 30 });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.phones, ["01027784410"]); assert.equal(created.json.paymentTermsDays, 30); assert.equal(created.json.isActive, true);
  assert.equal((await call("POST", "/api/suppliers", { name: "   " })).status, 400);
  assert.equal((await call("POST", "/api/suppliers", { name: "Bad terms", paymentTermsDays: -1 })).status, 400);
  assert.equal((await call("POST", "/api/suppliers", { name: "Cash", paymentTermsDays: 0 })).json.paymentTermsDays, 0);
  const updated = await call("PUT", `/api/suppliers/${created.json._id}`, { notes: "ملاحظة", paymentTermsDays: 60, isActive: false });
  assert.equal(updated.status, 200); assert.equal(updated.json.paymentTermsDays, 60); assert.equal(updated.json.isActive, false);
  assert.equal((await call("GET", "/api/suppliers?search=للإضاءة")).json.length, 1);
  assert.equal((await call("GET", "/api/suppliers?search=nomatch")).json.length, 0);
  assert.equal((await call("GET", `/api/suppliers/${created.json._id}`)).json.balance, 0);
  assert.equal((await call("GET", "/api/suppliers/not-an-id")).status, 404);
  // Opening balance: the ledger party balance shows on the list and blocks delete.
  assert.equal((await call("POST", "/api/accounting/opening", { suppliers: [{ supplierId: created.json._id, amount: 6650 }] })).status, 200);
  const row = (await call("GET", "/api/suppliers")).json.find((item) => item._id === created.json._id);
  assert.equal(row.balance, 6650); assert.equal(row.openingAmount, 6650);
  const blocked = await call("DELETE", `/api/suppliers/${created.json._id}`);
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "SUPPLIER_HAS_BALANCE");
  // Removed from the wizard, but its reversed ledger lines remain: still blocked.
  assert.equal((await call("POST", "/api/accounting/opening", {})).status, 200);
  assert.equal((await call("DELETE", `/api/suppliers/${created.json._id}`)).json.code, "SUPPLIER_HAS_BALANCE");
  const clean = await supplier("Clean");
  assert.equal((await call("DELETE", `/api/suppliers/${clean._id}`)).status, 200);
  assert.equal(await Supplier.countDocuments({ _id: clean._id }), 0);
});

it("SUPPLIERS ledger lines need partyType supplier and an existing supplier; other control rules hold", async () => {
  await startLedger();
  const s = await supplier("Party check");
  const attempt = (extra) => withTransaction(async (session) => {
    const accounts = await accountMap(["SUPPLIERS", "CAPITAL", "CUSTOMERS"], session);
    return postEntry({ date: new Date(), source: { type: "manual_test", id: s._id }, session, lines: [line(accounts.get("CAPITAL"), 5, "debit"), line(accounts.get("SUPPLIERS"), 5, "credit", extra)] });
  });
  await assert.rejects(() => attempt({}), /Supplier party is required/);
  await assert.rejects(() => attempt({ partyType: "customer", partyId: s._id }), /Supplier party is required/);
  await assert.rejects(() => attempt({ partyType: "supplier", partyId: "64b7f0f0f0f0f0f0f0f0f0f0" }), /does not exist/);
  await attempt({ partyType: "supplier", partyId: s._id, partyName: s.name });
  await assert.rejects(() => withTransaction(async (session) => {
    const accounts = await accountMap(["CASH_MAIN", "CAPITAL"], session);
    return postEntry({ date: new Date(), source: { type: "manual_test", id: s._id }, session, lines: [line(accounts.get("CASH_MAIN"), 5, "debit", { partyType: "supplier", partyId: s._id }), line(accounts.get("CAPITAL"), 5, "credit")] });
  }), /only allowed on control accounts/);
});

// ------------------------------------------------------------ health

it("health can fail: the suppliers check and the opening check catch tampering", async () => {
  const { body, s1 } = await designNumbers();
  assert.equal((await call("POST", "/api/accounting/opening", body)).status, 200);
  await assertHealthy();
  await PartyOpening.updateOne({ partyType: "supplier", partyId: s1._id }, { $set: { amount: 7000 } });
  const bad = (await call("GET", "/api/accounting/health")).json;
  assert.equal(bad.suppliers.difference, 350); assert.equal(bad.suppliers.bySupplier[0].name, "Light Co");
  assert.equal(bad.opening.ok, false); assert.equal(bad.opening.difference > 0, true, "the stored opening data no longer matches the posted entry");
  await PartyOpening.updateOne({ partyType: "supplier", partyId: s1._id }, { $set: { amount: 6650 } });
  await assertHealthy();
  await Meta.updateOne({ _id: "schema" }, { $set: { "opening.data.cash": 14000 } });
  const cash = (await call("GET", "/api/accounting/health")).json;
  assert.equal(cash.opening.difference, 2000, "cash line and the capital plug both differ by 1,000");
  assert.equal(cash.trialBalance.difference, 0);
});

it("health: customers check covers customer openings (a tampered opening shows per customer)", async () => {
  const c = await openingCustomer(1000);
  await PartyOpening.updateOne({ partyId: c._id }, { $set: { amount: 900 } });
  const bad = (await call("GET", "/api/accounting/health")).json;
  assert.equal(bad.customers.byCustomer[0].difference, 100);
});

// ------------------------------------------------------------ permissions

it("permissions: the wizard needs accounting.manage; suppliers.view/manage per role template", async () => {
  await startLedger();
  const cashier = await call("POST", "/api/users", { name: "Cashier", username: "cash18", password: "secret-pass-1", role: "cashier" });
  assert.equal(cashier.status, 201);
  const accountant = await call("POST", "/api/users", { name: "Acc", username: "acc18", password: "secret-pass-1", role: "accountant" });
  const keeper = await call("POST", "/api/users", { name: "Keep", username: "keep18", password: "secret-pass-1", role: "storekeeper" });
  const manager = await call("POST", "/api/users", { name: "Mgr", username: "mgr18", password: "secret-pass-1", role: "manager" });
  assert.deepEqual([cashier.status, accountant.status, keeper.status, manager.status], [201, 201, 201, 201]);
  const results = {};
  for (const [name, user] of [["cashier", "cash18"], ["accountant", "acc18"], ["storekeeper", "keep18"], ["manager", "mgr18"]]) {
    token = await login(user, "secret-pass-1");
    results[name] = {
      view: (await call("GET", "/api/suppliers")).status,
      manage: (await call("POST", "/api/suppliers", { name: `S-${name}` })).status,
      wizardSave: (await call("POST", "/api/accounting/opening", { cash: 1 })).status,
      wizardFinalize: (await call("POST", "/api/accounting/opening/finalize", { confirm: true })).status,
      wizardRead: (await call("GET", "/api/accounting/opening")).status,
    };
  }
  token = ownerToken;
  assert.deepEqual(results.cashier, { view: 403, manage: 403, wizardSave: 403, wizardFinalize: 403, wizardRead: 403 });
  assert.deepEqual(results.accountant, { view: 200, manage: 403, wizardSave: 403, wizardFinalize: 403, wizardRead: 200 });
  assert.deepEqual(results.storekeeper, { view: 200, manage: 403, wizardSave: 403, wizardFinalize: 403, wizardRead: 403 });
  assert.deepEqual(results.manager, { view: 200, manage: 201, wizardSave: 403, wizardFinalize: 403, wizardRead: 200 });
  assert.ok(ROLE_TEMPLATES.owner.includes("suppliers.manage"));
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 1 })).status, 200);
});

it("audit: opening.saved keeps totals only, and leaves out inventory and capital for a user without viewCost", async () => {
  await startLedger();
  await product({ code: "AUDIT-COST", stock: 2, cost: 50 });
  const limited = await makeUser("manage-only", ["accounting.manage"]);
  token = limited;
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 500 })).status, 200);
  token = ownerToken;
  const row = await AuditLog.findOne({ action: "opening.saved", userName: "manage-only" }).lean();
  assert.equal(row.details.cash, 500);
  assert.equal("inventory" in row.details, false); assert.equal("capital" in row.details, false); assert.equal("assets" in row.details, false);
  assert.equal(JSON.stringify(row.details).includes("lines"), false, "no per-line cost");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 600 })).status, 200);
  const full = await AuditLog.findOne({ action: "opening.saved", userName: "Owner" }).lean();
  assert.equal(full.details.inventory, 100);
});

// ------------------------------------------------------------ upgraded installs

it("upgraded install: OB-000001 with sales after the start keeps its inventory read-only and carried; invoice customer balances stay", async () => {
  // Before the ledger: products, a credit customer with an open invoice.
  const p = await product({ code: "UPGRADE", stock: 10, cost: 20 });
  const c = await customer("Legacy", "01010000601");
  const invoice = await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-01", items: [{ productId: p._id, quantity: 2, price: 100 }] });
  assert.equal(invoice.status, 201);
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
  const ob = await JournalEntry.findOne({ number: "OB-000001" }).lean();
  assert.ok(ob);
  const obInventory = (await keyedLines(ob)).find((row) => row.key === "INVENTORY").debit;
  assert.equal(obInventory, 160);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sell(p); // after the start: setup mode is off
  const state = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(state.setupMode, false); assert.equal(state.figures.inventory.editable, false); assert.equal(state.figures.inventory.amount, 160);
  const other = await customer("New opening", "01010000602");
  const saved = await call("POST", "/api/accounting/opening", { cash: 2500, customers: [{ customerId: String(other._id), amount: 700 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const entry = await currentOpening();
  const lines = await keyedLines(entry);
  assert.equal(find(lines, "INVENTORY").debit, 160, "carried unchanged");
  assert.equal(find(lines, "CASH_MAIN").debit, 2500);
  assert.equal(entry.lines.find((row) => String(row.partyId) === String(c._id)).debit, 200, "the invoice balance of the legacy customer is carried");
  assert.equal((await JournalEntry.findById(ob._id).lean()).reversedBy != null, true);
  await assertHealthy();
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.totals.balance, 200);
  const again = await call("POST", "/api/accounting/opening", { cash: 2600, customers: [{ customerId: String(other._id), amount: 700 }] });
  assert.equal(again.status, 200);
  assert.equal((await keyedLines(await currentOpening())).find((row) => row.key === "INVENTORY").debit, 160);
  await assertHealthy();
});

it("upgraded install with no sales yet is still in setup mode: the wizard folds old adjustments into one clean opening", async () => {
  const p = await product({ code: "UPGRADE-SETUP", stock: 10, cost: 20 });
  await startLedgerKeepingData();
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, true);
  assert.equal((await call("PUT", `/api/products/${p._id}`, { inventoryCount: 12 })).status, 200);
  const saved = await call("POST", "/api/accounting/opening", { cash: 50 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal((await keyedLines(await currentOpening())).find((row) => row.key === "INVENTORY").debit, 240);
  await assertHealthy();
  async function startLedgerKeepingData() {
    await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
    await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
  }
});

it("GET /api/accounting/opening reports the status, figures, totals and the posted entry", async () => {
  const { body } = await designNumbers();
  await call("POST", "/api/accounting/opening", body);
  const state = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(state.status, "setup"); assert.equal(state.setupMode, true);
  assert.equal(state.figures.cash, 15000); assert.equal(state.figures.banks.length, 1); assert.equal(state.figures.banks[0].code, "11201");
  assert.equal(state.figures.inventory.amount, 84200); assert.equal(state.figures.inventory.mode, "live");
  assert.equal(state.figures.customers.length, 2); assert.equal(state.figures.suppliers.length, 2);
  assert.deepEqual({ assets: state.totals.assets, liabilities: state.totals.liabilities, capital: state.totals.capital }, { assets: 135500, liabilities: 8500, capital: 127000 });
  assert.equal(state.entry.number.startsWith("OB-"), true);
});

// ------------------------------------------------------------ display fields

it("accounts and ledger keep the raw signed balance and add side and absBalance", async () => {
  const { body } = await designNumbers();
  await call("POST", "/api/accounting/opening", body);
  const tree = (await call("GET", "/api/accounting/accounts")).json.accounts;
  const flat = []; const walk = (rows) => rows.forEach((row) => { flat.push(row); walk(row.children || []); }); walk(tree);
  const capital = flat.find((row) => row.systemKey === "CAPITAL");
  assert.equal(capital.balance, -127000); assert.equal(capital.side, "credit"); assert.equal(capital.absBalance, 127000);
  const cash = flat.find((row) => row.systemKey === "CASH_MAIN");
  assert.equal(cash.balance, 15000); assert.equal(cash.side, "debit"); assert.equal(cash.absBalance, 15000);
  const assets = flat.find((row) => row.code === "1");
  assert.equal(assets.side, "debit"); assert.equal(assets.absBalance, 135500);
  const ledger = (await call("GET", `/api/accounting/accounts/${capital._id}/ledger`)).json;
  assert.equal(ledger.balance, -127000); assert.equal(ledger.side, "credit"); assert.equal(ledger.absBalance, 127000);
  const last = ledger.lines.at(-1); assert.equal(last.side, "credit"); assert.equal(last.absBalance, 127000);
  assert.equal(ledger.lines[0].side, "credit", "the typed-in stock posted to capital first");
  const suppliers = flat.find((row) => row.systemKey === "SUPPLIERS");
  const supplierLedger = (await call("GET", `/api/accounting/accounts/${suppliers._id}/ledger`)).json;
  assert.equal(supplierLedger.parties.length, 2, "the supplier ledger lists suppliers for the party filter");
});

// ------------------------------------------------------------ Stage 18 review fixes

const { isSetupMode, postStockAdjustment } = require("../src/accounting/opening");
const { reverseEntry } = require("../src/accounting/posting");
const inventoryLedger = async () => {
  const account = await Account.findOne({ systemKey: "INVENTORY" }).lean();
  const rows = await JournalEntry.aggregate([{ $match: { status: "posted" } }, { $unwind: "$lines" }, { $match: { "lines.accountId": account._id } }, { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]);
  return rows[0]?.balance || 0;
};
const stockWorth = async () => (await Product.find({}).lean()).reduce((sum, row) => sum + row.inventoryCount * row.purchasePrice, 0);
const obInventory = async () => (find(await keyedLines(await currentOpening()), "INVENTORY") || { debit: 0 }).debit;

it("repro A: setup products, then a sale, then the first wizard save keeps the inventory (INVENTORY = sum of stock x price, health 0)", async () => {
  await startLedger();
  const p = await product({ code: "REPRO-A", stock: 10, cost: 20 });
  await sell(p);
  assert.equal(await inventoryLedger(), 180);
  const before = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(before.setupMode, false); assert.equal(before.figures.inventory.amount, 200, "the read-only amount shown = the folded opening inventory");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 100 })).status, 200);
  assert.equal(await obInventory(), 200, "the amount posted equals the amount shown");
  assert.equal(await inventoryLedger(), await stockWorth());
  await assertHealthy();
  const after = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(after.figures.inventory.amount, 200);
});

it("repro B: save, add a product while still in setup, then a sale, then a re-save keeps every inventory line", async () => {
  await startLedger();
  const first = await product({ code: "REPRO-B1", stock: 10, cost: 20 });
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 50 })).status, 200);
  assert.equal(await obInventory(), 200);
  await assertHealthy();
  await product({ code: "REPRO-B2", stock: 5, cost: 40 }); // still setup: an opening_inventory entry beside the OB
  assert.equal((await call("GET", "/api/accounting/opening")).json.setupMode, true);
  assert.equal(await JournalEntry.countDocuments({ type: "auto", "source.type": "opening_inventory", reversedBy: null }), 1);
  await sell(first); // ends setup mode
  const shown = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(shown.setupMode, false); assert.equal(shown.figures.inventory.amount, 400, "OB 200 + the later 200 (the sale cost stays outside the opening entries)");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 60 })).status, 200);
  assert.equal(await obInventory(), 400, "carried inventory = previous OB + every folded opening_inventory entry");
  assert.equal(await JournalEntry.countDocuments({ type: "auto", "source.type": "opening_inventory", reversedBy: null }), 0);
  assert.equal(await inventoryLedger(), await stockWorth());
  await assertHealthy();
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 61 })).status, 200);
  assert.equal(await obInventory(), 400); assert.equal(await inventoryLedger(), await stockWorth());
  await assertHealthy();
});

it("repro C: on an upgraded install GET /opening's capital equals the posted CAPITAL line before and after the first save", async () => {
  const p = await product({ code: "REPRO-C", stock: 10, cost: 20 });
  const c = await customer("Legacy C", "01010000611");
  assert.equal((await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-01", items: [{ productId: p._id, quantity: 2, price: 100 }] })).status, 201);
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
  const capitalOf = async (entry) => { const row = find(await keyedLines(entry), "CAPITAL"); return row.credit - row.debit; };
  const ob = await JournalEntry.findOne({ number: "OB-000001" }).lean();
  assert.equal(await capitalOf(ob), 360);
  const before = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(before.setupMode, true);
  assert.equal(before.totals.capital, 360, "the review before the first save");
  assert.deepEqual(before.figures.carriedCustomers.map((row) => [String(row.customerId), row.amount, row.name]), [[String(c._id), 200, "Legacy C"]], "carried balances are listed with the customer name");
  assert.equal((await call("POST", "/api/accounting/opening", {})).status, 200);
  assert.equal(await capitalOf(await currentOpening()), 360, "the posted capital");
  const after = (await call("GET", "/api/accounting/opening")).json;
  assert.equal(after.totals.capital, 360);
  await assertHealthy();
});

it("setup mode ends with a write: the first sale/credit sale/receipt sets setupEndedAt; setup postings touch lastSetupPostingAt", async () => {
  await startLedger();
  const p = await product({ code: "WRITE-END", stock: 10, cost: 20 });
  let meta = await Meta.findById("schema").lean();
  assert.ok(meta.opening.lastSetupPostingAt, "a setup-mode stock posting writes meta"); assert.equal(meta.opening.setupEndedAt, undefined);
  const c = await customer("Write End", "01010000621");
  await sell(p);
  meta = await Meta.findById("schema").lean();
  assert.ok(meta.opening.setupEndedAt, "the first sale wrote setupEndedAt in its own transaction");
  const endedAt = String(meta.opening.setupEndedAt);
  const touched = String(meta.opening.lastSetupPostingAt);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await call("PUT", `/api/products/${p._id}`, { inventoryCount: 5 })).status, 200);
  meta = await Meta.findById("schema").lean();
  assert.equal(String(meta.opening.lastSetupPostingAt), touched, "after the end, stock postings no longer write meta");
  assert.equal(String(meta.opening.setupEndedAt), endedAt, "set once, never moved");
  assert.equal(await JournalEntry.countDocuments({ "source.type": "inventory_adjustment" }), 1);
  // A credit sale and a receipt each end it as well.
  for (const make of [
    () => call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 100 }] }),
    () => Receipt.create({ number: "RC-000950", customer: c._id, amount: 5, paymentDate: new Date(), kind: "payment", allocations: [] }),
  ]) {
    await Meta.updateOne({ _id: "schema" }, { $unset: { "opening.setupEndedAt": "" } });
    assert.equal(await isSetupMode(), true);
    await make();
    assert.ok((await Meta.findById("schema").lean()).opening?.setupEndedAt);
  }
});

it("after setupEndedAt the answer comes from meta only: deleting every document does not bring setup mode back", async () => {
  await startLedger();
  const p = await product({ code: "META-ONLY", stock: 3, cost: 10 });
  await sell(p);
  assert.equal(await isSetupMode(), false);
  await Selling.deleteMany({}); await CreditSale.deleteMany({}); await Receipt.deleteMany({});
  assert.equal(await isSetupMode(), false, "no collection scan: the marker decides");
  const source = require("fs").readFileSync(require("path").join(__dirname, "../src/accounting/opening.js"), "utf8");
  assert.ok(/const isSetupMode = async \(session\) => setupModeOf\(await getOpeningMeta\(session\)\)/.test(source));
});

it("concurrent first sale and stock edit: the stock edit conflicts on meta, retries and posts to INVENTORY_ADJUSTMENT", async () => {
  await startLedger();
  const stockProduct = await product({ code: "CONC-STOCK", stock: 10, cost: 20 });
  const soldProduct = await product({ code: "CONC-SOLD", stock: 10, cost: 20 });
  let attempts = 0; let release; const gate = new Promise((resolve) => { release = resolve; });
  const edit = withTransaction(async (session) => {
    attempts += 1;
    assert.equal(await isSetupMode(session), attempts === 1, "attempt 1 starts in setup mode; the retry sees the end");
    if (attempts === 1) await gate; // hold the snapshot open until the sale has committed
    return postStockAdjustment({ date: new Date(), source: { type: "inventory_adjustment", id: stockProduct._id, number: "CONC" }, amount: 50, increase: true, session });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await sell(soldProduct); // a different product: only meta is shared
  release();
  const entry = await edit;
  assert.equal(attempts, 2, "the stock edit conflicted once and retried");
  const accounts = await Account.find({ _id: { $in: entry.lines.map((row) => row.accountId) } }).lean();
  assert.deepEqual(accounts.map((row) => row.systemKey).sort(), ["INVENTORY", "INVENTORY_ADJUSTMENT"]);
  assert.equal(entry.source.type, "inventory_adjustment");
});

it("health: the opening check fails when the OB is reversed or the unreversed opening entries are not exactly one", async () => {
  const { body } = await designNumbers();
  assert.equal((await call("POST", "/api/accounting/opening", body)).status, 200);
  const health = await assertHealthy();
  assert.equal(health.opening.unreversedEntries, 1); assert.equal(health.opening.countOk, true);
  const ob = await currentOpening();
  await withTransaction((session) => reverseEntry(ob._id, { date: ob.date, memo: "tamper", session }));
  const reversed = (await call("GET", "/api/accounting/health")).json.opening;
  assert.equal(reversed.entryReversed, true); assert.equal(reversed.countOk, false); assert.equal(reversed.ok, false); assert.equal(reversed.difference, 0, "money still matches: the failure is structural");
  // Undo, then add a second unreversed opening entry.
  await JournalEntry.updateOne({ _id: ob._id }, { $set: { reversedBy: null } });
  await JournalEntry.deleteOne({ reversalOf: ob._id });
  const restored = (await call("GET", "/api/accounting/health")).json.opening;
  assert.equal(restored.difference, 0); assert.equal(restored.ok, true);
  const accounts = await accountMap(["CASH_MAIN", "CAPITAL"]);
  await withTransaction((session) => postEntry({ date: ob.date, type: "opening", memo: "stray", session, source: { type: "opening", id: new mongoose.Types.ObjectId(), number: "OB-STRAY" }, lines: [line(accounts.get("CASH_MAIN"), 5, "debit"), line(accounts.get("CAPITAL"), 5, "credit")] }));
  const two = (await call("GET", "/api/accounting/health")).json.opening;
  assert.equal(two.unreversedEntries, 2); assert.equal(two.countOk, false); assert.equal(two.entryReversed, false); assert.equal(two.ok, false);
});

it("health: a stray SUPPLIERS party line (no supplier opening behind it) fails the suppliers check", async () => {
  const { body } = await designNumbers();
  assert.equal((await call("POST", "/api/accounting/opening", body)).status, 200);
  await assertHealthy();
  const stray = await supplier("Stray Co");
  const accounts = await accountMap(["SUPPLIERS", "CASH_MAIN"]);
  await withTransaction((session) => postEntry({ date: new Date(), memo: "stray supplier line", session, source: { type: "manual", id: new mongoose.Types.ObjectId(), number: "M-1" }, lines: [line(accounts.get("CASH_MAIN"), 90, "debit"), line(accounts.get("SUPPLIERS"), 90, "credit", { partyType: "supplier", partyId: stray._id, partyName: "Stray Co" })] }));
  const bad = (await call("GET", "/api/accounting/health")).json.suppliers;
  assert.equal(bad.difference, 90); assert.equal(bad.bySupplier[0].name, "Stray Co");
});

it("credit return: the refund credit pays the other invoices first, then the customer's opening, then the remainder is refunded", async () => {
  await startLedger();
  const p = await product({ code: "RET-OPEN", stock: 50, cost: 20 });
  const c = await customer("Return Opening", "01010000631");
  assert.equal((await call("POST", "/api/accounting/opening", { customers: [{ customerId: String(c._id), amount: 500 }] })).status, 200);
  const credit = (quantity, downPayment) => call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity, price: 100 }], ...(downPayment ? { downPayment } : {}) });
  const paid = await credit(3, 300); assert.equal(paid.status, 201, JSON.stringify(paid.json));
  const open = await credit(1); assert.equal(open.status, 201);
  const returned = await call("POST", "/api/returns", { returnType: "credit", invoiceId: paid.json._id, items: [{ productId: p._id, quantity: 3, returnReason: "x" }] });
  assert.equal(returned.status, 201, JSON.stringify(returned.json));
  const second = (await call("GET", `/api/credit-sales/${open.json._id}`)).json;
  assert.equal(second.remainingAmount, 0, "the other invoice is paid first (100)");
  const opening = await PartyOpening.findOne({ partyId: c._id }).lean();
  assert.deepEqual(opening.payments.map((row) => [row.amount, row.source]), [[200, "return_reallocation"]], "then the opening (the remaining 200 of the 300 credit)");
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.outstanding, 300);
  assert.equal(statement.lines.filter((row) => row.type === "payment").length, 1, "only the down payment shows; the reallocation is already on the statement as the return");
  await assertHealthy();
  const low = await call("POST", "/api/accounting/opening", { customers: [{ customerId: String(c._id), amount: 100 }] });
  assert.equal(low.status, 409); assert.equal(low.json.code, "OPENING_BELOW_COLLECTED");
});

it("bank and wallet accounts are 5-digit children of 112 and the migration renames old 4-digit leaves, journal lines included", async () => {
  await startLedger();
  const created = await call("POST", "/api/accounting/opening", { banks: [{ name: "Bank A", type: "bank", amount: 100 }, { name: "Wallet B", type: "wallet", amount: 50 }] });
  assert.equal(created.status, 200);
  assert.deepEqual((await Account.find({ kind: { $in: ["bank", "wallet"] } }).sort({ code: 1 }).lean()).map((row) => row.code), ["11201", "11202"]);
  // Put the data back into the old scheme, then run the migration.
  const bank = await Account.findOne({ code: "11201" });
  await Account.collection.updateOne({ _id: bank._id }, { $set: { code: "1121" } });
  await JournalEntry.collection.updateMany({ "lines.accountId": bank._id }, { $set: { "lines.$[row].accountCode": "1121" } }, { arrayFilters: [{ "row.accountId": bank._id }] });
  await Meta.updateOne({ _id: "schema" }, { $set: { version: 5 } });
  assert.equal(await runMigrations(), 9);
  assert.equal((await Account.findById(bank._id).lean()).code, "11201");
  const entry = await currentOpening();
  assert.equal(entry.lines.find((row) => String(row.accountId) === String(bank._id)).accountCode, "11201");
  const more = await call("POST", "/api/accounting/opening", { banks: [{ name: "Bank C", type: "bank", amount: 10 }] });
  assert.equal(more.status, 200);
  assert.ok(await Account.findOne({ code: "11203" }), "a new bank continues after the highest code");
  await assertHealthy();
});

it("the migration marks setupEndedAt for installs that already have documents after the ledger start", async () => {
  await startLedger();
  const p = await product({ code: "MIG-END", stock: 4, cost: 10 });
  await sell(p);
  await Meta.updateOne({ _id: "schema" }, { $unset: { "opening.setupEndedAt": "" }, $set: { version: 5 } });
  assert.equal(await isSetupMode(), true, "the marker is missing");
  assert.equal(await runMigrations(), 9);
  assert.equal(await isSetupMode(), false);
  assert.ok((await Meta.findById("schema").lean()).opening.setupEndedAt);
});

it("createReturnLog requires a transaction session", async () => {
  const { createReturnLog } = require("../src/services/returns.service");
  const ReturnLog = require("../src/models/returnLog.model");
  await assert.rejects(() => createReturnLog({}), /requires a transaction session/);
  assert.equal(await ReturnLog.countDocuments(), 0, "nothing was written");
});
