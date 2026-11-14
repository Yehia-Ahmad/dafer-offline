process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage21-return-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Supplier = require("../src/models/supplier.model");
const VatEvent = require("../src/models/vatEvent.model");
const VatReturn = require("../src/models/vatReturn.model");
const { runMigrations } = require("../src/migrations");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { postEntry, accountMap, line } = require("../src/accounting/posting");
const { setClock } = require("../src/utils/clock");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

// Stage 21: the monthly VAT return (prepare, file, pay, unfile), health and permissions. Dates come from an injected clock
// so several months can be filed in one test.

let stop; let server; let baseUrl; let token; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27142 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage21r-owner", password: "owner-pass-123" });
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
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };
const r2 = (value) => Math.round(value * 100) / 100 + 0; // + 0 turns -0 into 0
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const atClock = (year, month, day) => setClock(() => new Date(year, month - 1, day, 12, 0, 0));
const file = (period) => call("POST", `/api/vat/returns/${period}/file`);
async function keyed(entry) {
  const accounts = await Account.find({}).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey || account.code]));
  return entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit }));
}
const entriesOf = async (type, id) => Promise.all((await JournalEntry.find({ "source.type": type, "source.id": id }).sort({ createdAt: 1 }).lean()).map(async (entry) => ({ type: entry.type, lines: await keyed(entry) })));
const amounts = (entry, keys) => Object.fromEntries(entry.lines.filter((row) => keys.includes(row.key)).map((row) => [row.key, row.debit ? { debit: row.debit } : { credit: row.credit }]));
async function assertHealthy() {
  const report = ok(await call("GET", "/api/accounting/health"));
  for (const [name, check] of Object.entries(report)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
  return report;
}
const accountBalance = async (key) => {
  const account = await Account.findOne({ systemKey: key }).lean();
  const rows = await JournalEntry.aggregate([{ $unwind: "$lines" }, { $match: { "lines.accountId": account._id } }, { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]);
  return rows.length ? r2(rows[0].balance) : 0;
};
const makeUser = async (username, role) => {
  ok(await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role }), 201);
  return ok(await call("POST", "/api/auth/login", { username, password: "secret-pass-1" })).token;
};
async function product(code, cost) {
  const category = await Category.create({ name: `S21R ${code}` });
  return ok(await call("POST", "/api/products", { name: code, code, categoryId: String(category._id), inventoryCount: 500, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 100 }), 201);
}
async function shop() {
  await startLedger();
  ok(await call("POST", "/api/accounting/opening", { cash: 50000 }));
  const a = await product("A35", 20); const b = await product("B65", 40);
  const main = ok(await call("GET", "/api/cashbox/boxes")).data.find((box) => box.isMain);
  ok(await call("PUT", "/api/shop-profile", { name: "محل الاختبار", taxNumber: "123-456-789", vat: { enabled: true, rate: 14, pricesIncludeVat: true } }));
  return { a, b, main };
}
const sale = (s, date, lines, extra = {}) => call("POST", "/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: date, items: lines, ...extra });
const design = (s) => [{ productId: s.a._id, quantity: 4, price: 35 }, { productId: s.b._id, quantity: 2, price: 65 }];

it("the return: October has input > output (a credit that carries); a late document goes to the next month; file posts the offset; pay partially then fully; out of order is 409", async () => {
  atClock(2026, 10, 10);
  const s = await shop();
  const supplier = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  const first = ok(await sale(s, "2026-10-12", design(s), { discountAmount: 20 }), 201);
  assert.equal(first.vatPeriod, "2026-10");
  const purchase = ok(await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: "2026-10-13", items: [{ productId: s.a._id, qty: 20, unitPrice: 70 }, { productId: s.b._id, qty: 10, unitPrice: 240 }, { productId: s.a._id, qty: 30, unitPrice: 55 }] }), 201);
  assert.equal(purchase.vatAmount, 763);
  const prepared = ok(await call("GET", "/api/vat/returns/2026-10"));
  assert.equal(prepared.output, 30.7); assert.equal(prepared.input, 763); assert.equal(prepared.carriedIn, 0); assert.equal(prepared.net, -732.3);
  assert.equal(prepared.status, "open"); assert.equal(prepared.canFile, false, "a month can be filed only after it has ended");
  const early = await file("2026-10");
  assert.equal(early.status, 409); assert.equal(early.json.code, "PERIOD_NOT_ENDED");
  atClock(2026, 11, 1);
  assert.equal(ok(await call("GET", "/api/vat/returns/2026-10")).canFile, true);
  assert.equal(prepared.lines.sales.length, 1); assert.equal(prepared.lines.purchases.length, 1); assert.equal(prepared.lines.sales[0].vat, 30.7);
  assert.deepEqual(prepared.groupTotals.sales, { count: 1, net: prepared.lines.sales[0].net, vat: 30.7 }, "Stage 23: the group subtotals come from the API (the VAT return print shows them)");
  assert.deepEqual(prepared.groupTotals.purchases, { count: 1, net: prepared.lines.purchases[0].net, vat: 763 });
  assert.deepEqual(prepared.groupTotals.expenses, { count: 0, net: 0, vat: 0 });

  // Filing is one transaction: the offset entry, the stored figures, the filed status.
  const filed = ok(await file("2026-10"), 201);
  assert.equal(filed.number, "VR-000001"); assert.equal(filed.status, "filed"); assert.equal(filed.offset, 30.7); assert.equal(filed.credit, 732.3); assert.equal(filed.payable, 0);
  const [offset] = await entriesOf("vat_return", (await VatReturn.findOne({ period: "2026-10" }).lean())._id);
  assert.deepEqual(amounts(offset, ["VAT_PAYABLE", "VAT_INPUT"]), { VAT_PAYABLE: { debit: 30.7 }, VAT_INPUT: { credit: 30.7 } });
  assert.equal((await file("2026-10")).status, 409, "already filed");
  assert.equal(await accountBalance("VAT_INPUT"), 732.3, "the credit stays on VAT_INPUT");
  await assertHealthy();

  // A late document for a filed month goes to the first unfiled month after it; the filed return never changes.
  const late = ok(await sale(s, "2026-10-20", design(s), { discountAmount: 20 }), 201);
  assert.equal(late.vatPeriod, "2026-11");
  assert.equal(ok(await call("GET", "/api/vat/returns/2026-10")).output, 30.7);
  const big = ok(await sale(s, "2026-11-05", [{ productId: s.a._id, quantity: 1, price: 11400 }]), 201);
  assert.equal(big.vatAmount, 1400);

  // November: output 30.70 + 1,400, input 0, carried 732.30 -> payable 698.40, offset 732.30
  atClock(2026, 12, 1);
  const november = ok(await call("GET", "/api/vat/returns/2026-11"));
  assert.equal(november.output, 1430.7); assert.equal(november.input, 0); assert.equal(november.carriedIn, 732.3); assert.equal(november.net, 698.4);
  const skipped = await file("2026-12");
  assert.equal(skipped.status, 409); assert.equal(skipped.json.code, "OUT_OF_ORDER"); assert.equal(skipped.json.expected, "2026-11");
  const filedNov = ok(await file("2026-11"), 201);
  assert.equal(filedNov.payable, 698.4); assert.equal(filedNov.offset, 732.3); assert.equal(filedNov.credit, 0);
  assert.equal(await accountBalance("VAT_INPUT"), 0);

  // Paying: partial, over the remaining (409), then the rest. Each is a money document on its box.
  const before = ok(await call("GET", `/api/cashbox/boxes/${s.main._id}`)).balance;
  const part = ok(await call("POST", "/api/vat/returns/2026-11/pay", { amount: 300, boxId: s.main._id, reference: "إيصال 1" }), 201);
  assert.equal(part.payment.number, "VP-000001"); assert.equal(part.return.status, "partial"); assert.equal(part.return.paid, 300); assert.equal(part.return.remaining, 398.4);
  const over = await call("POST", "/api/vat/returns/2026-11/pay", { amount: 500, boxId: s.main._id });
  assert.equal(over.status, 409); assert.equal(over.json.code, "EXCEEDS_REMAINING");
  const rest = ok(await call("POST", "/api/vat/returns/2026-11/pay", { amount: 398.4, boxId: s.main._id }), 201);
  assert.equal(rest.payment.number, "VP-000002"); assert.equal(rest.return.status, "paid"); assert.equal(rest.return.remaining, 0);
  assert.equal(ok(await call("GET", `/api/cashbox/boxes/${s.main._id}`)).balance, r2(before - 698.4));
  assert.equal((await call("POST", "/api/vat/returns/2026-11/pay", { amount: 1, boxId: s.main._id })).status, 409, "nothing left to pay");
  assert.equal((await call("POST", "/api/vat/returns/2026-10/pay", { amount: 1, boxId: s.main._id })).status, 409, "October had nothing payable");
  assert.equal(await accountBalance("VAT_PAYABLE"), 0);
  const list = ok(await call("GET", "/api/vat/returns")).data;
  assert.deepEqual(list.filter((row) => row.returnId).map((row) => [row.period, row.status]).sort(), [["2026-10", "filed"], ["2026-11", "paid"]]);
  const report = await assertHealthy();
  assert.equal(report.vat.paid, 698.4); assert.equal(report.vat.offsets, 763);
  // The export is a workbook.
  const exported = await fetch(`${baseUrl}/api/vat/returns/2026-11/export`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(exported.status, 200); assert.match(exported.headers.get("content-type"), /spreadsheetml/);
});

it("unfile: owner only, the latest return only, no payment, a reason; the offset is reversed and the month can be filed again", async () => {
  atClock(2026, 10, 10);
  const s = await shop();
  ok(await sale(s, "2026-10-12", design(s), { discountAmount: 20 }), 201);
  atClock(2026, 11, 2);
  ok(await file("2026-10"), 201);
  ok(await sale(s, "2026-11-02", [{ productId: s.a._id, quantity: 1, price: 114 }]), 201);
  assert.equal((await file("2026-11")).json.code, "PERIOD_NOT_ENDED", "November is still running on Nov 2");
  atClock(2026, 12, 2);
  ok(await sale(s, "2026-12-02", [{ productId: s.a._id, quantity: 1, price: 114 }]), 201);
  ok(await file("2026-11"), 201);
  token = await makeUser("s21-accountant", "accountant");
  const denied = await call("POST", "/api/vat/returns/2026-11/unfile", { reason: "غلط" });
  assert.equal(denied.status, 403); assert.equal(denied.json.code, "OWNER_ONLY");
  token = ownerToken;
  assert.equal((await call("POST", "/api/vat/returns/2026-10/unfile", { reason: "غلط" })).json.code, "NOT_LATEST");
  assert.equal((await call("POST", "/api/vat/returns/2026-11/unfile", {})).status, 400, "a reason is required");
  ok(await call("POST", "/api/vat/returns/2026-11/pay", { amount: 5, boxId: s.main._id }), 201);
  assert.equal((await call("POST", "/api/vat/returns/2026-11/unfile", { reason: "غلط" })).json.code, "HAS_PAYMENTS");
  assert.equal((await file("2026-12")).json.code, "PERIOD_NOT_ENDED", "December is still running on Dec 2");
  atClock(2027, 1, 2);
  ok(await file("2026-12"), 201);
  const offsetBefore = await accountBalance("VAT_PAYABLE");
  const reversed = ok(await call("POST", "/api/vat/returns/2026-12/unfile", { reason: "غلط في الأرقام" }));
  assert.equal(reversed.status, "open");
  assert.equal(r2(await accountBalance("VAT_PAYABLE")), r2(offsetBefore - 0), "no input VAT, so the offset was 0 and nothing moves");
  ok(await file("2026-12"), 201);
  const rows = await VatReturn.find({ period: "2026-12" }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(rows.map((row) => row.status), ["unfiled", "filed"]);
  assert.notEqual(rows[0].number, rows[1].number);
  await assertHealthy();
});

it("unfile reverses a real offset entry", async () => {
  atClock(2026, 10, 10);
  const s = await shop();
  const supplier = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  ok(await sale(s, "2026-10-12", design(s), { discountAmount: 20 }), 201);
  ok(await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: "2026-10-13", items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }] }), 201);
  atClock(2026, 11, 1);
  ok(await file("2026-10"), 201);
  assert.equal(await accountBalance("VAT_INPUT"), r2(140 - 30.7));
  ok(await call("POST", "/api/vat/returns/2026-10/unfile", { reason: "غلط" }));
  assert.equal(await accountBalance("VAT_INPUT"), 140, "the offset is reversed");
  assert.equal(await accountBalance("VAT_PAYABLE"), -30.7);
  await assertHealthy();
});

it("health vat can fail: a hand-made VAT entry and a deleted event are caught; netSales and COGS stay 0 with VAT on", async () => {
  const s = await shop();
  ok(await sale(s, new Date().toISOString().slice(0, 10), design(s), { discountAmount: 20 }), 201);
  const clean = await assertHealthy();
  assert.equal(clean.vat.payable.expected, 30.7); assert.equal(clean.netSales.difference, 0); assert.equal(clean.cogs.difference, 0);
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    const accounts = await accountMap(["VAT_PAYABLE", "CASH_MAIN"], session);
    await postEntry({ date: new Date(), source: { type: "manual_test", id: new mongoose.Types.ObjectId() }, session, lines: [line(accounts.get("CASH_MAIN"), 77, "debit"), line(accounts.get("VAT_PAYABLE"), 77, "credit")] });
  });
  await session.endSession();
  let report = ok(await call("GET", "/api/accounting/health"));
  assert.equal(report.vat.payable.difference, 77); assert.ok(report.vat.difference >= 77);
  await JournalEntry.deleteMany({ "source.type": "manual_test" });
  assert.equal(ok(await call("GET", "/api/accounting/health")).vat.difference, 0);
  await VatEvent.deleteMany({});
  report = ok(await call("GET", "/api/accounting/health"));
  assert.equal(report.vat.outputEvents.difference, -30.7); assert.ok(report.vat.difference > 0);
});

it("permissions: a cashier cannot file or pay (403); a manager and an accountant can; viewing needs vat.file or accounting.view", async () => {
  atClock(2026, 10, 10);
  const s = await shop();
  ok(await sale(s, "2026-10-12", design(s)), 201);
  for (const role of ["owner", "manager", "accountant"]) assert.ok(ROLE_TEMPLATES[role].includes("vat.file"), role);
  for (const role of ["cashier", "storekeeper"]) assert.equal(ROLE_TEMPLATES[role].includes("vat.file"), false, role);
  const cashier = await makeUser("s21-cashier", "cashier");
  const manager = await makeUser("s21-manager", "manager");
  token = cashier;
  assert.equal((await file("2026-10")).status, 403);
  assert.equal((await call("POST", "/api/vat/returns/2026-10/pay", { amount: 1 })).status, 403);
  assert.equal((await call("GET", "/api/vat/returns")).status, 403);
  token = manager;
  assert.equal((await call("GET", "/api/vat/returns")).status, 200);
  atClock(2026, 11, 1);
  ok(await file("2026-10"), 201);
});
