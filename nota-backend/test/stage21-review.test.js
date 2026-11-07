process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage21-review-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const CreditSale = require("../src/models/creditSale.model");
const Customer = require("../src/models/customer.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const ReturnLog = require("../src/models/returnLog.model");
const Selling = require("../src/models/selling.model");
const Supplier = require("../src/models/supplier.model");
const VatEvent = require("../src/models/vatEvent.model");
const VatReturn = require("../src/models/vatReturn.model");
const { runMigrations } = require("../src/migrations");
const { postEntry, accountMap, line } = require("../src/accounting/posting");
const { setClock } = require("../src/utils/clock");
const vat = require("../src/utils/vat");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

// Stage 21 review fixes: edits keep the line VAT flags, negative-output months (signed offset), price precision and the credit
// return backstop, stale VAT settings (409 TOTAL_CHANGED / VAT_CHANGED), filing only after the month ends, the Stage 20 purchase
// error order, health can-fails, the line-VAT rule and migration 9's account check.

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27143 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage21rv-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
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
async function product({ code, stock = 500, cost = 20, exempt = false } = {}) {
  const category = await Category.create({ name: `S21RV ${code}` });
  return ok(await call("POST", "/api/products", { name: code, code, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 100, ...(exempt ? { vatExempt: true } : {}) }), 201);
}
async function shop() {
  await startLedger();
  ok(await call("POST", "/api/accounting/opening", { cash: 50000 }));
  const a = await product({ code: "A35", cost: 20 }); const b = await product({ code: "B65", cost: 40 });
  const main = ok(await call("GET", "/api/cashbox/boxes")).data.find((box) => box.isMain);
  return { a, b, main };
}
const enableVat = async ({ includes = true, rate = 14 } = {}) => ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: true, rate, pricesIncludeVat: includes } }));
const dayOf = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const TODAY = dayOf();
const cashSale = async (items, extra = {}, status = 201) => ok(await call("POST", "/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: TODAY, items, ...extra }), status);
const creditSale = async (customer, items, extra = {}, status = 201) => ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items, ...extra }), status);
const ret = async (returnType, invoice, lines, extra = {}) => ok(await call("POST", "/api/returns", { returnType, invoiceId: invoice._id, items: lines.map(([p, q]) => ({ productId: p._id, quantity: q, returnReason: "x" })), ...extra }), 201);
const accountBalance = async (key) => {
  const account = await Account.findOne({ systemKey: key }).lean();
  const rows = await JournalEntry.aggregate([{ $unwind: "$lines" }, { $match: { "lines.accountId": account._id } }, { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]);
  return rows.length ? r2(rows[0].balance) : 0;
};
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
const handEntry = async (debitKey, creditKey, amount) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const accounts = await accountMap([debitKey, creditKey], session);
      await postEntry({ date: new Date(), source: { type: "manual_test", id: new mongoose.Types.ObjectId() }, session, lines: [line(accounts.get(debitKey), amount, "debit"), line(accounts.get(creditKey), amount, "credit")] });
    });
  } finally { await session.endSession(); }
};
const profitReportTotal = async () => r2((await call("GET", "/api/products/profit-report")).json.reduce((sum, row) => sum + Number(row.totalProfit || 0), 0));

// ============================================================ 1. an edit keeps the line VAT flags

for (const kind of ["cash", "credit"]) {
  it(`1. ${kind}: an item edit, then a no-op edit, keep each line's exempt flag and VAT; an exempt line returns 0 VAT; the profit report excludes VAT`, async () => {
    const s = await shop(); await enableVat({ includes: true });
    const exempt = await product({ code: "EXM", cost: 30, exempt: true });
    const customer = await Customer.create({ name: "عميل", phone: "01000000009" });
    const Model = kind === "cash" ? Selling : CreditSale;
    const path = kind === "cash" ? "/api/sellings" : "/api/credit-sales";
    const lines = (qa) => [{ productId: s.a._id, quantity: qa, price: 35 }, { productId: exempt._id, quantity: 2, price: 65 }];
    const create = (qa, extra) => (kind === "cash" ? cashSale(lines(qa), extra) : creditSale(customer, lines(qa), extra));
    const sale = await create(4, { discountAmount: 20 });
    const stored = async () => Model.findById(sale._id).lean();
    const check = async (label) => {
      const doc = await stored();
      assert.deepEqual(doc.items.map((row) => Boolean(row.vatExempt)), [false, true], `${label}: exempt flags`);
      assert.equal(doc.items[1].vatAmount, 0, `${label}: the exempt line carries no VAT`);
      assert.equal(r2(doc.items.reduce((sum, row) => sum + row.vatAmount, 0)), doc.vatAmount, `${label}: Σ line VAT = invoice VAT`);
      return doc;
    };
    await check("created");
    // an item edit (quantity of the taxable line changes)
    const edited = ok(await call("PUT", `${path}/${sale._id}`, { items: lines(3), discountAmount: 20 }));
    const afterItems = await check("after the item edit");
    assert.equal(afterItems.vatAmount, edited.vatAmount);
    assert.ok(afterItems.vatAmount > 0);
    // a no-op edit (same discount, no items): flags and VAT are untouched
    ok(await call("PUT", `${path}/${sale._id}`, { discountAmount: 20 }));
    const afterNoop = await check("after the no-op edit");
    assert.equal(afterNoop.vatAmount, afterItems.vatAmount); assert.equal(afterNoop.totalPrice, afterItems.totalPrice);
    // the profit report is net of VAT: net amount - cost (3 x 20 + 2 x 30)
    assert.equal(await profitReportTotal(), r2(afterNoop.netAmount - (3 * 20 + 2 * 30)));
    // returning the exempt line takes back no VAT
    const returned = await ret(kind, sale, [[exempt, 1]]);
    const log = kind === "cash" ? returned.data.returnLog : (await ReturnLog.findOne({ invoiceId: sale._id }).lean());
    assert.equal(log.vatAmount, 0, "an exempt line returns no VAT");
    assert.equal((await stored()).vatReturnedAmount, 0);
    await assertHealthy();
  });
}

// ============================================================ 2. negative-output months

async function negativeMonthScenario() {
  atClock(2026, 9, 1);
  const s = await shop(); await enableVat({ includes: true });
  atClock(2026, 9, 5);
  const sale = await cashSale([{ productId: s.a._id, quantity: 1, price: 114 }], { sellingDate: "2026-09-05" }, 201); // VAT 14 in September
  assert.equal(sale.vatAmount, 14);
  atClock(2026, 10, 5);
  await ret("cash", sale, [[s.a, 1]], { returnDate: "2026-10-05" }); // the full return in October: output -14
  atClock(2026, 11, 5);
  const second = ok(await call("POST", "/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: "2026-11-05", items: [{ productId: s.a._id, quantity: 2, price: 114 }] }), 201); // VAT 28
  assert.equal(second.vatAmount, 28);
  return s;
}
const file = (period) => call("POST", `/api/vat/returns/${period}/file`);

it("2. a month whose returns exceed its sales files a NEGATIVE offset (Dr 115 / Cr 22); after filing and paying all three months 22 = 0 and 115 = 0", async () => {
  const s = await negativeMonthScenario();
  atClock(2026, 12, 1);
  const september = ok(await call("GET", "/api/vat/returns/2026-09"));
  assert.equal(september.output, 14); assert.equal(september.offset, 0); assert.equal(september.payable, 14);
  const october = ok(await call("GET", "/api/vat/returns/2026-10"));
  assert.equal(october.output, -14); assert.equal(october.offset, -14, "signed, no clamp"); assert.equal(october.net, -14); assert.equal(october.credit, 14);
  assert.equal(october.preview.debit.code, "115"); assert.equal(october.preview.credit.code, "22"); assert.equal(october.preview.debit.amount, 14);

  ok(await file("2026-09"), 201);
  ok(await call("POST", "/api/vat/returns/2026-09/pay", { amount: 14, boxId: s.main._id }), 201);
  const filedOct = ok(await file("2026-10"), 201);
  assert.equal(filedOct.offset, -14); assert.equal(filedOct.credit, 14); assert.equal(filedOct.payable, 0);
  const [offsetEntry] = await entriesOf("vat_return", (await VatReturn.findOne({ period: "2026-10" }).lean())._id);
  assert.deepEqual(amounts(offsetEntry, ["VAT_PAYABLE", "VAT_INPUT"]), { VAT_INPUT: { debit: 14 }, VAT_PAYABLE: { credit: 14 } });
  assert.equal(await accountBalance("VAT_INPUT"), 14, "the credit sits on 115");
  assert.equal(await accountBalance("VAT_PAYABLE"), -28, "22 holds only the November sale (28): September is paid, October nets to zero");
  const filedNov = ok(await file("2026-11"), 201);
  assert.equal(filedNov.output, 28); assert.equal(filedNov.carriedIn, 14); assert.equal(filedNov.offset, 14); assert.equal(filedNov.payable, 14);
  ok(await call("POST", "/api/vat/returns/2026-11/pay", { amount: 14, boxId: s.main._id }), 201);
  assert.equal(await accountBalance("VAT_PAYABLE"), 0, "22 is back to zero");
  assert.equal(await accountBalance("VAT_INPUT"), 0, "115 is back to zero");
  const report = await assertHealthy();
  assert.equal(report.vat.offsets, 0); // 0 - 14 + 14
  assert.deepEqual(report.vat.filedReturns.byPeriod, []);
});

it("2b. can fail: with the old clamp (no offset entry for the negative month) 22 and 115 are NOT zero and health says so", async () => {
  const s = await negativeMonthScenario();
  atClock(2026, 12, 1);
  ok(await file("2026-09"), 201); ok(await call("POST", "/api/vat/returns/2026-09/pay", { amount: 14, boxId: s.main._id }), 201);
  ok(await file("2026-10"), 201); ok(await file("2026-11"), 201);
  ok(await call("POST", "/api/vat/returns/2026-11/pay", { amount: 14, boxId: s.main._id }), 201);
  await assertHealthy();
  // What the clamp did: October's offset was 0 and posted nothing.
  const october = await VatReturn.findOne({ period: "2026-10" }).lean();
  await JournalEntry.deleteMany({ "source.type": "vat_return", "source.id": october._id });
  await VatReturn.updateOne({ _id: october._id }, { $set: { offset: 0 } });
  assert.equal(await accountBalance("VAT_PAYABLE"), 14, "22 is no longer zero (the offset that put the returned VAT back is missing)");
  assert.equal(await accountBalance("VAT_INPUT"), -14, "and 115 is no longer zero");
  const report = ok(await call("GET", "/api/accounting/health"));
  assert.ok(report.vat.difference > 0, JSON.stringify(report.vat));
  assert.ok(report.vat.payable.difference !== 0 || report.vat.filedReturns.difference !== 0);
  assert.equal(report.vat.filedReturns.byPeriod.find((row) => row.period === "2026-10").offset, 14, "the stored offset no longer follows min(output, input + carriedIn)");
});

// ============================================================ 3. price precision and the credit-return backstop

it("3. unit prices accept at most 2 decimals: 400 PRICE_PRECISION on sale/credit/purchase/product create and edit; a stored legacy price is not blocked on a quantity edit", async () => {
  const s = await shop();
  const customer = await Customer.create({ name: "عميل", phone: "01000000008" });
  const bad = { productId: s.a._id, quantity: 1, price: 10.005 };
  for (const [path, body] of [
    ["/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: TODAY, items: [bad] }],
    ["/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: [bad] }],
  ]) {
    const response = await call("POST", path, body);
    assert.equal(response.status, 400, path); assert.equal(response.json.code, "PRICE_PRECISION", path);
  }
  const sale = await cashSale([{ productId: s.a._id, quantity: 2, price: 35 }]);
  const edit = await call("PUT", `/api/sellings/${sale._id}`, { items: [{ productId: s.a._id, quantity: 2, price: 35.123 }] });
  assert.equal(edit.status, 400); assert.equal(edit.json.code, "PRICE_PRECISION");
  const credit = await creditSale(customer, [{ productId: s.a._id, quantity: 2, price: 35 }]);
  const creditEdit = await call("PUT", `/api/credit-sales/${credit._id}`, { price: 35.123 });
  assert.equal(creditEdit.status, 400); assert.equal(creditEdit.json.code, "PRICE_PRECISION");
  const supplier = await Supplier.create({ name: "مورد" });
  const purchase = await call("POST", "/api/purchases", { supplierId: String(supplier._id), items: [{ productId: s.a._id, qty: 1, unitPrice: 10.005 }] });
  assert.equal(purchase.status, 400); assert.equal(purchase.json.code, "PRICE_PRECISION");
  const category = await Category.create({ name: "S21RV prices" });
  const created = await call("POST", "/api/products", { name: "P3", code: "P3", categoryId: String(category._id), inventoryCount: 1, purchasePrice: 10, wholesalePrice: 12.345, retailPrice: 20 });
  assert.equal(created.status, 400); assert.equal(created.json.code, "PRICE_PRECISION");
  const updated = await call("PUT", `/api/products/${s.a._id}`, { retailPrice: 150.555 });
  assert.equal(updated.status, 400); assert.equal(updated.json.code, "PRICE_PRECISION");
  ok(await call("PUT", `/api/products/${s.a._id}`, { retailPrice: 150.5 }));
  // A legacy invoice with a 3-decimal price: editing only the quantity keeps the stored price.
  await Selling.updateOne({ _id: sale._id }, { $set: { "items.0.unitPrice": 35.005 } });
  ok(await call("PUT", `/api/sellings/${sale._id}`, { quantity: 3 }));
  assert.equal((await Selling.findById(sale._id).lean()).items[0].unitPrice, 35.005);
});

// A legacy 3-decimal invoice: the stored figures as they were before this rule existed.
async function legacyCredit(Model, id, { unitPrice, quantity }) {
  const doc = await Model.findById(id).lean();
  const total = r2(unitPrice * quantity);
  const fields = { "items.0.unitPrice": unitPrice, "items.0.totalPrice": total, "items.0.profitAmount": r2(total - doc.items[0].purchasePrice * quantity), totalPrice: total, remainingAmount: total };
  if (doc.vatRate !== undefined && doc.vatRate !== null) {
    const computed = vat.computeSaleVat({ items: [{ totalPrice: total }], discountAmount: 0, shippingFees: 0, rate: doc.vatRate, included: doc.vatIncluded });
    Object.assign(fields, { vatAmount: computed.vatAmount, netAmount: computed.netAmount, taxableAmount: computed.taxableAmount, shippingVat: 0, "items.0.vatAmount": computed.itemVat[0], vatBreakdown: computed.breakdown });
  }
  await Model.updateOne({ _id: id }, { $set: fields });
  return total;
}

for (const vatOn of [false, true]) {
  it(`3b. credit return backstop (VAT ${vatOn ? "on" : "off"}): returns of a legacy 3-decimal price never unbalance the entry and add up to the invoice total`, async () => {
    const s = await shop(); if (vatOn) await enableVat({ includes: true });
    const customer = await Customer.create({ name: "عميل", phone: "01000000007" });
    const invoice = await creditSale(customer, [{ productId: s.a._id, quantity: 3, price: 3.33 }]);
    const total = await legacyCredit(CreditSale, invoice._id, { unitPrice: 3.335, quantity: 3 }); // 10.005 -> 10.01 (or 10.00)
    let refunded = 0;
    for (let i = 0; i < 3; i += 1) {
      const response = await call("POST", "/api/returns", { returnType: "credit", invoiceId: invoice._id, items: [{ productId: s.a._id, quantity: 1, returnReason: "x" }] });
      assert.equal(response.status, 201, `return ${i + 1}: ${JSON.stringify(response.json)}`);
    }
    const doc = await CreditSale.findById(invoice._id).lean();
    refunded = doc.refundedAmount;
    assert.equal(refunded, total, "the returns add up to the invoice total");
    const logs = await ReturnLog.find({ invoiceId: invoice._id }).sort({ createdAt: 1 }).lean();
    assert.equal(r2(logs.reduce((sum, row) => sum + row.subtotalReturnedAmount, 0)), total, "the returned subtotals telescope to the line total");
    for (const log of logs) {
      const entries = await entriesOf("return", log._id);
      assert.equal(entries.length, 1);
      const debit = r2(entries[0].lines.reduce((sum, row) => sum + row.debit, 0)); const credit = r2(entries[0].lines.reduce((sum, row) => sum + row.credit, 0));
      assert.equal(debit, credit, "every return entry balances");
    }
    if (vatOn) assert.equal(r2(logs.reduce((sum, row) => sum + row.vatAmount, 0)), doc.vatAmount, "Σ returned VAT = the invoice VAT");
  });
}

it("3c. the returned line value is round(u x before) - round(u x after) (pure rule, a 3-decimal price)", () => {
  // u = 3.335, q = 3: line total round(10.005); one at a time 10.005 - 6.67 + 6.67 - 3.335 + 3.335 - 0
  const round = (value) => Math.round(value * 100) / 100;
  const u = 3.335; const total = round(u * 3);
  const parts = [3, 2, 1].map((before) => round(round(u * before) - round(u * (before - 1))));
  assert.equal(r2(parts.reduce((sum, value) => sum + value, 0)), total);
});

// ============================================================ 4. stale VAT settings

it("4. expectedTotal: a stale screen gets 409 TOTAL_CHANGED with the current vat block and nothing is saved; confirming with the new total saves; no field = unchanged", async () => {
  const s = await shop(); await enableVat({ includes: false });
  const customer = await Customer.create({ name: "عميل", phone: "01000000006" });
  const lines = [{ productId: s.a._id, quantity: 4, price: 35 }, { productId: s.b._id, quantity: 2, price: 65 }];
  const stockBefore = (await Product.findById(s.a._id).lean()).inventoryCount;
  const stale = await call("POST", "/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: TODAY, items: lines, discountAmount: 20, expectedTotal: 250 });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, "TOTAL_CHANGED");
  assert.equal(stale.json.expected, 250); assert.equal(stale.json.current, 285);
  assert.deepEqual(stale.json.vat, { enabled: true, rate: 14, pricesIncludeVat: false, startDate: stale.json.vat.startDate });
  assert.equal(await Selling.countDocuments({}), 0, "nothing was saved");
  assert.equal((await Product.findById(s.a._id).lean()).inventoryCount, stockBefore, "the stock was not touched");
  const confirmed = ok(await call("POST", "/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: TODAY, items: lines, discountAmount: 20, expectedTotal: 285 }), 201);
  assert.equal(confirmed.totalPrice, 285);
  const absent = await cashSale(lines, { discountAmount: 20 });
  assert.equal(absent.totalPrice, 285, "no expectedTotal: nothing changes");
  // credit
  const staleCredit = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: lines, discountAmount: 20, expectedTotal: 250 });
  assert.equal(staleCredit.status, 409); assert.equal(staleCredit.json.code, "TOTAL_CHANGED"); assert.equal(staleCredit.json.current, 285);
  assert.equal(await CreditSale.countDocuments({}), 0);
  assert.equal((await creditSale(customer, lines, { discountAmount: 20, expectedTotal: 285 })).totalPrice, 285);
  // VAT off on the server, a screen that still adds VAT: the other direction
  await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: false } });
  const staleOff = await call("POST", "/api/sellings", { customerName: "c", customerPhone: "010", sellingDate: TODAY, items: lines, discountAmount: 20, expectedTotal: 285 });
  assert.equal(staleOff.status, 409); assert.equal(staleOff.json.current, 250); assert.equal(staleOff.json.vat.enabled, false);
  // prices including VAT: the total is the same either way, so a stale screen is not interrupted
  await enableVat({ includes: true });
  assert.equal((await cashSale(lines, { discountAmount: 20, expectedTotal: 250 })).totalPrice, 250);
});

it("4b. expectedVat on a purchase: a stale form gets 409 VAT_CHANGED with the vat block and nothing is saved; matching or absent saves", async () => {
  const s = await shop();
  const supplier = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  const body = (extra = {}) => ({ supplierId: String(supplier._id), items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }], ...extra });
  const stockBefore = (await Product.findById(s.a._id).lean()).inventoryCount;
  await enableVat({ includes: true }); // the owner turned VAT on on another PC
  const stale = await call("POST", "/api/purchases", body({ expectedVat: 0 }));
  assert.equal(stale.status, 409); assert.equal(stale.json.code, "VAT_CHANGED");
  assert.equal(stale.json.expected, 0); assert.equal(stale.json.current, 140); assert.equal(stale.json.vat.enabled, true); assert.equal(stale.json.vat.rate, 14);
  assert.equal(await require("../src/models/purchase.model").countDocuments({}), 0);
  assert.equal((await Product.findById(s.a._id).lean()).inventoryCount, stockBefore);
  assert.equal(ok(await call("POST", "/api/purchases", body({ expectedVat: 140 })), 201).vatAmount, 140);
  assert.equal(ok(await call("POST", "/api/purchases", body()), 201).vatAmount, 140, "no expectedVat: unchanged");
  await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: false } });
  const staleOn = await call("POST", "/api/purchases", body({ expectedVat: 140, vatRegistered: true, vatAmount: 140 }));
  assert.equal(staleOn.status, 409); assert.equal(staleOn.json.code, "VAT_CHANGED"); assert.equal(staleOn.json.current, 0);
});

// ============================================================ 5. a month can be filed only after it ends

it("5. PERIOD_NOT_ENDED: the current month cannot be filed, the previous one can (local clock); canFile follows", async () => {
  atClock(2026, 10, 10);
  const s = await shop(); await enableVat({ includes: true });
  await cashSale([{ productId: s.a._id, quantity: 1, price: 114 }], { sellingDate: "2026-10-12" });
  const current = ok(await call("GET", "/api/vat/returns/2026-10"));
  assert.equal(current.canFile, false);
  const refused = await file("2026-10");
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "PERIOD_NOT_ENDED");
  atClock(2026, 10, 31); // the last day of October: still running
  assert.equal((await file("2026-10")).json.code, "PERIOD_NOT_ENDED");
  atClock(2026, 11, 1);
  assert.equal(ok(await call("GET", "/api/vat/returns/2026-10")).canFile, true);
  ok(await file("2026-10"), 201);
  assert.equal((await file("2026-11")).json.code, "PERIOD_NOT_ENDED");
});

// ============================================================ 6. the Stage 20 error order of a purchase

it("6. PAID_EXCEEDS_TOTAL is checked up front when no VAT can apply (before the supplier lookup), exactly as in Stage 20; with VAT the gross total is the limit", async () => {
  const s = await shop();
  const missing = new mongoose.Types.ObjectId();
  const over = await call("POST", "/api/purchases", { supplierId: String(missing), items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }], paidAmount: 1500 });
  assert.equal(over.status, 400); assert.equal(over.json.code, "PAID_EXCEEDS_TOTAL", "not SUPPLIER_NOT_FOUND: the Stage 20 order");
  assert.equal((await call("POST", "/api/purchases", { supplierId: String(missing), items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }], paidAmount: 500 })).json.code, "SUPPLIER_NOT_FOUND");
  await enableVat({ includes: true });
  const supplier = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  const body = (paidAmount) => ({ supplierId: String(supplier._id), items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }], paidAmount });
  assert.equal(ok(await call("POST", "/api/purchases", body(1140)), 201).paidAmount, 1140, "VAT on: paying the gross total is allowed");
  assert.equal((await call("POST", "/api/purchases", body(1141))).json.code, "PAID_EXCEEDS_TOTAL");
});

// ============================================================ 7. health can-fails

it("7. health can fail on the input side, on VAT leaking into net sales, and on a filed return that no longer equals its events", async () => {
  atClock(2026, 10, 10);
  const s = await shop(); await enableVat({ includes: true });
  const supplier = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  await cashSale([{ productId: s.a._id, quantity: 1, price: 114 }], { sellingDate: "2026-10-12" });
  ok(await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: "2026-10-13", items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }] }), 201);
  const clean = await assertHealthy();
  assert.equal(clean.vat.input.expected, 140); assert.equal(clean.netSales.difference, 0);
  // input side: a hand-made entry on 115
  await handEntry("VAT_INPUT", "CASH_MAIN", 33);
  let report = ok(await call("GET", "/api/accounting/health"));
  assert.equal(report.vat.input.difference, 33); assert.ok(report.vat.difference >= 33);
  await JournalEntry.deleteMany({ "source.type": "manual_test" });
  assert.equal(ok(await call("GET", "/api/accounting/health")).vat.difference, 0);
  // VAT leaking into net sales: the sale's VAT (14) credited to SALES as if it were revenue
  await handEntry("CASH_MAIN", "SALES", 14);
  report = ok(await call("GET", "/api/accounting/health"));
  assert.equal(report.netSales.difference, 14, "net sales exclude VAT, so a VAT-sized leak shows");
  await JournalEntry.deleteMany({ "source.type": "manual_test" });
  assert.equal(ok(await call("GET", "/api/accounting/health")).netSales.difference, 0);
  // a filed period: Σ events = its stored figures
  atClock(2026, 11, 1);
  ok(await file("2026-10"), 201);
  assert.equal((await assertHealthy()).vat.filedReturns.difference, 0);
  await VatEvent.create({ kind: "sale", direction: "output", sourceType: "sale", sourceId: new mongoose.Types.ObjectId(), number: "X", date: new Date(Date.UTC(2026, 9, 20)), period: "2026-10", net: 10, vat: 5 });
  report = ok(await call("GET", "/api/accounting/health"));
  assert.equal(report.vat.filedReturns.byPeriod[0].period, "2026-10"); assert.equal(report.vat.filedReturns.byPeriod[0].output, -5);
  assert.ok(report.vat.filedReturns.difference >= 5 && report.vat.difference >= 5);
});

// ============================================================ 8. a line VAT is never negative

it("8. a line VAT is never negative and the lines add up to the invoice VAT (fuzz with tiny and uneven lines)", () => {
  let seed = 12345; const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let run = 0; run < 400; run += 1) {
    const count = 1 + Math.floor(next() * 12);
    const items = Array.from({ length: count }, () => ({ totalPrice: Math.round(next() * (next() < 0.5 ? 0.5 : 300) * 100) / 100, vatExempt: next() < 0.2 }));
    const subtotal = items.reduce((sum, row) => sum + row.totalPrice, 0);
    const discountAmount = Math.round(next() * subtotal * 0.9 * 100) / 100;
    const shippingFees = next() < 0.4 ? Math.round(next() * 20 * 100) / 100 : 0;
    for (const included of [true, false]) {
      const result = vat.computeSaleVat({ items, discountAmount, shippingFees, rate: 14, included });
      assert.ok(result.itemVat.every((value) => value >= 0), `negative line VAT in run ${run}: ${JSON.stringify(result.itemVat)}`);
      assert.ok(result.shippingVat >= 0);
      assert.equal(r2(result.itemVat.reduce((sum, value) => sum + value, 0) + result.shippingVat), result.vatAmount, `lines add up in run ${run}`);
    }
  }
  // the remainder goes to the LARGEST taxable line, not the last one
  const uneven = vat.computeSaleVat({ items: [{ totalPrice: 100 }, { totalPrice: 0.03 }], discountAmount: 0, shippingFees: 0, rate: 14, included: true });
  assert.equal(r2(uneven.itemVat[0] + uneven.itemVat[1]), uneven.vatAmount); assert.ok(uneven.itemVat[1] >= 0);
});

// ============================================================ 9. migration 9 verifies account 115

it("9. migration 9 stops with a clear error when account 115 already exists and is not the VAT input account", async () => {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 8 });
  await Account.create({ code: "115", nameAr: "حساب العميل الخاص", nameEn: "Custom 115", type: "asset", normalSide: "debit" });
  await assert.rejects(() => runMigrations(), /account code 115 already exists/);
  assert.equal((await Meta.findById("schema").lean()).version, 8, "the schema version did not move");
  await Account.deleteMany({});
  assert.equal(await runMigrations(), 9);
  assert.equal((await Account.findOne({ code: "115" }).lean()).systemKey, "VAT_INPUT");
});
