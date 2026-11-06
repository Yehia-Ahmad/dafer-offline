process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage17-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
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
const { seedAccounts, postEntry, accountMap, line } = require("../src/accounting/posting");
const { withTransaction } = require("../src/utils/transaction");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

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
async function beginLedgerOnCurrentState() { await JournalEntry.deleteMany({}); await Account.deleteMany({}); await Counter.deleteMany({ _id: { $in: ['JE','OB'] } }); await Meta.deleteMany({}); await Meta.create({ _id:'schema', version:4 }); await runMigrations(); }
async function assertHealthy() { const response=await call('GET','/api/accounting/health'); assert.equal(response.status,200); for(const [name,check] of Object.entries(response.json)) assert.equal(check.difference,0,`${name}: ${JSON.stringify(check)}`); }

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

it("edit after partial return reverses only sale, leaves return entry, posts new sale and health is zero", async () => {
  const p = await product({ code: "EDIT-RETURN", stock: 10, cost: 20, retail: 100 });
  const sale = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 3, price: 100 }]));
  await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ itemId: sale.json.items[0]._id, quantity: 1 }] });
  const returnEntry = await JournalEntry.findOne({ "source.type": "return" }).lean(); const oldSale = await entryFor("sale", sale.json._id);
  const edited = await call("PUT", `/api/sellings/${sale.json._id}`, { items: [{ productId: p._id, quantity: 4, price: 100 }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal((await JournalEntry.findById(returnEntry._id)).reversedBy, null);
  assert.ok((await JournalEntry.findById(oldSale._id)).reversedBy);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "sale", "source.id": sale.json._id, type: "auto" }), 2);
  const health = await call("GET", "/api/accounting/health"); for (const check of Object.values(health.json)) assert.equal(check.difference, 0, JSON.stringify(health.json));
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

it("forced posting failure rolls back document, stock, INV and JE counters", async () => {
  const p = await product({ code: "ROLLBACK", stock: 2, cost: 20, retail: 100 });
  await Account.updateOne({ systemKey: "SALES" }, { isActive: false });
  const failed = await call("POST", "/api/sellings", saleBody([{ productId: p._id, quantity: 1, price: 100 }])); assert.equal(failed.status, 500);
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

it("credit return reallocates without a JE and leaves refundDue as a customer credit", async () => {
  const p = await product({ code: "RETURN-CREDIT", stock: 6, cost: 20, retail: 100 }); const customer = await Customer.create({ name: "Return credit", phone: "01017170031" });
  const source = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 2, price: 100 }] });
  const target = await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 20 }] });
  await call("POST", `/api/credit-sales/${source.json._id}/payments`, { amount: 150 });
  const before = await JournalEntry.countDocuments({ "source.type": "receipt" });
  const returned = await call("POST", "/api/returns", { returnType: "credit", invoiceId: source.json._id, items: [{ itemId: source.json.items[0]._id, quantity: 1 }] });
  assert.equal(returned.status, 201, JSON.stringify(returned.json));
  assert.equal(returned.json.reallocatedPaidAmount, 20); assert.equal(returned.json.refundDueAmount, 30);
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
});

it("product create, stock edits and purchase-price revaluation post inside their transactions", async () => {
  const p = await product({ code: "PRODUCT-POST", stock: 4, cost: 20, retail: 100 }); assert.ok(await JournalEntry.findOne({ "source.type": "product_create", "source.id": p._id }));
  await call("PUT", `/api/products/${p._id}`, { inventoryCount: 6 }); let entry = await JournalEntry.findOne({ "source.type": "inventory_adjustment", "source.id": p._id }).sort({createdAt:-1}).lean(); assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.debit===40));
  await call("PUT", `/api/products/${p._id}`, { inventoryCount: 5 }); entry = await JournalEntry.findOne({ "source.type": "inventory_adjustment", "source.id": p._id }).sort({createdAt:-1}).lean(); assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.credit===20));
  await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 }); entry = await JournalEntry.findOne({ "source.type": "cost_revaluation", "source.id": p._id }).lean(); assert.ok((await keyedLines(entry)).some(row=>row.key==='INVENTORY'&&row.debit===25));
});

it("sync-purchase-price posts one aggregated COGS adjustment", async () => {
  const p = await product({ code: "SYNC", stock: 5, cost: 20, retail: 100 }); await call("POST", "/api/sellings", saleBody([{ productId:p._id,quantity:2,price:100 }])); await call("PUT", `/api/products/${p._id}`, { purchasePrice: 25 });
  const synced = await call("POST", `/api/products/${p._id}/sync-purchase-price`, {}); assert.equal(synced.status,200,JSON.stringify(synced.json)); const entries=await JournalEntry.find({"source.type":"cost_sync","source.id":p._id}).lean();assert.equal(entries.length,1);const lines=await keyedLines(entries[0]);assert.ok(lines.some(row=>row.key==='COGS'&&row.debit===10));assert.ok(lines.some(row=>row.key==='INVENTORY_ADJUSTMENT'&&row.credit===10));
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
  const p=await product({code:'LEGACY-CANCEL',stock:8,cost:20,retail:100});const cash=await call('POST','/api/sellings',saleBody([{productId:p._id,quantity:2,price:100}]));const customer=await Customer.create({name:'Legacy cancel',phone:'01017170022'});const credit=await call('POST','/api/credit-sales',{customerId:String(customer._id),sellingDate:'2026-01-01',items:[{productId:p._id,quantity:1,price:100}]});await beginLedgerOnCurrentState();assert.equal((await call('POST',`/api/sellings/${cash.json._id}/cancel`,{reason:'legacy cash cancel'})).status,200);assert.equal((await call('POST',`/api/credit-sales/${credit.json._id}/cancel`,{reason:'legacy credit cancel'})).status,200);assert.equal(await JournalEntry.countDocuments({type:'reversal',"source.id":{$in:[cash.json._id,credit.json._id]}}),2);await assertHealthy();
});
