process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage17-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const { forgetBoxes } = require("./helpers/oldData");
const test = require("node:test");
const mongoose = require("mongoose");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Product = require("../src/models/product.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const CreditSale = require("../src/models/creditSale.model");
const ReturnLog = require("../src/models/returnLog.model");
const Meta = require("../src/models/meta.model");
const { runMigrations } = require("../src/migrations");
const { importCategories } = require("../src/services/categoryImportExport.service");
const { createCategoryWorkbook } = require("../src/helpers/categoryWorkbook.helper");
const Selling = require("../src/models/selling.model");
const { seedAccounts, postEntry, accountMap, line, reverseEntry } = require("../src/accounting/posting");
const { ROLE_TEMPLATES, missingDependencies } = require("../src/auth/permissions");
const { withTransaction } = require("../src/utils/transaction");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");
const { runLedgerRepro } = require("./helpers/ledgerRepro");

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27117 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null;
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage17-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);
async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); return { status: response.status, json: text ? JSON.parse(text) : null };
}
async function product({ code, stock = 20, cost = 20, retail = 100 } = {}) {
  const category = await Category.create({ name: `Stage17 ${code || Math.random()}` });
  const response = await call("POST", "/api/products", { name: code || "Product", code: code || `P-${Math.random()}`, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: Math.max(cost, retail), retailPrice: retail });
  assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json;
}
const saleBody = (items, extra = {}) => ({ customerName: "Cash customer", customerPhone: "01017171717", sellingDate: "2026-11-05", items, ...extra });
async function keyedLines(entry) {
  const accounts = await Account.find({ _id: { $in: entry.lines.map((row) => row.accountId) } }).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey]));
  return entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit, party: row.partyType || null }));
}
const entryFor = (type, id) => JournalEntry.findOne({ "source.type": type, "source.id": id, type: "auto" }).lean();
async function beginLedgerOnCurrentState() { await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ['JE','OB'] } }); await Meta.deleteMany({}); await Meta.create({ _id:'schema', version:4 }); await runMigrations(); }
async function assertHealthy() { const response=await call('GET','/api/accounting/health'); assert.equal(response.status,200); for(const [name,check] of Object.entries(response.json)) assert.equal(check.difference,0,`${name}: ${JSON.stringify(check)}`); }
async function assertCustomerMatchesStatement(customerId) {
  const customers = await Account.findOne({ systemKey: "CUSTOMERS" }).lean();
  const statement = await call("GET", `/api/customers/${customerId}/statement`); assert.equal(statement.status, 200);
  const ledger = await call("GET", `/api/accounting/accounts/${customers._id}/ledger?partyId=${customerId}`); assert.equal(ledger.status, 200);
  assert.equal(ledger.json.balance, statement.json.totals.balance, `customer ${customerId}: ledger ${ledger.json.balance} vs statement ${statement.json.totals.balance}`);
}

it("cash sale posts exact lines for 4x35 + 2x65, discount 20 = 250", async () => {
  const a = await product({ code: "CASH-A", cost: 10, retail: 35 }); const b = await product({ code: "CASH-B", cost: 20, retail: 65 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: a._id, quantity: 4, price: 35 }, { productId: b._id, quantity: 2, price: 65 }], { discountAmount: 20 }));
  assert.equal(sale.status, 201); assert.equal(sale.json.totalPrice, 250);
  assert.deepEqual(await keyedLines(await entryFor("sale", sale.json._id)), [
    { key: "CASH_MAIN", debit: 250, credit: 0, party: null }, { key: "SALES", debit: 0, credit: 270, party: null },
    { key: "SALES_DISCOUNT", debit: 20, credit: 0, party: null }, { key: "COGS", debit: 80, credit: 0, party: null }, { key: "INVENTORY", debit: 0, credit: 80, party: null },
  ]);
});

it("cash sale shipping variant credits SHIPPING_INCOME 15", async () => {
  const p = await product({ code: "SHIP", cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 100 }], { shippingFees: 15 }));
  const lines = await keyedLines(await entryFor("sale", sale.json._id));
  assert.ok(lines.some((row) => row.key === "CASH_MAIN" && row.debit === 115));
  assert.ok(lines.some((row) => row.key === "SHIPPING_INCOME" && row.credit === 15));
});

it("credit 790 with down payment 200 posts separate CR and RC entries", async () => {
  const p = await product({ code: "CREDIT", cost: 100, retail: 790 });
  const credit = await call("POST", "/api/credit-sales", saleBody([{ productId: p._id, quantity: 1, price: 790 }], { initialPaidAmount: 200, initialPaymentDate: "2026-11-05" }));
  assert.equal(credit.status, 201);
  const saleLines = await keyedLines(await entryFor("credit_sale", credit.json._id));
  assert.ok(saleLines.some((row) => row.key === "CUSTOMERS" && row.debit === 790 && row.party === "customer"));
  const receipt = await JournalEntry.findOne({ "source.type": "receipt" }).lean(); const receiptLines = await keyedLines(receipt);
  assert.deepEqual(receiptLines.map(({ key, debit, credit }) => ({ key, debit, credit })), [{ key: "CASH_MAIN", debit: 200, credit: 0 }, { key: "CUSTOMERS", debit: 0, credit: 200 }]);
});

it("return uses original COGS 20, current inventory 25 and adjustment 5; health stays zero", async () => {
  const p = await product({ code: "RETURN-COST", stock: 5, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }]));
  const updated = await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 }); assert.equal(updated.status, 200);
  const returned = await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 1 }], returnDate: "2026-11-06" });
  assert.equal(returned.status, 201, JSON.stringify(returned.json));
  const entry = await JournalEntry.findOne({ "source.type": "return" }).lean(); const lines = await keyedLines(entry);
  assert.ok(lines.some((row) => row.key === "COGS" && row.credit === 20));
  assert.ok(lines.some((row) => row.key === "INVENTORY" && row.debit === 25));
  assert.ok(lines.some((row) => row.key === "INVENTORY_ADJUSTMENT" && row.credit === 5));
  const health = await call("GET", "/api/accounting/health"); assert.equal(health.status, 200); for (const check of Object.values(health.json)) assert.equal(check.difference, 0, JSON.stringify(health.json));
});

it("item 14: item or price edits on an invoice with returns are refused exactly as before Stage 17 (cash and credit)", async () => {
  const p = await product({ code: "EDIT-RETURN", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 1 }] });
  const customer = await Customer.create({ name: "Guarded", phone: "01017170041" });
  const credit = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 3, price: 100 }] });
  await call("POST", "/api/returns", { returnType: "credit", invoiceId: credit.json._id, items: [{ itemId: credit.json.items[0]._id, quantity: 1 }] });
  const entriesBefore = await JournalEntry.countDocuments(); const stockBefore = (await Product.findById(p._id)).inventoryCount;
  for (const body of [{ items: [{ productId: p._id, quantity: 4, price: 100 }] }, { discountAmount: 5 }, { shippingFees: 10 }]) {
    const cash = await call("PUT", `/api/sellings/${sale.json._id}`, body);
    assert.equal(cash.status, 400); assert.equal(cash.json.message, "لا يمكن تعديل عناصر أو تسعير فاتورة تحتوي على مرتجعات");
    const creditEdit = await call("PUT", `/api/credit-sales/${credit.json._id}`, body);
    assert.equal(creditEdit.status, 400); assert.equal(creditEdit.json.message, "لا يمكن تعديل عناصر أو تسعير فاتورة تحتوي على مرتجعات. استخدم مسار المرتجع أو أنشئ فاتورة جديدة");
  }
  assert.equal(await JournalEntry.countDocuments(), entriesBefore); assert.equal((await Product.findById(p._id)).inventoryCount, stockBefore);
  assert.equal((await call("PUT", `/api/sellings/${sale.json._id}`, { customerName: "Renamed only" })).status, 200, "non-pricing edits still allowed");
  assert.equal((await call("PUT", `/api/credit-sales/${credit.json._id}`, { notes: "note only" })).status, 200);
  await assertHealthy();
});

it("ledger computes opening balance before from and respects party filter", async () => {
  let account; const party = new mongoose.Types.ObjectId();
  await withTransaction(async (session) => {
    await seedAccounts(session); const accounts = await accountMap(["CUSTOMERS", "CAPITAL"], session); account = accounts.get("CUSTOMERS");
    await postEntry({ date: new Date("2026-01-01"), source: { type: "fixture", id: new mongoose.Types.ObjectId(), number: "F-1" }, session, lines: [line(account, 90, "debit", { partyType: "customer", partyId: party, partyName: "Party" }), line(accounts.get("CAPITAL"), 90, "credit")] });
    await postEntry({ date: new Date("2026-02-01"), source: { type: "fixture", id: new mongoose.Types.ObjectId(), number: "F-2" }, session, lines: [line(account, 20, "credit", { partyType: "customer", partyId: party, partyName: "Party" }), line(accounts.get("CAPITAL"), 20, "debit")] });
  });
  const ledger = await call("GET", `/api/accounting/accounts/${account._id}/ledger?from=2026-02-01&partyId=${party}`);
  assert.equal(ledger.json.openingBalance, 90); assert.equal(ledger.json.lines[0].balance, 70); assert.equal(ledger.json.balance, 70);
});

it("postEntry rejects unbalanced, group, inactive, missing customer party and party on non-party account", async () => {
  await withTransaction(async (session) => { await seedAccounts(session); });
  const accounts = Object.fromEntries((await Account.find({ systemKey: { $in: ["CASH_MAIN", "CUSTOMERS", "CAPITAL"] } }).lean()).map((a) => [a.systemKey, a]));
  const attempt = (lines) => withTransaction((session) => postEntry({ date: new Date(), source: { type: "validation", id: new mongoose.Types.ObjectId() }, lines, session }));
  await assert.rejects(attempt([line(accounts.CASH_MAIN, 2, "debit"), line(accounts.CAPITAL, 1, "credit")]), /Unbalanced/);
  const group = await Account.findOne({ code: "1" }).lean(); await assert.rejects(attempt([line(group, 1, "debit"), line(accounts.CAPITAL, 1, "credit")]), /group/);
  await Account.updateOne({ _id: accounts.CASH_MAIN._id }, { isActive: false }); await assert.rejects(attempt([line(accounts.CASH_MAIN, 1, "debit"), line(accounts.CAPITAL, 1, "credit")]), /inactive/); await Account.updateOne({ _id: accounts.CASH_MAIN._id }, { isActive: true });
  await assert.rejects(attempt([line(accounts.CUSTOMERS, 1, "debit"), line(accounts.CAPITAL, 1, "credit")]), /party/);
  await assert.rejects(attempt([line(accounts.CASH_MAIN, 1, "debit", { partyType: "customer", partyId: new mongoose.Types.ObjectId() }), line(accounts.CAPITAL, 1, "credit")]), /Party/);
});

it("accounts and journal indexes exist and aggregation handles 5,000 entries", async () => {
  await withTransaction(async (session) => { await seedAccounts(session); });
  const accounts = await Account.find({ systemKey: { $in: ["CASH_MAIN", "CAPITAL"] } }).lean(); const cash = accounts.find((a) => a.systemKey === "CASH_MAIN"); const capital = accounts.find((a) => a.systemKey === "CAPITAL");
  const rows = Array.from({ length: 5000 }, (_, index) => ({ number: `JE-P-${index}`, date: new Date("2026-01-01"), type: "auto", source: { type: "perf", id: new mongoose.Types.ObjectId(), number: `P-${index}` }, lines: [line(cash, 1, "debit"), line(capital, 1, "credit")], totalDebit: 1, totalCredit: 1 }));
  await JournalEntry.insertMany(rows);
  const accountsResult = await call("GET", "/api/accounting/accounts?asOf=2026-12-31"); assert.equal(accountsResult.status, 200);
  const health = await call("GET", "/api/accounting/health"); assert.equal(health.status, 200);
  const journalIndexes = await JournalEntry.collection.indexes(); const accountIndexes = await Account.collection.indexes();
  assert.ok(journalIndexes.some((index) => index.key["source.type"] === 1 && index.key["source.id"] === 1)); assert.ok(accountIndexes.some((index) => index.unique && index.key.code === 1));
});

it("a posting refused for an inactive account (409 ACCOUNT_INACTIVE, never 500) rolls back document, stock, INV and JE counters", async () => {
  const p = await product({ code: "ROLLBACK", stock: 2, cost: 20, retail: 100 });
  await Account.updateOne({ systemKey: "SALES" }, { isActive: false });
  const failed = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 100 }])); assert.equal(failed.status, 409); assert.equal(failed.json.code, "ACCOUNT_INACTIVE");
  assert.equal((await Product.findById(p._id)).inventoryCount, 2); assert.equal(await Counter.countDocuments({ _id: "INV" }), 0); assert.equal(await Counter.countDocuments({ _id: "JE" }), 1, "only product-create JE remains");
});

it("one customer receipt allocated across two invoices posts one RC entry", async () => {
  const p = await product({ code: "ALLOC", stock: 5, cost: 20, retail: 100 }); const customer = await Customer.create({ name: "Allocated", phone: "01017170001" });
  for (let index = 0; index < 2; index += 1) { const created = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", dueDate: "2026-12-05", items: [{ productId: p._id, quantity: 1, price: 100 }] }); assert.equal(created.status, 201); }
  const paid = await call("POST", `/api/customers/${customer._id}/payments`, { amount: 150, paymentDate: "2026-11-06", lastInvoice: true }); assert.equal(paid.status, 201, JSON.stringify(paid.json));
  const receipts = await JournalEntry.find({ "source.type": "receipt" }).lean(); assert.equal(receipts.length, 1); const lines = await keyedLines(receipts[0]); assert.ok(lines.some(row => row.key === "CASH_MAIN" && row.debit === 150)); assert.ok(lines.some(row => row.key === "CUSTOMERS" && row.credit === 150));
});

it("partial and final cash returns post stored discount and shipping shares", async () => {
  const p = await product({ code: "RETURN-SHARES", stock: 4, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }], { discountAmount: 20, shippingFees: 10 }));
  assert.equal(sale.json.totalPrice, 190);
  for (let index = 0; index < 2; index += 1) {
    const returned = await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 1 }] });
    assert.equal(returned.status, 201, JSON.stringify(returned.json));
    const log = await ReturnLog.findById(returned.json.data.returnLog._id).lean();
    const expectedDiscount = index === 0 ? 0 : 10; const expectedFinal = index === 0 ? 100 : 90;
    assert.equal(log.subtotalReturnedAmount, 100); assert.equal(log.discountAmount, expectedDiscount); assert.equal(log.shippingFees, 0); assert.equal(log.finalReturnedAmount, expectedFinal);
    const lines = await keyedLines(await entryFor("return", log._id));
    assert.ok(lines.some((row) => row.key === "SALES_RETURNS" && row.debit === 100)); assert.ok(lines.some((row) => row.key === "CASH_MAIN" && row.credit === expectedFinal));
    assert.equal(lines.some((row) => row.key === "SALES_DISCOUNT" && row.credit === 10), index === 1);
  }
  const shippingSale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }], { discountAmount: 10, shippingFees: 20 }));
  await call("POST", "/api/returns", { returnType: "cash", invoiceId: shippingSale.json._id, items: [{ itemId: shippingSale.json.items[0]._id, quantity: 1 }] });
  const shippingReturn = await call("POST", "/api/returns", { returnType: "cash", invoiceId: shippingSale.json._id, items: [{ itemId: shippingSale.json.items[0]._id, quantity: 1 }] });
  const shippingLog = await ReturnLog.findById(shippingReturn.json.data.returnLog._id).lean(); assert.equal(shippingLog.shippingFees, 10); assert.equal(shippingLog.finalReturnedAmount, 110);
  const shippingLines = await keyedLines(await entryFor("return", shippingLog._id)); assert.ok(shippingLines.some((row) => row.key === "SHIPPING_INCOME" && row.debit === 10)); assert.ok(shippingLines.some((row) => row.key === "CASH_MAIN" && row.credit === 110));
  await assertHealthy();
});

it("item 15: credit return keeps the pre-Stage-17 refundDue/status (leftover → returnedPaidAmount) and reallocates without a JE", async () => {
  const p = await product({ code: "RETURN-CREDIT", stock: 6, cost: 20, retail: 100 }); const customer = await Customer.create({ name: "Return credit", phone: "01017170031" });
  const source = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 2, price: 100 }] });
  const target = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 20 }] });
  await call("POST", `/api/credit-sales/${source.json._id}/payments`, { amount: 150 });
  const before = await JournalEntry.countDocuments({ "source.type": "receipt" });
  const returned = await call("POST", "/api/returns", { returnType: "credit", invoiceId: source.json._id, items: [{ itemId: source.json.items[0]._id, quantity: 1 }] });
  assert.equal(returned.status, 201, JSON.stringify(returned.json));
  // Values produced by commit e042f5f8 (pre-Stage-17) for this exact scenario.
  assert.equal(returned.json.reallocatedPaidAmount, 20); assert.equal(returned.json.refundDueAmount, 0);
  assert.equal(returned.json.returnedPaidAmount, 30); assert.equal(returned.json.status, "paid"); assert.equal(returned.json.paidAmount, 100);
  const stored = await CreditSale.findById(source.json._id).lean();
  assert.deepEqual({ status: stored.status, refundDueAmount: stored.refundDueAmount, returnedPaidAmount: stored.returnedPaidAmount, reallocatedPaidAmount: stored.reallocatedPaidAmount }, { status: "paid", refundDueAmount: 0, returnedPaidAmount: 30, reallocatedPaidAmount: 20 });
  await assertCustomerMatchesStatement(customer._id);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "receipt" }), before, "return reallocation creates no receipt JE");
  const targetDoc = await CreditSale.findById(target.json._id).lean(); assert.equal(targetDoc.remainingAmount, 0); assert.equal(targetDoc.payments.at(-1).source, "return_reallocation");
  const customerAccount = await Account.findOne({ systemKey: "CUSTOMERS" }); const returnEntry = await JournalEntry.findOne({ "source.type": "return", "source.id": (await ReturnLog.findOne({ invoiceId: source.json._id }))._id }).lean();
  const partyLine = returnEntry.lines.find((row) => String(row.accountId) === String(customerAccount._id)); assert.equal(partyLine.credit, 100);
  await assertHealthy();
});

it("cash cancel after partial return credits only cancelRefundAmount and restores only not-returned stock", async () => {
  const p = await product({ code: "CANCEL-CASH", stock: 10, cost: 20, retail: 100 }); const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 1 }] });
  const cancelled = await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "customer cancelled" }); assert.equal(cancelled.status, 200); assert.equal(cancelled.json.cancelRefundAmount, 200); assert.equal((await Product.findById(p._id)).inventoryCount, 10);
  const related = await JournalEntry.find({ "source.id": sale.json._id }).lean(); const cancellationReversals = await JournalEntry.find({ type:'reversal', createdAt:{ $gte:new Date(cancelled.json.cancelledAt || 0) } }).lean(); const cashNet = cancellationReversals.flatMap(e => e.lines).filter(l => l.accountCode === "1111").reduce((sum,l)=>sum+l.credit-l.debit,0); assert.equal(cashNet, 200, "cancel reversals net CASH_MAIN credit equals cancelRefundAmount");
  const cancellationReversal = related.find(e=>e.type==='reversal'); assert.ok(cancellationReversal.lines.some(l=>l.accountCode==='1111'&&l.credit===300));
});

it("credit cancel with down payment nets the customer party to zero", async () => {
  const p = await product({ code: "CANCEL-CR", stock: 3, cost: 20, retail: 790 }); const credit = await call("POST", "/api/credit-sales", saleBody([{ productId: p._id, quantity: 1, price: 790 }], { initialPaidAmount: 200, initialPaymentDate: "2026-11-05" }));
  const cancelled = await call("POST", `/api/credit-sales/${credit.json._id}/cancel`, { reason: "cancel down payment" }); assert.equal(cancelled.status, 200);
  const customerAccount = await Account.findOne({ systemKey: "CUSTOMERS" }); const entries = await JournalEntry.find({ "lines.partyId": credit.json.customerId || credit.json.customer }).lean(); const net = entries.flatMap(e=>e.lines).filter(l=>String(l.accountId)===String(customerAccount._id)).reduce((sum,l)=>sum+l.debit-l.credit,0); assert.equal(net,0);
  const refund = await JournalEntry.findOne({ "source.type": "refund", "source.id": credit.json._id }).lean(); assert.equal(refund.source.number, credit.json.payments[0].number);
});

it("auto-restock has its own entry and survives invoice cancel", async () => {
  const p = await product({ code: "RESTOCK", stock: 1, cost: 20, retail: 100 }); const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }], { confirmInsufficientInventory: true })); assert.equal(sale.status,201);
  const adjustment = await JournalEntry.findOne({ "source.type": "auto_restock", "source.id": sale.json._id }).lean(); assert.ok(adjustment); await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "cancel restocked sale" }); assert.equal((await JournalEntry.findById(adjustment._id)).reversedBy, null);
  const health = await call("GET", "/api/accounting/health"); assert.equal(health.json.inventory.difference, 0, JSON.stringify(health.json.inventory)); await assertHealthy();
});

it("product create, stock edits and purchase-price revaluation post inside their transactions", async () => {
  const p = await product({ code: "PRODUCT-POST", stock: 4, cost: 20, retail: 100 }); assert.ok(await JournalEntry.findOne({ "source.type": "product_create", "source.id": p._id }));
  await call("PUT", `/api/products/${p._id}`, { inventoryCount: 6 }); let entry = await JournalEntry.findOne({ "source.type": "inventory_adjustment", "source.id": p._id }).sort({createdAt:-1}).lean(); assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.debit===40));
  await call("PUT", `/api/products/${p._id}`, { inventoryCount: 5 }); entry = await JournalEntry.findOne({ "source.type": "inventory_adjustment", "source.id": p._id }).sort({createdAt:-1}).lean(); assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.credit===20));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 }); entry = await JournalEntry.findOne({ "source.type": "cost_revaluation", "source.id": p._id }).lean(); assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.debit===25));
});

it("items 9+10: reviewer repro — sync after a 3-of-5 return corrects COGS by +20 (net units), not +50", async () => {
  const p = await product({ code: "SYNC", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 5, price: 100 }]));
  await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 3 }] });
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 30 });
  const synced = await call("POST", `/api/products/${p._id}/sync-purchase-price`, {}); assert.equal(synced.status, 200, JSON.stringify(synced.json));
  const entries = await JournalEntry.find({ "source.type": "cost_sync" }).lean();
  assert.equal(entries.length, 1, "one entry per invoice");
  assert.deepEqual({ type: entries[0].source.type, id: String(entries[0].source.id), number: entries[0].source.number }, { type: "cost_sync", id: sale.json._id, number: sale.json.number });
  const lines = await keyedLines(entries[0]);
  assert.ok(lines.some((row) => row.key === "COGS" && row.debit === 20)); assert.ok(lines.some((row) => row.key === "INVENTORY_ADJUSTMENT" && row.credit === 20));
  await assertHealthy();
});

it("items 9+10: sync posts one entry per active ledger invoice; cancelled and pre-ledger invoices get none", async () => {
  const p = await product({ code: "SYNC-MANY", stock: 20, cost: 20, retail: 100 });
  const legacy = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 100 }]));
  await beginLedgerOnCurrentState();
  const customer = await Customer.create({ name: "Sync credit", phone: "01017170051" });
  const a = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }]));
  const b = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 3, price: 100 }] });
  const cancelled = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 100 }]));
  await call("POST", `/api/sellings/${cancelled.json._id}/cancel`, { reason: "cancel before sync" });
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 24 });
  assert.equal((await call("POST", `/api/products/${p._id}/sync-purchase-price`, {})).status, 200);
  const entries = await JournalEntry.find({ "source.type": "cost_sync" }).lean();
  const byInvoice = Object.fromEntries(await Promise.all(entries.map(async (entry) => [String(entry.source.id), (await keyedLines(entry)).find((row) => row.key === "COGS").debit])));
  assert.deepEqual(byInvoice, { [a.json._id]: 8, [b.json._id]: 12 });
  assert.equal((await Selling.findById(legacy.json._id).lean()).items[0].purchasePrice, 24, "operational sync still updates pre-ledger invoices");
  assert.equal((await Selling.findById(cancelled.json._id).lean()).items[0].purchasePrice, 24, "operational sync still updates cancelled invoices");
  await assertHealthy(); await assertCustomerMatchesStatement(customer._id);
});

it("items 9+10: cancel after a sync reverses the invoice's cost_sync entry; health stays zero", async () => {
  const p = await product({ code: "SYNC-CANCEL", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 });
  await call("POST", `/api/products/${p._id}/sync-purchase-price`, {});
  const sync = await JournalEntry.findOne({ "source.type": "cost_sync", "source.id": sale.json._id }).lean(); assert.ok(sync);
  await assertHealthy();
  assert.equal((await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "cancel after sync" })).status, 200);
  const reversal = await JournalEntry.findOne({ reversalOf: sync._id }).lean(); assert.ok(reversal, "cost_sync reversed");
  assert.equal(String((await JournalEntry.findById(sync._id).lean()).reversedBy), String(reversal._id));
  await assertHealthy();
});

it("items 9+10: edit after a sync reverses the sale and its cost_sync entries and re-posts at the current line costs", async () => {
  const p = await product({ code: "SYNC-EDIT", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 });
  await call("POST", `/api/products/${p._id}/sync-purchase-price`, {});
  const oldSale = await entryFor("sale", sale.json._id); const sync = await JournalEntry.findOne({ "source.type": "cost_sync", "source.id": sale.json._id }).lean();
  const edited = await call("PUT", `/api/sellings/${sale.json._id}`, { items: [{ productId: p._id, quantity: 2, price: 100 }] }); assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.ok((await JournalEntry.findById(oldSale._id)).reversedBy); assert.ok((await JournalEntry.findById(sync._id)).reversedBy);
  const open = await JournalEntry.find({ "source.type": "sale", "source.id": sale.json._id, type: "auto", reversedBy: null }).lean();
  assert.equal(open.length, 1); assert.ok((await keyedLines(open[0])).some((row) => row.key === "COGS" && row.debit === 50), "2 units at the line cost 25");
  await assertHealthy();
});

it("item 11: reverseEntry links reversalOf and reversing twice returns the same reversal", async () => {
  const p = await product({ code: "REVERSE-TWICE", stock: 2, cost: 20, retail: 100 });
  const entry = await JournalEntry.findOne({ "source.type": "product_create", "source.id": p._id }).lean();
  const first = await withTransaction((session) => reverseEntry(entry._id, { date: new Date(), memo: "first", session }));
  const second = await withTransaction((session) => reverseEntry(entry._id, { date: new Date(), memo: "second", session }));
  assert.equal(String(first.reversalOf), String(entry._id)); assert.equal(String(second._id), String(first._id));
  assert.equal(await JournalEntry.countDocuments({ reversalOf: entry._id }), 1);
  assert.equal(String((await JournalEntry.findById(entry._id).lean()).reversedBy), String(first._id));
  await assert.rejects(JournalEntry.create({ ...first.toObject(), _id: undefined, number: "JE-DUP" }), /duplicate key/, "unique reversalOf index");
});

it("item 4: edit after a price change values returned stock at the current price (new invoice); health 0", async () => {
  const p = await product({ code: "EDIT-PRICE", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 });
  await assertHealthy();
  const edited = await call("PUT", `/api/sellings/${sale.json._id}`, { items: [{ productId: p._id, quantity: 1, price: 100 }] }); assert.equal(edited.status, 200, JSON.stringify(edited.json));
  // Reversal +60 (3×20), new sale −25 (1×25, re-costed line) = +35 posted; 2 units back × 25 = +50 → +15 adjustment.
  const adjustment = await JournalEntry.findOne({ "source.type": "edit_cost_adjustment", "source.id": sale.json._id }).lean(); assert.ok(adjustment);
  const lines = await keyedLines(adjustment);
  assert.ok(lines.some((row) => row.key === "INVENTORY" && row.debit === 15)); assert.ok(lines.some((row) => row.key === "INVENTORY_ADJUSTMENT" && row.credit === 15));
  await assertHealthy();
});

it("item 4: edit after a price change values returned stock at the current price (pre-ledger invoice); health 0", async () => {
  const p = await product({ code: "EDIT-PRICE-OLD", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await beginLedgerOnCurrentState();
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 });
  await assertHealthy();
  const edited = await call("PUT", `/api/sellings/${sale.json._id}`, { items: [{ productId: p._id, quantity: 1, price: 100 }] }); assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.ok(await JournalEntry.findOne({ "source.type": "sale_edit", "source.id": sale.json._id }));
  const adjustment = await JournalEntry.findOne({ "source.type": "edit_cost_adjustment", "source.id": sale.json._id }).lean(); assert.ok(adjustment);
  assert.ok((await keyedLines(adjustment)).some((row) => row.key === "INVENTORY" && row.debit === 15));
  await assertHealthy();
  // Growing the invoice again takes 1 unit out at 25: the line cost equals the price, nothing to adjust.
  const grown = await call("PUT", `/api/sellings/${sale.json._id}`, { items: [{ productId: p._id, quantity: 2, price: 100 }] }); assert.equal(grown.status, 200);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "edit_cost_adjustment", "source.id": sale.json._id }), 1);
  await assertHealthy();
});

it("item 12: the INVENTORY ledger lists only INVENTORY lines and closes at the account balance", async () => {
  const p = await product({ code: "LEDGER-INV", stock: 5, cost: 20, retail: 100 });
  await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }]));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 30 });
  const inventory = await Account.findOne({ systemKey: "INVENTORY" }).lean();
  const ledger = await call("GET", `/api/accounting/accounts/${inventory._id}/ledger`); assert.equal(ledger.status, 200);
  assert.equal(ledger.json.lines.length, 3, "product create, sale, revaluation");
  assert.ok(ledger.json.lines.every((row) => String(row.accountId) === String(inventory._id)), JSON.stringify(ledger.json.lines.map((row) => row.accountCode)));
  const tree = (await call("GET", "/api/accounting/accounts")).json.accounts; const flat = (rows) => rows.flatMap((row) => [row, ...flat(row.children || [])]);
  const balance = flat(tree).find((row) => row.systemKey === "INVENTORY").balance;
  assert.equal(ledger.json.balance, balance); assert.equal(balance, 90);
  const from = new Date(); from.setDate(from.getDate() + 1); const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const later = await call("GET", `/api/accounting/accounts/${inventory._id}/ledger?from=${ymd(from)}`);
  assert.equal(later.json.openingBalance, 90); assert.equal(later.json.lines.length, 0); assert.equal(later.json.balance, 90);
});

it("item 13: asOf=YYYY-MM-DD means end of that local day, so an entry dated now is included with asOf=today", async () => {
  await product({ code: "ASOF", stock: 2, cost: 20, retail: 100 });
  const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const tree = (await call("GET", `/api/accounting/accounts?asOf=${ymd}`)).json; const flat = (rows) => rows.flatMap((row) => [row, ...flat(row.children || [])]);
  assert.equal(flat(tree.accounts).find((row) => row.systemKey === "INVENTORY").balance, 40);
  assert.equal(new Date(tree.asOf).getTime(), new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).getTime());
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1); const ymdY = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  assert.equal(flat((await call("GET", `/api/accounting/accounts?asOf=${ymdY}`)).json.accounts).find((row) => row.systemKey === "INVENTORY").balance, 0);
});

it("item 16: a posting refusal during category import is not a bad row (no productErrors) and rolls the import back", async () => {
  await withTransaction(async (session) => { await seedAccounts(session); });
  await Account.updateOne({ systemKey: "INVENTORY_ADJUSTMENT" }, { isActive: false });
  const categoryId = new mongoose.Types.ObjectId(); const productId = new mongoose.Types.ObjectId();
  const workbook = createCategoryWorkbook([{ _id: categoryId, name: "Import fail", image: "", specifications: [] }], [{ productId: String(productId), categoryId: String(categoryId), categoryName: "Import fail", name: "P", code: "IMP-FAIL", inventoryCount: 3, imageBase64: "", wholesalePrice: 30, purchasePrice: 20, retailPrice: 40, soldItemCount: 0, specifications: [] }]);
  const error = await withTransaction((session) => importCategories(workbook, session)).then(() => null, (caught) => caught);
  assert.ok(error); assert.match(error.message, /inactive or group account/); assert.equal(error.productErrors, undefined); assert.equal(error.responseData?.productErrors, undefined);
  assert.equal(await Product.countDocuments({ _id: productId }), 0, "import rolled back");
});

it("item 17: the opening entry fails and names the invoice when a credit sale's customer is gone", async () => {
  const ghost = new mongoose.Types.ObjectId();
  await CreditSale.create({ number: "CR-000777", customer: ghost, customerName: "Ghost", customerPhone: "01017170061", sellingDate: new Date("2026-01-01"), items: [], totalQuantity: 0, totalPrice: 50, paidAmount: 0, remainingAmount: 50, payments: [] });
  await Meta.create({ _id: "schema", version: 4 });
  await assert.rejects(runMigrations(), /CR-000777/);
  assert.equal((await Meta.findById("schema").lean()).ledgerStartAt, undefined); assert.equal(await JournalEntry.countDocuments({ type: "opening" }), 0);
});

it("item 17: opening customer balances equal the Stage 16 statement balances", async () => {
  const p = await product({ code: "OPEN-STATEMENT", stock: 20, cost: 20, retail: 100 });
  const a = await Customer.create({ name: "Statement A", phone: "01017170071" }); const b = await Customer.create({ name: "Statement B", phone: "01017170072" });
  const ca = await call("POST", "/api/credit-sales", { customerId: String(a._id), sellingDate: "2026-11-01", items: [{ productId: p._id, quantity: 3, price: 100 }], initialPaidAmount: 50, initialPaymentDate: "2026-11-01" });
  await call("POST", "/api/returns", { returnType: "credit", invoiceId: ca.json._id, items: [{ itemId: ca.json.items[0]._id, quantity: 1 }] });
  const cb = await call("POST", "/api/credit-sales", { customerId: String(b._id), sellingDate: "2026-11-01", items: [{ productId: p._id, quantity: 1, price: 100 }], initialPaidAmount: 40, initialPaymentDate: "2026-11-01" });
  await call("POST", `/api/credit-sales/${cb.json._id}/cancel`, { reason: "opening cancel" });
  await beginLedgerOnCurrentState();
  await assertCustomerMatchesStatement(a._id); await assertCustomerMatchesStatement(b._id);
  const opening = await JournalEntry.findOne({ type: "opening" }).lean();
  assert.equal(opening.lines.find((row) => String(row.partyId) === String(a._id)).debit, 150);
  assert.equal(opening.lines.some((row) => String(row.partyId) === String(b._id)), false, "cancelled with refund nets to 0");
  await assertHealthy();
});

it("item 18: postEntry returns null for an all-zero document and checks 'at least 2' on the cleaned lines", async () => {
  await withTransaction(async (session) => { await seedAccounts(session); });
  const accounts = Object.fromEntries((await Account.find({ systemKey: { $in: ["CASH_MAIN", "CAPITAL"] } }).lean()).map((a) => [a.systemKey, a]));
  const attempt = (lines) => withTransaction((session) => postEntry({ date: new Date(), source: { type: "validation", id: new mongoose.Types.ObjectId() }, lines, session }));
  assert.equal(await attempt([line(accounts.CASH_MAIN, 0, "debit"), line(accounts.CAPITAL, 0, "credit")]), null);
  await assert.rejects(attempt([line(accounts.CASH_MAIN, 5, "debit"), line(accounts.CAPITAL, 0, "credit")]), /at least two/);
  assert.equal(await JournalEntry.countDocuments(), 0);
  const p = await product({ code: "FREE", stock: 2, cost: 0, retail: 0 });
  const free = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 0 }])); assert.equal(free.status, 201, JSON.stringify(free.json));
  assert.equal(await JournalEntry.countDocuments({ "source.id": free.json._id }), 0);
  assert.equal((await call("POST", `/api/sellings/${free.json._id}/cancel`, { reason: "free cancel" })).status, 200);
  await assertHealthy();
});

it("item 19: postEntry rejects a partyId without partyType; cancel adjustment finds inventory by systemKey, not code 114", async () => {
  await withTransaction(async (session) => { await seedAccounts(session); });
  const accounts = Object.fromEntries((await Account.find({ systemKey: { $in: ["CASH_MAIN", "CAPITAL"] } }).lean()).map((a) => [a.systemKey, a]));
  await assert.rejects(withTransaction((session) => postEntry({ date: new Date(), source: { type: "validation", id: new mongoose.Types.ObjectId() }, session,
    lines: [line(accounts.CASH_MAIN, 1, "debit", { partyId: new mongoose.Types.ObjectId() }), line(accounts.CAPITAL, 1, "credit")] })), /Party type is required/);
  // Renumber INVENTORY: the cancel adjustment must still find its lines.
  await Account.updateOne({ systemKey: "INVENTORY" }, { code: "1149" });
  const p = await product({ code: "BY-KEY", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }]));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 26 });
  assert.equal((await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "by key" })).status, 200);
  const adjustment = await JournalEntry.findOne({ "source.type": "cancel_cost_adjustment", "source.id": sale.json._id }).lean();
  assert.ok((await keyedLines(adjustment)).some((row) => row.key === "INVENTORY" && row.debit === 12), "2 × (26 − 20)");
  await assertHealthy();
});

it("item 20: the users API rejects accounting.view without products.viewCost; role templates satisfy the rule", async () => {
  const base = { name: "Acc", password: "secret-pass-1", role: "custom" };
  const refused = await call("POST", "/api/users", { ...base, username: "acc-no-cost", permissions: ["accounting.view"] });
  assert.equal(refused.status, 400); assert.equal(refused.json.code, "PERMISSION_DEPENDENCY"); assert.deepEqual(refused.json.permissions, ["products.viewCost"]);
  const allowed = await call("POST", "/api/users", { ...base, username: "acc-cost", permissions: ["accounting.view", "products.viewCost"] });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.json));
  const update = await call("PUT", `/api/users/${allowed.json.user._id}`, { role: "custom", permissions: ["accounting.view"] });
  assert.equal(update.status, 400); assert.equal(update.json.code, "PERMISSION_DEPENDENCY");
  const templated = await call("POST", "/api/users", { ...base, username: "acc-template", role: "accountant", permissions: ROLE_TEMPLATES.accountant.filter((key) => key !== "products.viewCost") });
  assert.equal(templated.status, 400); assert.equal(templated.json.code, "PERMISSION_DEPENDENCY");
  for (const [role, list] of Object.entries(ROLE_TEMPLATES)) assert.deepEqual(missingDependencies(list), [], `${role} template`);
});

it("a credit invoice moved to another customer moves its payments too: each ledger party = statement", async () => {
  const p = await product({ code: "MOVE", stock: 5, cost: 20, retail: 100 });
  const a = await Customer.create({ name: "Move A", phone: "01017170081" }); const b = await Customer.create({ name: "Move B", phone: "01017170082" });
  const credit = await call("POST", "/api/credit-sales", { customerId: String(a._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 2, price: 100 }], initialPaidAmount: 70, initialPaymentDate: "2026-11-05" });
  const moved = await call("PUT", `/api/credit-sales/${credit.json._id}`, { customerId: String(b._id) }); assert.equal(moved.status, 200, JSON.stringify(moved.json));
  await assertCustomerMatchesStatement(a._id); await assertCustomerMatchesStatement(b._id); await assertHealthy();
});

const corruptLine = async (filter, update) => { const result = await JournalEntry.collection.updateOne(filter, update); assert.equal(result.modifiedCount, 1); };
async function corruptibleBook() {
  const p = await product({ code: "CORRUPT", stock: 10, cost: 20, retail: 100 });
  const customer = await Customer.create({ name: "Corrupt A", phone: "01017170091" }); const other = await Customer.create({ name: "Corrupt B", phone: "01017170092" });
  await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }]));
  const credit = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 100 }] });
  await call("POST", `/api/credit-sales/${credit.json._id}/payments`, { amount: 30 });
  await call("POST", "/api/credit-sales", { customerId: String(other._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 100 }] });
  await assertHealthy();
  const keys = Object.fromEntries((await Account.find({ systemKey: { $ne: null } }).lean()).map((account) => [account.systemKey, account._id]));
  return { keys, customer, other, credit };
}
const healthNow = async () => (await call("GET", "/api/accounting/health")).json;

it("health can fail — trialBalance: a line edited in the DB (stored totals untouched) is reported", async () => {
  const { keys } = await corruptibleBook();
  await corruptLine({ "source.type": "sale", "lines.accountId": keys.SALES }, { $inc: { "lines.$.credit": 7 } });
  const health = await healthNow(); assert.equal(health.trialBalance.difference, -7);
});

it("health can fail — inventory: an INVENTORY line moved to COGS is reported", async () => {
  const { keys } = await corruptibleBook();
  await corruptLine({ "source.type": "sale", "lines.accountId": keys.INVENTORY }, { $set: { "lines.$.accountId": keys.COGS } });
  const health = await healthNow(); assert.equal(health.trialBalance.difference, 0); assert.equal(health.inventory.difference, 40);
});

it("health can fail — customers: a party line re-pointed to another customer is reported per customer", async () => {
  const { keys, customer, other } = await corruptibleBook();
  await corruptLine({ "source.type": "receipt", "lines.accountId": keys.CUSTOMERS }, { $set: { "lines.$.partyId": other._id } });
  const health = await healthNow();
  assert.equal(health.trialBalance.difference, 0); assert.equal(health.customers.totalDifference, 0, "total alone would hide it");
  assert.equal(health.customers.difference, 60);
  assert.deepEqual(health.customers.byCustomer.map((row) => [row.customerId, row.difference]).sort(), [[String(customer._id), 30], [String(other._id), -30]].sort());
});

it("health can fail — netSales: SALES and CASH both inflated by 10 (balanced) is reported", async () => {
  const { keys } = await corruptibleBook();
  await JournalEntry.collection.updateOne({ "source.type": "sale" }, { $inc: { "lines.$[sales].credit": 10, "lines.$[cash].debit": 10 } }, { arrayFilters: [{ "sales.accountId": keys.SALES }, { "cash.accountId": keys.CASH_MAIN }] });
  const health = await healthNow(); assert.equal(health.trialBalance.difference, 0); assert.equal(health.netSales.difference, 10);
});

it("health can fail — cogs: COGS and INVENTORY both shifted by 5 is reported", async () => {
  const { keys } = await corruptibleBook();
  await JournalEntry.collection.updateOne({ "source.type": "sale" }, { $inc: { "lines.$[cogs].debit": 5, "lines.$[inventory].credit": 5 } }, { arrayFilters: [{ "cogs.accountId": keys.COGS }, { "inventory.accountId": keys.INVENTORY }] });
  const health = await healthNow(); assert.equal(health.trialBalance.difference, 0); assert.equal(health.cogs.difference, 5); assert.equal(health.inventory.difference, -5);
});

it("health can fail — entries: a deleted receipt entry is reported as missing", async () => {
  await corruptibleBook();
  await JournalEntry.collection.deleteOne({ "source.type": "receipt" });
  const health = await healthNow(); assert.equal(health.entries.difference, 1); assert.equal(health.entries.bySource.receipt.missing, 1);
});

/** A pre-ledger invoice (3 units at cost 20, 1 returned before the ledger), cancelled after the ledger started. */
async function cancelledPreLedgerInvoice() {
  const p = await product({ code: "LEGACY-CANCEL-COST", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }], { sellingDate: "2025-01-01" }));
  const ret = await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 1 }], returnDate: "2025-01-02" });
  assert.equal(ret.status, 201, JSON.stringify(ret.json));
  await beginLedgerOnCurrentState();
  const cancelled = await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "legacy cancel" }); assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  return { p, sale: sale.json };
}

it("pre-ledger cancel stores only the line purchasePrice snapshot; health derives the cost and survives a later sync", async () => {
  const { p, sale } = await cancelledPreLedgerInvoice();
  const stored = await Selling.findById(sale._id).select("+ledgerTrace").lean();
  assert.deepEqual(stored.ledgerTrace.cancelLines.map((row) => [String(row.invoiceItemId), row.purchasePrice]), [[String(sale.items[0]._id), 20]]);
  assert.equal(stored.ledgerTrace.cancelCost, undefined, "no posted amount is stored");
  const legacy = await JournalEntry.findOne({ type: "legacy_reversal", "source.id": sale._id }).lean();
  assert.ok((await keyedLines(legacy)).some((row) => row.key === "COGS" && row.credit === 40), "2 kept units × 20");
  await assertHealthy();
  // A later sync rewrites the cancelled invoice's line cost (operational, unchanged); the snapshot keeps health independent of it.
  assert.equal((await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 })).status, 200);
  assert.equal((await call("POST", `/api/products/${p._id}/sync-purchase-price`, {})).status, 200);
  assert.equal((await Selling.findById(sale._id).lean()).items[0].purchasePrice, 25);
  await assertHealthy();
});

it("health can fail — cogs: the COGS line of a pre-ledger cancel corrupted (balanced) is reported", async () => {
  const { sale } = await cancelledPreLedgerInvoice();
  await assertHealthy();
  const keys = Object.fromEntries((await Account.find({ systemKey: { $ne: null } }).lean()).map((account) => [account.systemKey, account._id]));
  const result = await JournalEntry.collection.updateOne({ type: "legacy_reversal", "source.id": new mongoose.Types.ObjectId(sale._id) },
    { $inc: { "lines.$[cogs].credit": -5, "lines.$[inventory].debit": -5 } }, { arrayFilters: [{ "cogs.accountId": keys.COGS }, { "inventory.accountId": keys.INVENTORY }] });
  assert.equal(result.modifiedCount, 1);
  const health = await healthNow();
  assert.equal(health.trialBalance.difference, 0); assert.equal(health.cogs.difference, 5); assert.equal(health.inventory.difference, -5);
});

it("ledgerTrace never appears in API responses (invoices, lists, statements, returns, dashboard, journal)", async () => {
  const p = await product({ code: "TRACE-LEAK", stock: 30, cost: 20, retail: 100 });
  const customer = await Customer.create({ name: "Trace", phone: "01017170201" });
  const cashEdit = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }], { sellingDate: "2025-01-01" }));
  const cashCancel = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }], { sellingDate: "2025-01-01" }));
  const creditEdit = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2025-01-01", items: [{ productId: p._id, quantity: 2, price: 100 }] });
  const creditCancel = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2025-01-01", items: [{ productId: p._id, quantity: 1, price: 100 }] });
  await beginLedgerOnCurrentState();
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 });
  assert.equal((await call("PUT", `/api/sellings/${cashEdit.json._id}`, { items: [{ productId: p._id, quantity: 3, price: 100 }] })).status, 200);
  assert.equal((await call("PUT", `/api/credit-sales/${creditEdit.json._id}`, { items: [{ productId: p._id, quantity: 3, price: 100 }] })).status, 200);
  assert.equal((await call("POST", `/api/sellings/${cashCancel.json._id}/cancel`, { reason: "trace" })).status, 200);
  assert.equal((await call("POST", `/api/credit-sales/${creditCancel.json._id}/cancel`, { reason: "trace" })).status, 200);
  const editedCash = await call("GET", `/api/sellings/${cashEdit.json._id}`);
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: cashEdit.json._id, items: [{ itemId: editedCash.json.items[0]._id, quantity: 1 }] })).status, 201);
  const traced = await Selling.collection.countDocuments({ ledgerTrace: { $exists: true } }) + await CreditSale.collection.countDocuments({ ledgerTrace: { $exists: true } });
  assert.equal(traced, 4, "the fixture really carries ledgerTrace in the DB");
  const journal = await call("GET", "/api/accounting/journal?limit=100"); assert.equal(journal.status, 200);
  const returns = await call("GET", "/api/returns?limit=100"); assert.equal(returns.status, 200);
  const routes = [
    `/api/sellings/${cashEdit.json._id}`, `/api/sellings/${cashCancel.json._id}`, "/api/sellings?limit=100",
    `/api/credit-sales/${creditEdit.json._id}`, `/api/credit-sales/${creditCancel.json._id}`, "/api/credit-sales?limit=100",
    `/api/customers/${customer._id}`, `/api/customers/${customer._id}/statement`, "/api/customers",
    "/api/returns?limit=100", `/api/returns/${returns.json.data[0]._id}`, "/api/returns/summary", "/api/dashboard/summary",
    "/api/accounting/journal?limit=100", ...journal.json.data.map((entry) => `/api/accounting/journal/${entry._id}`), "/api/accounting/health",
  ];
  for (const route of routes) {
    const response = await call("GET", route); assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.json)}`);
    const body = JSON.stringify(response.json);
    for (const key of ["ledgerTrace", "cancelLines", "editNetSales", "editCost"]) assert.ok(!body.includes(key), `${route} leaks ${key}`);
  }
});

it("repro scenarios: old data → upgrade → sale, return after price change, edit, cancel, credit cancel with down payment, sync (pre-ledger and new)", async () => {
  const p = await product({ code: "REPRO-A", stock: 40, cost: 20, retail: 100 });
  const repro = await Customer.create({ name: "Repro", phone: "01017170101" });
  const legacyCustomer = await Customer.create({ name: "Repro legacy", phone: "01017170102" });
  const cashEdit = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 2, price: 100 }], { sellingDate: "2025-01-01" }));
  const cashWithReturn = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }], { sellingDate: "2025-01-01" }));
  await call("POST", "/api/returns", { returnType: "cash", invoiceId: cashWithReturn.json._id, items: [{ itemId: cashWithReturn.json.items[0]._id, quantity: 1 }], returnDate: "2025-01-02" });
  const creditDown = await call("POST", "/api/credit-sales", { customerId: String(legacyCustomer._id), sellingDate: "2025-01-01", items: [{ productId: p._id, quantity: 1, price: 100 }], initialPaidAmount: 20, initialPaymentDate: "2025-01-01" });
  const creditOpen = await call("POST", "/api/credit-sales", { customerId: String(legacyCustomer._id), sellingDate: "2025-01-01", items: [{ productId: p._id, quantity: 3, price: 100 }] });
  await call("POST", "/api/returns", { returnType: "credit", invoiceId: creditOpen.json._id, items: [{ itemId: creditOpen.json.items[0]._id, quantity: 1 }], returnDate: "2025-01-02" });
  await beginLedgerOnCurrentState();
  const result = await runLedgerRepro({ call, productId: p._id, customerId: String(repro._id), customerIds: [String(legacyCustomer._id)],
    pre: { cashEdit: cashEdit.json._id, cashWithReturn: cashWithReturn.json._id, creditDown: creditDown.json._id, creditOpen: creditOpen.json._id } });
  console.log(`[stage17 repro] ${JSON.stringify(result)}`);
  assert.equal(result.steps.length, 10);
});

it("OB-000001 carries positive and negative customers and credits capital for the net debit", async () => {
  const positive=await Customer.create({name:'Positive',phone:'01017170011'});const negative=await Customer.create({name:'Negative',phone:'01017170012'});const productDoc=await Product.create({name:'Opening',code:'OPEN',category:(await Category.create({name:'Opening'}))._id,inventoryCount:2,purchasePrice:20,wholesalePrice:30,retailPrice:40});
  await CreditSale.create({customer:positive._id,customerName:positive.name,customerPhone:positive.phone,sellingDate:new Date('2026-01-01'),items:[],totalQuantity:0,totalPrice:100,paidAmount:0,remainingAmount:100,payments:[]});
  await CreditSale.create({customer:negative._id,customerName:negative.name,customerPhone:negative.phone,sellingDate:new Date('2026-01-01'),items:[],totalQuantity:0,totalPrice:50,paidAmount:80,remainingAmount:0,payments:[{amount:80,paymentDate:new Date('2026-01-01'),source:'down_payment'}]});
  await Meta.create({_id:'schema',version:4});await runMigrations();const opening=await JournalEntry.findOne({type:'opening',number:'OB-000001'}).lean();assert.ok(opening);const customerLines=opening.lines.filter(line=>line.accountCode==='113');assert.ok(customerLines.some(line=>String(line.partyId)===String(positive._id)&&line.debit===100));assert.ok(customerLines.some(line=>String(line.partyId)===String(negative._id)&&line.credit===30));assert.ok(opening.lines.some(line=>line.accountCode==='31'&&line.credit===110));assert.equal(productDoc.inventoryCount,2);
});

it("category import with stock posts inventory inside the import transaction", async () => {
  const categoryId=new mongoose.Types.ObjectId();const productId=new mongoose.Types.ObjectId();const workbook=createCategoryWorkbook([{_id:categoryId,name:'Imported',image:'',specifications:[]}],[{productId:String(productId),categoryId:String(categoryId),categoryName:'Imported',name:'Imported product',code:'IMP-17',inventoryCount:3,imageBase64:'',wholesalePrice:30,purchasePrice:20,retailPrice:40,soldItemCount:0,specifications:[]}]);
  await withTransaction(session=>importCategories(workbook,session));const entry=await JournalEntry.findOne({"source.type":"product_create","source.id":productId}).lean();assert.ok(entry);assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.debit===60));
});

it("hard delete with stock posts a write-off inside the delete transaction", async () => {
  const p=await product({code:'DELETE-STOCK',stock:3,cost:20,retail:100});const deleted=await call('DELETE',`/api/products/${p._id}`);assert.equal(deleted.status,200,JSON.stringify(deleted.json));const entry=await JournalEntry.findOne({"source.type":"product_writeoff","source.id":p._id}).lean();assert.ok(entry);const lines=await keyedLines(entry);assert.ok(lines.some(row=>row.key==='INVENTORY'&&row.credit===60));assert.ok(lines.some(row=>row.key==='INVENTORY_ADJUSTMENT'&&row.debit===60));
});

it("pre-ledger cash invoice edit posts only the new-minus-old difference and health is zero", async () => {
  const p=await product({code:'LEGACY-EDIT-CASH',stock:6,cost:20,retail:100});const sale=await call('POST','/api/sellings',saleBody([{productId:p._id,quantity:2,price:100}]));await beginLedgerOnCurrentState();const edited=await call('PUT',`/api/sellings/${sale.json._id}`,{items:[{productId:p._id,quantity:3,price:100}]});assert.equal(edited.status,200,JSON.stringify(edited.json));const difference=await JournalEntry.findOne({"source.type":"sale_edit","source.id":sale.json._id}).lean();const lines=await keyedLines(difference);assert.ok(lines.some(row=>row.key==='CASH_MAIN'&&row.debit===100));assert.ok(lines.some(row=>row.key==='COGS'&&row.debit===20));await assertHealthy();
});

it("pre-ledger credit invoice edit posts the party difference and health is zero", async () => {
  const p=await product({code:'LEGACY-EDIT-CR',stock:6,cost:20,retail:100});const customer=await Customer.create({name:'Legacy credit',phone:'01017170021'});const sale=await call('POST','/api/credit-sales',{customerId:String(customer._id),sellingDate:'2026-01-01',items:[{productId:p._id,quantity:2,price:100}]});await beginLedgerOnCurrentState();const edited=await call('PUT',`/api/credit-sales/${sale.json._id}`,{items:[{productId:p._id,quantity:3,price:100}]});assert.equal(edited.status,200,JSON.stringify(edited.json));const difference=await JournalEntry.findOne({"source.type":"credit_sale_edit","source.id":sale.json._id}).lean();const lines=await keyedLines(difference);assert.ok(lines.some(row=>row.key==='CUSTOMERS'&&row.debit===100&&row.party==='customer'));await assertHealthy();
});

it("pre-ledger cash and credit cancels synthesize sale reversals and health remains zero", async () => {
  const p=await product({code:'LEGACY-CANCEL',stock:8,cost:20,retail:100});const cash=await call('POST','/api/sellings',saleBody([{productId:p._id,quantity:2,price:100}]));const customer=await Customer.create({name:'Legacy cancel',phone:'01017170022'});const credit=await call('POST','/api/credit-sales',{customerId:String(customer._id),sellingDate:'2026-01-01',items:[{productId:p._id,quantity:1,price:100}]});await beginLedgerOnCurrentState();assert.equal((await call('POST',`/api/sellings/${cash.json._id}/cancel`,{reason:'legacy cash cancel'})).status,200);assert.equal((await call('POST',`/api/credit-sales/${credit.json._id}/cancel`,{reason:'legacy credit cancel'})).status,200);const legacyEntries=await JournalEntry.find({type:'legacy_reversal',"source.id":{$in:[cash.json._id,credit.json._id]}}).lean();assert.equal(legacyEntries.length,2);
  assert.equal(await JournalEntry.countDocuments({type:'reversal',"source.id":{$in:[cash.json._id,credit.json._id]}}),0,'no reversal without an original');
  for(const entry of legacyEntries){assert.equal(entry.reversalOf,null);assert.match(entry.memo,/^Pre-ledger .*cancelled: reverses the position held at the ledger start \(no original entry to link\)$/);}
  await assertHealthy();
});
