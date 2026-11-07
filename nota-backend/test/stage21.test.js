process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage21-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const Supplier = require("../src/models/supplier.model");
const VatEvent = require("../src/models/vatEvent.model");
const { runMigrations } = require("../src/migrations");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { setClock } = require("../src/utils/clock");
const vat = require("../src/utils/vat");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27141 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage21-owner", password: "owner-pass-123" });
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
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const pad = (value) => String(value).padStart(2, "0");
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const TODAY = localDate();
const THIS_MONTH = TODAY.slice(0, 7);

async function product({ code, stock = 100, cost = 20, exempt = false } = {}) {
  const category = await Category.create({ name: `S21 ${code}` });
  const response = await call("POST", "/api/products", { name: code, code, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 100, ...(exempt ? { vatExempt: true } : {}) });
  return ok(response, 201);
}
async function keyed(entry) {
  const accounts = await Account.find({}).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey || account.code]));
  return entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit }));
}
const entriesOf = async (type, id) => Promise.all((await JournalEntry.find({ "source.type": type, "source.id": id }).sort({ createdAt: 1 }).lean()).map(async (entry) => ({ type: entry.type, lines: await keyed(entry) })));
/** { KEY: [debit, credit] } of an entry, only the revenue/VAT/cash side (no cost lines). */
const amounts = (entry, keys) => Object.fromEntries(entry.lines.filter((row) => keys.includes(row.key)).map((row) => [row.key, row.debit ? { debit: row.debit } : { credit: row.credit }]));
async function assertHealthy() {
  const report = ok(await call("GET", "/api/accounting/health"));
  for (const [name, check] of Object.entries(report)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
  return report;
}
const accountBalance = async (key) => { const accounts = await Account.find({ systemKey: key }).lean(); const rows = await JournalEntry.aggregate([{ $unwind: "$lines" }, { $match: { "lines.accountId": accounts[0]._id } }, { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]); return rows.length ? Math.round(rows[0].balance * 100) / 100 + 0 : 0; };
const login = async (username, password) => ok(await call("POST", "/api/auth/login", { username, password })).token;
const makeUser = async (username, role) => { ok(await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role }), 201); return login(username, "secret-pass-1"); };

const enableVat = async ({ rate = 14, includes = true, taxNumber = "123-456-789" } = {}) => ok(await call("PUT", "/api/shop-profile", { name: "متجر الاختبار", taxNumber, vat: { enabled: true, rate, pricesIncludeVat: includes } }));
const cashSale = async (items, extra = {}, expected = 201) => ok(await call("POST", "/api/sellings", { customerName: "Cash customer", customerPhone: "01017171718", sellingDate: TODAY, items, ...extra }), expected);
const creditSale = async (customer, items, extra = {}) => ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items, ...extra }), 201);
const ret = async (returnType, invoice, lines, extra = {}) => ok(await call("POST", "/api/returns", { returnType, invoiceId: invoice._id, items: lines.map(([p, q]) => ({ productId: p._id, quantity: q, returnReason: "x" })), ...extra }), 201);

/** The shop of the design: main box, a few products, a registered and a plain supplier. */
async function shop() {
  await startLedger();
  ok(await call("POST", "/api/accounting/opening", { cash: 50000 }));
  const a = await product({ code: "A35", cost: 20 }); const b = await product({ code: "B65", cost: 40 });
  const boxes = ok(await call("GET", "/api/cashbox/boxes")).data;
  return { a, b, main: boxes.find((box) => box.isMain) };
}
const items = (s, qa = 4, qb = 2) => [{ productId: s.a._id, quantity: qa, price: 35 }, { productId: s.b._id, quantity: qb, price: 65 }];

// ------------------------------------------------------------ pure rules

it("pure math: inclusive 250 -> VAT 30.70, net 219.30; exclusive 250 -> VAT 35.00, total 285.00; exempt lines; remainders", () => {
  const lines = [{ totalPrice: 140 }, { totalPrice: 130 }];
  const inclusive = vat.computeSaleVat({ items: lines, discountAmount: 20, shippingFees: 0, rate: 14, included: true });
  assert.equal(inclusive.vatAmount, 30.7); assert.equal(inclusive.totalPrice, 250); assert.equal(inclusive.netAmount, 219.3);
  assert.deepEqual(inclusive.breakdown, { salesNet: 236.84, discountNet: 17.54, shippingNet: 0 });
  assert.equal(Math.round((inclusive.breakdown.salesNet - inclusive.breakdown.discountNet + inclusive.vatAmount) * 100) / 100, 250);
  const exclusive = vat.computeSaleVat({ items: lines, discountAmount: 20, shippingFees: 0, rate: 14, included: false });
  assert.equal(exclusive.vatAmount, 35); assert.equal(exclusive.totalPrice, 285); assert.equal(exclusive.netAmount, 250);
  assert.deepEqual(exclusive.breakdown, { salesNet: 270, discountNet: 20, shippingNet: 0 });
  // Σ line VAT = invoice VAT (the last taxable component takes the remainder)
  for (const sample of [inclusive, exclusive]) assert.equal(Math.round((sample.itemVat.reduce((sum, value) => sum + value, 0) + sample.shippingVat) * 100) / 100, sample.vatAmount);
  const mixed = vat.computeSaleVat({ items: [{ totalPrice: 140 }, { totalPrice: 130, vatExempt: true }], discountAmount: 20, shippingFees: 10, rate: 14, included: true });
  assert.equal(mixed.vatAmount, 17.15); assert.equal(mixed.totalPrice, 260); assert.equal(mixed.shippingVat, 1.23);
  assert.deepEqual(mixed.breakdown, { salesNet: 252.81, discountNet: 18.73, shippingNet: 8.77 });
  assert.equal(Math.round((mixed.breakdown.salesNet - mixed.breakdown.discountNet + mixed.breakdown.shippingNet + mixed.vatAmount) * 100) / 100, 260);
  assert.equal(vat.resolvePeriod(new Date("2026-10-15T00:00:00Z"), "2026-10"), "2026-11");
  assert.equal(vat.resolvePeriod(new Date("2026-12-31T00:00:00Z"), "2026-12"), "2027-01");
  assert.equal(vat.resolvePeriod(new Date("2026-11-01T00:00:00Z"), "2026-10"), "2026-11");
});

// ------------------------------------------------------------ settings

it("settings: tax number required to turn VAT on; rate 0-100 with 2 decimals; startDate set on turning on; additive PUT", async () => {
  const before = ok(await call("GET", "/api/shop-profile"));
  assert.equal(before.vat, undefined, "absent until saved: a shop without VAT sees what it always saw");
  const noNumber = await call("PUT", "/api/shop-profile", { name: "متجر", vat: { enabled: true } });
  assert.equal(noNumber.status, 400); assert.equal(noNumber.json.code, "TAX_NUMBER_REQUIRED");
  for (const rate of [-1, 100.01, 14.123, "x"]) {
    const bad = await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "1", vat: { enabled: true, rate } });
    assert.equal(bad.status, 400, String(rate)); assert.equal(bad.json.code, "INVALID_VAT_RATE");
  }
  const on = await enableVat({ rate: 14.5 });
  assert.equal(on.vat.enabled, true); assert.equal(on.vat.rate, 14.5); assert.equal(on.vat.pricesIncludeVat, true);
  assert.equal(new Date(on.vat.startDate).toISOString().slice(0, 10), TODAY);
  // An older screen (no vat block) keeps the settings.
  const older = ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789" }));
  assert.equal(older.vat.enabled, true); assert.equal(older.vat.rate, 14.5);
  // Everyone signed in reads, only shop.manage writes.
  const cashier = await makeUser("s21-cashier", "cashier");
  token = cashier;
  assert.equal((await call("GET", "/api/shop-profile")).status, 200);
  assert.equal((await call("PUT", "/api/shop-profile", { name: "x", vat: { enabled: false } })).status, 403);
  token = ownerToken;
  const off = ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: false } }));
  assert.equal(off.vat.enabled, false); assert.equal(off.vat.rate, 14.5, "rate kept when turned off");
});

it("products, categories, suppliers and customers carry the VAT flags", async () => {
  const exempt = await product({ code: "EX1", exempt: true });
  assert.equal(exempt.vatExempt, true);
  const plain = await product({ code: "PL1" });
  assert.equal(plain.vatExempt, undefined);
  const category = await Category.findOne({ name: "S21 PL1" });
  const toggled = ok(await call("PUT", `/api/categories/${category._id}`, { vatExempt: true }));
  assert.equal(toggled.vatExempt, true);
  assert.equal((await Product.findById(plain._id).lean()).vatExempt, true, "the bulk toggle sets every product in the category");
  ok(await call("PUT", `/api/categories/${category._id}`, { vatExempt: false }));
  assert.equal((await Product.findById(plain._id).lean()).vatExempt, false);
  const supplier = ok(await call("POST", "/api/suppliers", { name: "مورد مسجل", vatRegistered: true }), 201);
  assert.equal(supplier.vatRegistered, true);
  const customer = ok(await call("POST", "/api/customers", { name: "شركة", phone: "01099999999", taxNumber: "555-111" }), 201);
  assert.equal(customer.taxNumber, "555-111");
  await startLedger();
  const seeded = await Account.findOne({ code: "115" }).lean();
  assert.equal(seeded.systemKey, "VAT_INPUT"); assert.equal(seeded.type, "asset"); assert.equal(seeded.normalSide, "debit");
});

// ------------------------------------------------------------ sales

it("prices including VAT: 4 x 35 + 2 x 65, discount 20 -> total 250, VAT 30.70, net 219.30; exact lines; health 0", async () => {
  const s = await shop(); await enableVat({ includes: true });
  const sale = await cashSale(items(s), { discountAmount: 20 });
  assert.equal(sale.totalPrice, 250); assert.equal(sale.vatAmount, 30.7); assert.equal(sale.netAmount, 219.3); assert.equal(sale.taxableAmount, 219.3); assert.equal(sale.exemptAmount, 0);
  assert.equal(sale.vatRate, 14); assert.equal(sale.vatIncluded, true); assert.equal(sale.vatPeriod, THIS_MONTH);
  const [entry] = await entriesOf("sale", sale._id);
  assert.deepEqual(amounts(entry, ["CASH_MAIN", "SALES", "SALES_DISCOUNT", "VAT_PAYABLE", "SHIPPING_INCOME"]), {
    CASH_MAIN: { debit: 250 }, SALES: { credit: 236.84 }, SALES_DISCOUNT: { debit: 17.54 }, VAT_PAYABLE: { credit: 30.7 },
  });
  const events = await VatEvent.find({}).lean();
  assert.equal(events.length, 1); assert.equal(events[0].vat, 30.7); assert.equal(events[0].direction, "output");
  const health = await assertHealthy();
  assert.equal(health.netSales.difference, 0); assert.equal(health.cogs.difference, 0); assert.equal(health.vat.difference, 0);
});

it("prices excluding VAT: the same items -> VAT 35.00, total 285.00 (the total visibly adds the tax); exact lines", async () => {
  const s = await shop(); await enableVat({ includes: false });
  const sale = await cashSale(items(s), { discountAmount: 20 });
  assert.equal(sale.totalPrice, 285); assert.equal(sale.vatAmount, 35); assert.equal(sale.netAmount, 250); assert.equal(sale.vatIncluded, false);
  const [entry] = await entriesOf("sale", sale._id);
  assert.deepEqual(amounts(entry, ["CASH_MAIN", "SALES", "SALES_DISCOUNT", "VAT_PAYABLE"]), { CASH_MAIN: { debit: 285 }, SALES: { credit: 270 }, SALES_DISCOUNT: { debit: 20 }, VAT_PAYABLE: { credit: 35 } });
  await assertHealthy();
});

it("a mixed taxable/exempt invoice with shipping: exempt line untaxed, shipping taxable, exact lines", async () => {
  const s = await shop(); await enableVat({ includes: true });
  const exempt = await product({ code: "EXM", cost: 30, exempt: true });
  const sale = await cashSale([{ productId: s.a._id, quantity: 4, price: 35 }, { productId: exempt._id, quantity: 2, price: 65 }], { discountAmount: 20, shippingFees: 10 });
  assert.equal(sale.totalPrice, 260); assert.equal(sale.vatAmount, 17.15); assert.equal(sale.netAmount, 242.85);
  assert.equal(sale.items.find((row) => row.productName === "EXM").vatExempt, true);
  const [entry] = await entriesOf("sale", sale._id);
  assert.deepEqual(amounts(entry, ["CASH_MAIN", "SALES", "SALES_DISCOUNT", "SHIPPING_INCOME", "VAT_PAYABLE"]), {
    CASH_MAIN: { debit: 260 }, SALES: { credit: 252.81 }, SALES_DISCOUNT: { debit: 18.73 }, SHIPPING_INCOME: { credit: 8.77 }, VAT_PAYABLE: { credit: 17.15 },
  });
  await assertHealthy();
});

it("credit sale + partial return + final return: Σ returned VAT = the invoice VAT exactly (both modes); every entry balances", async () => {
  const s = await shop();
  for (const includes of [true, false]) {
    await enableVat({ includes });
    const customer = await Customer.create({ name: `عميل ${includes}`, phone: includes ? "01000000001" : "01000000002" });
    const invoice = await creditSale(customer, items(s), { discountAmount: 20, shippingFees: 10 });
    assert.equal(invoice.vatAmount, includes ? 31.93 : 36.4, `vat ${includes}`); // taxable gross 250 + 10 shipping = 260
    const first = await ret("credit", invoice, [[s.a, 1]]);
    const second = await ret("credit", invoice, [[s.a, 2]]);
    const third = await ret("credit", invoice, [[s.a, 1], [s.b, 2]]);
    const logs = await require("../src/models/returnLog.model").find({ invoiceId: invoice._id }).sort({ createdAt: 1 }).lean();
    assert.equal(logs.length, 3);
    const total = Math.round(logs.reduce((sum, row) => sum + row.vatAmount, 0) * 100) / 100;
    assert.equal(total, invoice.vatAmount, `Σ returned VAT ${includes}`);
    assert.equal(third.status, "returned");
    const events = await VatEvent.find({ direction: "output" }).lean();
    assert.equal(Math.round(events.reduce((sum, row) => sum + row.vat, 0) * 100) / 100, 0, "a fully returned invoice leaves no output VAT");
    assert.equal(await accountBalance("VAT_PAYABLE"), 0);
    await assertHealthy();
    void first; void second;
  }
});

it("cash partial return: the VAT share of the returned taxable value, exact lines; the final return takes the remainder", async () => {
  const s = await shop(); await enableVat({ includes: true });
  const sale = await cashSale(items(s), { discountAmount: 20 });
  const first = await ret("cash", sale, [[s.a, 1]]);
  const log1 = first.data.returnLog;
  assert.equal(log1.vatAmount, 3.98); assert.equal(log1.finalReturnedAmount, 35);
  const [returnEntry] = await entriesOf("return", log1._id);
  assert.deepEqual(amounts(returnEntry, ["SALES_RETURNS", "VAT_PAYABLE", "CASH_MAIN"]), { SALES_RETURNS: { debit: 31.02 }, VAT_PAYABLE: { debit: 3.98 }, CASH_MAIN: { credit: 35 } });
  const last = await ret("cash", sale, [[s.a, 3], [s.b, 2]]);
  assert.equal(last.data.returnLog.vatAmount, 26.72);
  assert.equal(Math.round((log1.vatAmount + last.data.returnLog.vatAmount) * 100) / 100, 30.7);
  assert.equal(last.data.invoice.refundedAmount, 250);
  await assertHealthy();
});

it("cancel reverses the VAT and gets its own vatPeriod; an edit re-posts with the new figures", async () => {
  const s = await shop(); await enableVat({ includes: true });
  const sale = await cashSale(items(s), { discountAmount: 20 });
  const edited = ok(await call("PUT", `/api/sellings/${sale._id}`, { items: [{ productId: s.a._id, quantity: 2, price: 35 }], discountAmount: 0 }));
  assert.equal(edited.totalPrice, 70); assert.equal(edited.vatAmount, vat.round2(70 * 14 / 114)); assert.equal(edited.vatPeriod, THIS_MONTH);
  const events = await VatEvent.find({ sourceId: sale._id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(events.map((row) => row.kind), ["sale", "sale_edit"]);
  assert.equal(Math.round(events.reduce((sum, row) => sum + row.vat, 0) * 100) / 100, edited.vatAmount);
  await assertHealthy();
  const cancelled = ok(await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "اختبار" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await accountBalance("VAT_PAYABLE"), 0);
  const all = await VatEvent.find({ sourceId: sale._id }).lean();
  assert.equal(Math.round(all.reduce((sum, row) => sum + row.vat, 0) * 100) / 100 + 0, 0);
  assert.ok(all.some((row) => row.kind === "sale_cancel"));
  await assertHealthy();
});

it("a rate change applies to new documents only: old documents keep their rate and mode", async () => {
  const s = await shop(); await enableVat({ rate: 14, includes: true });
  const old = await cashSale([{ productId: s.a._id, quantity: 1, price: 114 }]);
  assert.equal(old.vatAmount, 14);
  await enableVat({ rate: 5, includes: false });
  const fresh = await cashSale([{ productId: s.a._id, quantity: 1, price: 100 }]);
  assert.equal(fresh.vatRate, 5); assert.equal(fresh.vatAmount, 5); assert.equal(fresh.totalPrice, 105);
  const same = ok(await call("GET", `/api/sellings/${old._id}`));
  assert.equal(same.vatRate, 14); assert.equal(same.vatAmount, 14);
  // returning the old invoice still uses its own rate
  const returned = await ret("cash", old, [[s.a, 1]]);
  assert.equal(returned.data.returnLog.vatAmount, 14);
  // turning VAT off: the next sale has no VAT, a posted invoice keeps its VAT
  ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: false } }));
  const plain = await cashSale([{ productId: s.a._id, quantity: 1, price: 100 }]);
  assert.equal(plain.vatAmount, undefined); assert.equal(plain.totalPrice, 100);
  assert.equal(ok(await call("GET", `/api/sellings/${fresh._id}`)).vatAmount, 5);
  await assertHealthy();
});

// ------------------------------------------------------------ purchases and expenses

const purchaseBody = (s, supplier, extra = {}) => ({
  supplierId: String(supplier._id), date: TODAY,
  items: [{ productId: s.a._id, qty: 20, unitPrice: 70 }, { productId: s.b._id, qty: 10, unitPrice: 240 }, { productId: (s.c || s.a)._id, qty: 30, unitPrice: 55 }],
  ...extra,
});

it("a purchase from a VAT-registered supplier: 5,450 net + 763 VAT = 6,213; inventory and the average exclude the VAT; a plain supplier has no VAT", async () => {
  const s = await shop(); await enableVat();
  s.c = await product({ code: "C55", stock: 6, cost: 55 });
  const registered = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  const plain = await Supplier.create({ name: "مورد عادي" });
  const body = purchaseBody(s, registered);
  const purchase = ok(await call("POST", "/api/purchases", body), 201);
  assert.equal(purchase.netTotal, 5450); assert.equal(purchase.vatAmount, 763); assert.equal(purchase.total, 6213); assert.equal(purchase.vatRegistered, true);
  const [entry] = await entriesOf("purchase", purchase._id);
  assert.equal(entry.lines.find((row) => row.key === "VAT_INPUT").debit, 763);
  assert.equal(entry.lines.find((row) => row.key === "SUPPLIERS").credit, 6213);
  const cost = (await Product.findById(s.a._id).lean()).purchasePrice;
  assert.equal(cost, vat.round2((100 * 20 + 20 * 70) / 120), "the average uses the net cost");
  await assertHealthy();
  const other = ok(await call("POST", "/api/purchases", purchaseBody(s, plain)), 201);
  assert.equal(other.vatAmount, 0); assert.equal(other.total, 5450);
  assert.equal((await entriesOf("purchase", other._id))[0].lines.some((row) => row.key === "VAT_INPUT"), false);
  // the supplier's printed VAT is editable
  const printed = ok(await call("POST", "/api/purchases", purchaseBody(s, registered, { vatAmount: 760 })), 201);
  assert.equal(printed.vatAmount, 760); assert.equal(printed.total, 6210);
  // VAT amount with VAT off is refused
  ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: false } }));
  assert.equal((await call("POST", "/api/purchases", purchaseBody(s, registered, { vatAmount: 5 }))).status, 400);
  await assertHealthy();
});

it("a purchase return gives back the VAT share (Σ = the purchase VAT); cancel reverses the input VAT", async () => {
  const s = await shop(); await enableVat();
  const supplier = await Supplier.create({ name: "مورد مسجل", vatRegistered: true });
  const purchase = ok(await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: TODAY, items: [{ productId: s.a._id, qty: 10, unitPrice: 100 }, { productId: s.b._id, qty: 5, unitPrice: 80 }] }), 201);
  assert.equal(purchase.vatAmount, 196);
  const full = ok(await call("GET", `/api/purchases/${purchase._id}`));
  const first = ok(await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: full.items[0]._id, qty: 4 }] }), 201);
  assert.equal(first.netTotal, 400); assert.equal(first.vatAmount, 56); assert.equal(first.total, 456);
  const second = ok(await call("POST", `/api/purchases/${purchase._id}/returns`, { items: [{ itemId: full.items[0]._id, qty: 6 }, { itemId: full.items[1]._id, qty: 5 }] }), 201);
  assert.equal(Math.round((first.vatAmount + second.vatAmount) * 100) / 100, 196);
  assert.equal(await accountBalance("VAT_INPUT"), 0);
  await assertHealthy();
  const other = ok(await call("POST", "/api/purchases", { supplierId: String(supplier._id), date: TODAY, items: [{ productId: s.a._id, qty: 2, unitPrice: 50 }] }), 201);
  ok(await call("POST", `/api/purchases/${other._id}/cancel`, { reason: "اختبار" }));
  assert.equal(await accountBalance("VAT_INPUT"), 0);
  await assertHealthy();
});

it("an expense with VAT: Dr category (net) + Dr VAT_INPUT / Cr box (total); the box and shift see the gross amount", async () => {
  const s = await shop(); await enableVat();
  const category = String((await Account.findOne({ code: "523" }).lean())._id);
  const expense = ok(await call("POST", "/api/expenses", { accountId: category, amount: 114, vatAmount: 14, boxId: s.main._id, note: "فاتورة كهرباء" }), 201);
  assert.equal(expense.vatAmount, 14);
  const [entry] = await entriesOf("expense", expense._id);
  assert.deepEqual(amounts(entry, ["EXP_UTILITIES", "VAT_INPUT", "CASH_MAIN"]), { EXP_UTILITIES: { debit: 100 }, VAT_INPUT: { debit: 14 }, CASH_MAIN: { credit: 114 } });
  assert.equal(ok(await call("GET", `/api/cashbox/boxes/${s.main._id}`)).balance, 50000 - 114);
  assert.equal((await call("POST", "/api/expenses", { accountId: category, amount: 10, vatAmount: 10, boxId: s.main._id })).status, 400);
  await assertHealthy();
  ok(await call("POST", `/api/expenses/${expense._id}/cancel`, { reason: "اختبار" }));
  assert.equal(await accountBalance("VAT_INPUT"), 0);
  await assertHealthy();
  ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: false } }));
  assert.equal((await call("POST", "/api/expenses", { accountId: category, amount: 114, vatAmount: 14, boxId: s.main._id })).status, 400);
});

// The monthly return, health and permissions are in stage21-return.test.js (its own database).

// ------------------------------------------------------------ profit, dashboard

it("profit is net of VAT: the invoice, the product report and the profit bar agree (inclusive 59.30; exclusive 90.00)", async () => {
  const s = await shop();
  const year = Number(TODAY.slice(0, 4));
  const profitOfReport = async () => Math.round((await call("GET", "/api/products/profit-report")).json.reduce((sum, row) => sum + Number(row.totalProfit || 0), 0) * 100) / 100;
  const bar = async () => (await call("GET", `/api/products/profit-bar?year=${year}`)).json.totalProfit;
  await enableVat({ includes: true });
  const inclusive = await cashSale(items(s), { discountAmount: 20 });
  assert.equal(inclusive.totalProfit, 59.3, "sales 236.84 - discount 17.54 - cost 160");
  assert.equal(await profitOfReport(), 59.3); assert.equal(await bar(), 59.3);
  await enableVat({ includes: false });
  const exclusive = await cashSale(items(s), { discountAmount: 20 });
  assert.equal(exclusive.totalProfit, 90, "net prices: 270 - 20 - 160");
  assert.equal(await profitOfReport(), 149.3); assert.equal(await bar(), 149.3);
  const customer = await Customer.create({ name: "عميل", phone: "01070000000" });
  const credit = await creditSale(customer, items(s), { discountAmount: 20 });
  assert.equal(credit.totalProfit, 90);
  assert.equal(await profitOfReport(), 239.3);
});

it("the dashboard keeps today's sales as what the customer paid (VAT included) and adds the VAT due KPI for permitted users", async () => {
  const s = await shop(); await enableVat({ includes: false });
  await cashSale(items(s), { discountAmount: 20 });
  const summary = ok(await call("GET", "/api/dashboard/summary"));
  assert.equal(summary.today.cash.total, 285, "the customer paid 285, VAT included");
  assert.deepEqual(summary.vat, { enabled: true, rate: 14, pricesIncludeVat: false });
  assert.deepEqual(summary.vatDue, { amount: 35, payable: 35, input: 0 }, "VAT payable less input VAT");
  token = await makeUser("s21-dash-cashier", "cashier");
  const cashier = ok(await call("GET", "/api/dashboard/summary"));
  assert.equal(cashier.vatDue, undefined, "only vat.file or accounting.view");
  assert.equal(cashier.vat.enabled, true, "the label needs no permission");
  assert.equal(cashier.today.cash.total, 285);
});
