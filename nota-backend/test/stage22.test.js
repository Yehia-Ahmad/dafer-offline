process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage22-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const ExcelJS = require("exceljs");
const mongoose = require("mongoose");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const CreditSale = require("../src/models/creditSale.model");
const JournalEntry = require("../src/models/journalEntry.model");
const ManualEntryDraft = require("../src/models/manualEntryDraft.model");
const Meta = require("../src/models/meta.model");
const PeriodClose = require("../src/models/periodClose.model");
const Supplier = require("../src/models/supplier.model");
const { runMigrations } = require("../src/migrations");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { setClock } = require("../src/utils/clock");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27151 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage22-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token; ownerToken = token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text(); return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, text };
}
async function download(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, type: response.headers.get("content-type"), buffer: Buffer.from(await response.arrayBuffer()) };
}
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await PeriodClose.deleteMany({}); await ManualEntryDraft.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const pad = (value) => String(value).padStart(2, "0");
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const TODAY = localDate();
// "last month" of the real clock: the design's October
const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
const LM_YEAR = lastMonth.getFullYear(); const LM_MONTH = lastMonth.getMonth() + 1;
const lastDayOf = (year, month) => new Date(year, month, 0).getDate();
const inLastMonth = (day) => `${LM_YEAR}-${pad(LM_MONTH)}-${pad(day)}`;
const FROM = inLastMonth(1); const TO = inLastMonth(lastDayOf(LM_YEAR, LM_MONTH));
const dayAfter = (iso) => { const [y, m, d] = iso.split("-").map(Number); return localDate(new Date(y, m - 1, d + 1)); };
const monthBefore = (year, month) => (month === 1 ? [year - 1, 12] : [year, month - 1]);

async function product({ code, stock = 100, cost = 20 } = {}) {
  const category = await Category.create({ name: `S22 ${code}` });
  return ok(await call("POST", "/api/products", { name: code, code, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 100 }), 201);
}
const cashSale = async (items, extra = {}, expected = 201) => ok(await call("POST", "/api/sellings", { customerName: "Cash customer", customerPhone: "01017171718", sellingDate: TODAY, items, ...extra }), expected);
const creditSale = async (customer, items, extra = {}, expected = 201) => ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items, ...extra }), expected);
const ret = async (returnType, invoice, lines, extra = {}, expected = 201) => ok(await call("POST", "/api/returns", { returnType, invoiceId: invoice._id, items: lines.map(([p, q]) => ({ productId: p._id, quantity: q, returnReason: "x" })), ...extra }), expected);
const accountId = async (codeOrKey) => String((await Account.findOne({ $or: [{ code: codeOrKey }, { systemKey: codeOrKey }] }).lean())._id);
const expense = async (code, amount, date, extra = {}, expected = 201) => ok(await call("POST", "/api/expenses", { accountId: await accountId(code), amount, date, ...extra }), expected);
const makeCustomer = async (name = "عميل") => ok(await call("POST", "/api/customers", { name, phone: `010${Math.floor(10000000 + Math.random() * 89999999)}` }), 201);
const makeSupplier = async (name = "مورد") => ok(await call("POST", "/api/suppliers", { name }), 201);
const login = async (username, password) => ok(await call("POST", "/api/auth/login", { username, password })).token;
const makeUser = async (username, role) => { ok(await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role }), 201); return login(username, "secret-pass-1"); };
const as = async (userToken, fn) => { const previous = token; token = userToken; try { return await fn(); } finally { token = previous; } };
const healthOf = async () => ok(await call("GET", "/api/accounting/health"));
async function assertHealthy() {
  const report = await healthOf();
  for (const [name, check] of Object.entries(report)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
  return report;
}
const accountBalance = async (key) => {
  const account = await Account.findOne({ $or: [{ systemKey: key }, { code: key }] }).lean();
  const rows = await JournalEntry.aggregate([{ $unwind: "$lines" }, { $match: { "lines.accountId": account._id } }, { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]);
  return Math.round((rows[0]?.balance || 0) * 100) / 100;
};
const rowOf = (report, id) => report.rows.find((row) => row.id === id || row.code === id);
const flat = (rows) => rows.flatMap((row) => [row, ...(row.children ? flat(row.children) : [])]);

/** The shop of the design: opening cash, two products, then last month ("October") built from real documents. */
async function october() {
  await startLedger();
  ok(await call("POST", "/api/accounting/opening", { cash: 50000 }));
  const a = await product({ code: "A100", stock: 400, cost: 70 });
  const b = await product({ code: "B74", stock: 200, cost: 43 });
  const customer = await makeCustomer("م. سامي للمقاولات");
  // cash sale: 300 × 100 = 30,000, discount 400 → 29,600
  const cash = await cashSale([{ productId: a._id, quantity: 300, price: 100 }], { sellingDate: inLastMonth(10), discountAmount: 400 });
  // credit sale: 100 × 74.50 = 7,450, discount 250 → 7,200
  const credit = await creditSale(customer, [{ productId: b._id, quantity: 100, price: 74.5 }], { sellingDate: inLastMonth(12), discountAmount: 250 });
  await expense("521", 4500, inLastMonth(25)); await expense("522", 3500, inLastMonth(26)); await expense("523", 650, inLastMonth(27));
  await expense("524", 420, inLastMonth(27)); await expense("525", 330, inLastMonth(28));
  return { a, b, customer, cash, credit };
}

// ------------------------------------------------------------ reports: the design's October

it("income statement of the design's October: sales 37,450, discount 650, COGS 25,300, expenses 9,400 → net profit 2,100", async () => {
  await october();
  const report = ok(await call("GET", `/api/reports/income-statement?from=${FROM}&to=${TO}`));
  const amount = (id) => rowOf(report, id).amount;
  assert.equal(amount("410"), 37450); assert.equal(amount("420"), 650); assert.equal(amount("430"), 0); assert.equal(amount("440"), 0);
  assert.equal(amount("netSales"), 36800); assert.equal(amount("510"), 25300); assert.equal(amount("grossProfit"), 11500);
  assert.equal(amount("expenses"), 9400);
  const expenses = Object.fromEntries(flat(rowOf(report, "expenses").children).filter((row) => row.kind === "line").map((row) => [row.code, row.amount]));
  assert.deepEqual(expenses, { 521: 4500, 522: 3500, 523: 650, 524: 420, 525: 330, 530: 0, 540: 0 });
  assert.equal(amount("netProfit"), 2100);
  assert.equal(amount("grossMargin"), Math.round((11500 / 36800) * 10000) / 100);
  assert.equal(report.summary.netProfit, 2100); assert.equal(report.check.difference, 0);
  assert.equal(report.shopName, ""); assert.equal(report.currency, "EGP"); assert.deepEqual(report.period, { from: FROM, to: TO });
  // a period with nothing in it is all zeros
  const empty = ok(await call("GET", `/api/reports/income-statement?from=${LM_YEAR - 5}-01-01&to=${LM_YEAR - 5}-01-31`));
  assert.equal(rowOf(empty, "netProfit").amount, 0);
  await assertHealthy();
});

it("income statement comparison column: the previous period of the same length (a whole month → the month before)", async () => {
  await october();
  const [py, pm] = monthBefore(LM_YEAR, LM_MONTH);
  const report = ok(await call("GET", `/api/reports/income-statement?from=${FROM}&to=${TO}&compare=1`));
  assert.deepEqual(report.comparison, { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDayOf(py, pm))}` });
  assert.equal(rowOf(report, "410").amount, 37450); assert.equal(rowOf(report, "410").previous, 0); assert.equal(rowOf(report, "410").change, 37450);
  assert.equal(rowOf(report, "netProfit").previous, 0);
  // an arbitrary range: the same number of days right before it
  const custom = ok(await call("GET", `/api/reports/income-statement?from=${inLastMonth(10)}&to=${inLastMonth(14)}&compare=1`));
  assert.deepEqual(custom.comparison, { from: inLastMonth(5), to: inLastMonth(9) });
  assert.equal(rowOf(custom, "410").amount, 37450); // both sales fall on 10..14
});

it("balance sheet balances on the October data, with the current-period profit shown (and a new expense account appears automatically)", async () => {
  await october();
  const report = ok(await call("GET", `/api/reports/balance-sheet?asOf=${TODAY}`));
  assert.equal(report.check.difference, 0);
  assert.equal(report.totals.assets, 88700); assert.equal(report.totals.liabilities, 0);
  assert.equal(report.periodProfit, 2100);
  const equity = report.sections.equity;
  assert.equal(equity.amount, 88700);
  assert.equal(equity.children.find((row) => row.id === "currentProfit").amount, 2100);
  const byCode = Object.fromEntries(flat(report.sections.assets.children).map((row) => [row.code, row.amount]));
  assert.equal(byCode["1111"], 70200); assert.equal(byCode["113"], 7200); assert.equal(byCode["114"], 11300);
  assert.equal(Object.fromEntries(flat(equity.children).map((row) => [row.code, row.amount]))["31"], 86600);
  // as of a day in the past the sheet still balances
  assert.equal(ok(await call("GET", `/api/reports/balance-sheet?asOf=${TO}`)).check.difference, 0);
  // owner drawings are a deduction inside equity
  ok(await call("POST", "/api/cashbox/drawings", { amount: 1000, date: TODAY }), 201);
  const after = ok(await call("GET", `/api/reports/balance-sheet?asOf=${TODAY}`));
  assert.equal(after.check.difference, 0);
  assert.equal(flat(after.sections.equity.children).find((row) => row.code === "33").amount, -1000);
  assert.equal(after.totals.assets, 87700);
});

it("trial balance: opening / movement / closing per leaf, group subtotals, grand totals that balance", async () => {
  await october();
  const report = ok(await call("GET", `/api/reports/trial-balance?from=${FROM}&to=${TO}`));
  assert.equal(report.balanced, true);
  assert.equal(report.totals.openingDebit, report.totals.openingCredit);
  assert.equal(report.totals.movementDebit, report.totals.movementCredit);
  assert.equal(report.totals.closingDebit, report.totals.closingCredit);
  const leaf = (code) => flat(report.rows).find((row) => row.code === code);
  assert.equal(leaf("521").movementDebit, 4500); assert.equal(leaf("521").closingDebit, 4500); assert.equal(leaf("521").openingDebit, 0);
  assert.equal(leaf("410").movementCredit, 37450); assert.equal(leaf("410").closingCredit, 37450);
  // the group subtotal is the sum of its children
  const group = leaf("520");
  assert.equal(group.kind, "group"); assert.equal(group.movementDebit, 9400);
  // a later period sees the October closing as its opening
  const next = ok(await call("GET", `/api/reports/trial-balance?from=${dayAfter(TO)}&to=${TODAY}`));
  const nextLeaf = (code) => flat(next.rows).find((row) => row.code === code);
  assert.equal(nextLeaf("521").openingDebit, 4500); assert.equal(nextLeaf("410").openingCredit, 37450);
  assert.equal(next.totals.openingDebit, next.totals.openingCredit);
  // the customer account (113): a debit of 7,200
  assert.equal(leaf("113").movementDebit, 7200);
});

it("box movements: opening + in - out = closing, by kind, and every box equals its ledger", async () => {
  const shop = await october();
  const report = ok(await call("GET", `/api/reports/box-movements?from=${FROM}&to=${TO}`));
  const main = report.boxes.find((box) => box.isMain);
  const kinds = Object.fromEntries(main.byKind.map((kind) => [kind.key, kind]));
  assert.equal(kinds.sales.in, 29600); assert.equal(kinds.expenses.out, 9400);
  assert.equal(Math.round((main.opening + main.in - main.out) * 100) / 100, main.closing);
  assert.equal(report.totals.closing, Math.round(report.boxes.reduce((sum, box) => sum + box.closing, 0) * 100) / 100);
  // each box's closing balance is its ledger balance (the Stage 19 box screen) as of the end of the period
  const asOfToday = ok(await call("GET", `/api/reports/box-movements?from=${FROM}&to=${TODAY}`));
  for (const box of asOfToday.boxes) assert.equal(box.closing, ok(await call("GET", `/api/cashbox/boxes/${box.boxId}`)).balance, box.name);
  // a transfer between boxes and a drawing show as their own kinds; refunds (a cash return) too
  const wallet = ok(await call("POST", "/api/cashbox/boxes", { name: "فودافون كاش", type: "wallet" }), 201);
  ok(await call("POST", "/api/cashbox/transfers", { fromBoxId: main.boxId, toBoxId: wallet._id, amount: 500, date: TODAY }), 201);
  ok(await call("POST", "/api/cashbox/drawings", { amount: 100, date: TODAY }), 201);
  await ret("cash", shop.cash, [[shop.a, 1]]);
  const later = ok(await call("GET", `/api/reports/box-movements?from=${TODAY}&to=${TODAY}`));
  const laterMain = later.boxes.find((box) => box.isMain); const laterWallet = later.boxes.find((box) => String(box.boxId) === String(wallet._id));
  assert.equal(laterMain.byKind.find((kind) => kind.key === "transfers").out, 500);
  assert.equal(laterWallet.byKind.find((kind) => kind.key === "transfers").in, 500);
  assert.equal(laterMain.byKind.find((kind) => kind.key === "drawings").out, 100);
  assert.ok(laterMain.byKind.find((kind) => kind.key === "refunds").out > 0);
  for (const box of later.boxes) assert.equal(Math.round((box.opening + box.in - box.out) * 100) / 100, box.closing);
});

it("party balances: customers and suppliers equal each party's statement, aging buckets included", async () => {
  const shop = await october();
  const supplier = await makeSupplier("مورد المصنع");
  // a purchase on credit for the supplier, and an old customer invoice that is overdue
  ok(await call("POST", "/api/purchases", { supplierId: supplier._id, date: inLastMonth(5), items: [{ productId: shop.a._id, qty: 10, unitPrice: 60 }], paidAmount: 0 }), 201);
  const report = ok(await call("GET", "/api/reports/party-balances"));
  const row = report.customers.rows.find((entry) => String(entry.partyId) === String(shop.customer._id));
  const statement = ok(await call("GET", `/api/customers/${shop.customer._id}/statement`));
  assert.equal(row.balance, statement.totals.balance); assert.equal(row.balance, 7200);
  assert.equal(row.aging.total, statement.outstanding);
  assert.equal(row.aging.current + row.aging.d1_30, statement.aging.current + statement.aging.days1to30);
  assert.equal(row.aging.d61_90 + row.aging.d90plus, statement.aging.over60);
  assert.equal(report.customers.totals.balance, 7200);
  const supplierRow = report.suppliers.rows.find((entry) => String(entry.partyId) === String(supplier._id));
  const supplierStatement = ok(await call("GET", `/api/suppliers/${supplier._id}/statement`));
  assert.equal(supplierRow.balance, supplierStatement.balance); assert.equal(supplierRow.balance, 600);
  for (const bucket of ["current", "d1_30", "d31_60", "d61_90", "d90plus"]) assert.equal(supplierRow.aging[bucket], supplierStatement.aging[bucket], bucket);
  assert.equal(report.suppliers.totals.balance, 600);
  // an old invoice lands in an older bucket: backdate the credit invoice's due date by 45 days
  const old = new Date(); old.setDate(old.getDate() - 45);
  await CreditSale.updateOne({ _id: shop.credit._id }, { $set: { dueDate: old } });
  const aged = ok(await call("GET", "/api/reports/party-balances?type=customers"));
  const agedRow = aged.customers.rows.find((entry) => String(entry.partyId) === String(shop.customer._id));
  assert.equal(agedRow.aging.d31_60, 7200); assert.equal(agedRow.aging.current, 0); assert.equal(aged.suppliers, undefined);
  const agedStatement = ok(await call("GET", `/api/customers/${shop.customer._id}/statement`));
  assert.equal(agedStatement.aging.days31to60, 7200);
  await assertHealthy();
});

it("every report exports to .xlsx with the same rows: numbers as numbers, right-to-left sheet, shop header", async () => {
  await october();
  ok(await call("PUT", "/api/shop-profile", { name: "النور للأدوات الكهربائية" }));
  const income = await download(`/api/reports/income-statement?from=${FROM}&to=${TO}&format=xlsx`);
  assert.equal(income.status, 200); assert.match(income.type, /spreadsheetml/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(income.buffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.views[0].rightToLeft, true);
  assert.equal(sheet.getCell("A1").value, "النور للأدوات الكهربائية");
  assert.match(String(sheet.getCell("A3").value), /بالجنيه/);
  const cells = new Map(); sheet.eachRow((row) => cells.set(row.getCell(1).value, row.getCell(2).value));
  assert.equal(cells.get("المبيعات"), 37450); assert.equal(cells.get("صافي المبيعات"), 36800); assert.equal(cells.get("صافي الربح"), 2100);
  assert.equal(cells.get("خصم مسموح به"), -650); assert.equal(typeof cells.get("المبيعات"), "number");
  const balance = await download(`/api/reports/balance-sheet?asOf=${TODAY}&format=xlsx`);
  const balanceBook = new ExcelJS.Workbook(); await balanceBook.xlsx.load(balance.buffer);
  const balanceCells = new Map(); balanceBook.worksheets[0].eachRow((row) => balanceCells.set(row.getCell(1).value, row.getCell(2).value));
  assert.equal(balanceCells.get("إجمالي الأصول"), 88700); assert.equal(balanceCells.get("الفرق (الأصول − الخصوم − حقوق الملكية)"), 0);
  const trial = await download(`/api/reports/trial-balance?from=${FROM}&to=${TO}&format=xlsx`);
  const trialBook = new ExcelJS.Workbook(); await trialBook.xlsx.load(trial.buffer);
  let found = false; trialBook.worksheets[0].eachRow((row) => { if (row.getCell(1).value === "521") { found = true; assert.equal(row.getCell(5).value, 4500); } });
  assert.ok(found);
  const boxes = await download(`/api/reports/box-movements?from=${FROM}&to=${TO}&format=xlsx`);
  const boxBook = new ExcelJS.Workbook(); await boxBook.xlsx.load(boxes.buffer);
  assert.equal(boxBook.worksheets.length, 2);
  const parties = await download("/api/reports/party-balances?format=xlsx");
  const partyBook = new ExcelJS.Workbook(); await partyBook.xlsx.load(parties.buffer);
  assert.deepEqual(partyBook.worksheets.map((worksheet) => worksheet.name), ["أرصدة العملاء", "أرصدة الموردين"]);
  let customerRow = null; partyBook.worksheets[0].eachRow((row) => { if (row.getCell(1).value === "م. سامي للمقاولات") customerRow = row; });
  assert.equal(customerRow.getCell(2).value, 7200);
});

it("a cancelled invoice nets to 0 in the reports (they read the ledger)", async () => {
  const shop = await october();
  ok(await call("POST", `/api/sellings/${shop.cash._id}/cancel`, { reason: "غلط في الفاتورة" }));
  const report = ok(await call("GET", `/api/reports/income-statement?from=${FROM}&to=${TODAY}`));
  assert.equal(rowOf(report, "410").amount, 7450); assert.equal(rowOf(report, "420").amount, 250);
  assert.equal(report.check.difference, 0);
  await assertHealthy();
});

it("reports and manual/closing endpoints are permission-gated: a cashier gets 403, an accountant reads reports but cannot post or close", async () => {
  await october();
  const cashier = await makeUser("cashier22", "cashier");
  const accountant = await makeUser("accountant22", "accountant");
  const manager = await makeUser("manager22", "manager");
  for (const path of ["/api/reports/income-statement", "/api/reports/balance-sheet", "/api/reports/trial-balance", "/api/reports/box-movements", "/api/reports/party-balances"]) {
    assert.equal((await as(cashier, () => call("GET", path))).status, 403, path);
    assert.equal((await as(accountant, () => call("GET", path))).status, 200, path);
    assert.equal((await as(manager, () => call("GET", path))).status, 200, path);
  }
  const body = { date: TODAY, memo: "x", lines: [] };
  assert.equal((await as(cashier, () => call("POST", "/api/accounting/manual-entries", body))).status, 403);
  assert.equal((await as(accountant, () => call("POST", "/api/accounting/manual-entries", body))).status, 403);
  assert.equal((await as(manager, () => call("POST", "/api/accounting/manual-entries", body))).status, 403);
  assert.equal((await call("POST", "/api/accounting/manual-entries", body)).status, 201); // the owner
  const expensesRoot = await accountId("5");
  for (const who of [cashier, accountant, manager]) {
    assert.equal((await as(who, () => call("POST", "/api/accounting/closing/close", { confirm: true }))).status, 403);
    assert.equal((await as(who, () => call("POST", "/api/accounting/closing/reopen", { reason: "ssss", confirm: true }))).status, 403);
    assert.equal((await as(who, () => call("POST", "/api/accounting/accounts", { parentId: expensesRoot, nameAr: "x" }))).status, 403);
  }
  // closing settings are the owner's
  assert.equal((await as(manager, () => call("PUT", "/api/shop-profile", { name: "x", closing: { frequency: "yearly" } }))).status, 403);
  // everyone signed in reads the lock date (the posting forms disable locked dates)
  assert.equal((await as(cashier, () => call("GET", "/api/accounting/lock-date"))).status, 200);
  // templates: accounting.close owner only, reports.financial owner/manager/accountant
  assert.ok(ROLE_TEMPLATES.owner.includes("accounting.close")); assert.ok(!ROLE_TEMPLATES.manager.includes("accounting.close")); assert.ok(!ROLE_TEMPLATES.accountant.includes("accounting.close"));
  assert.ok(ROLE_TEMPLATES.accountant.includes("reports.financial") && ROLE_TEMPLATES.manager.includes("reports.financial") && !ROLE_TEMPLATES.cashier.includes("reports.financial"));
});

// ------------------------------------------------------------ manual entries

const MANUAL = "/api/accounting/manual-entries";
const draftOf = async (lines, extra = {}) => ok(await call("POST", MANUAL, { date: TODAY, memo: "قيد اختبار", lines, ...extra }), 201);
const postManual = async (lines, extra = {}) => { const draft = await draftOf(lines, extra); return { draft, response: await call("POST", `${MANUAL}/${draft._id}/post`) }; };
const poorShop = async () => { await startLedger(); ok(await call("POST", "/api/accounting/opening", { cash: 10000 })); };
const customerStatement = async (customer) => ok(await call("GET", `/api/customers/${customer._id}/statement`));
const invoiceOf = async (invoice) => ok(await call("GET", `/api/credit-sales/${invoice._id}`));

it("manual draft: saved unbalanced, edited, deleted; never in the ledger, reports or health; posting needs a memo and a balance, then it can never be edited", async () => {
  await poorShop();
  const [fixed, capital] = [await accountId("FIXED_ASSETS"), await accountId("CAPITAL")];
  const entriesBefore = await JournalEntry.countDocuments();
  const draft = await draftOf([{ accountId: fixed, debit: 5000, description: "ماكينة" }, { accountId: capital, credit: 4000 }], { memo: "" });
  assert.equal(draft.status, "draft"); assert.equal(draft.totalDebit, 5000); assert.equal(draft.totalCredit, 4000); assert.equal(draft.lines[0].accountCode, "121");
  assert.equal(await JournalEntry.countDocuments(), entriesBefore);
  assert.equal(flat(ok(await call("GET", `/api/reports/balance-sheet?asOf=${TODAY}`)).sections.assets.children).find((row) => row.code === "12").amount, 0);
  assert.equal(ok(await call("GET", `${MANUAL}?status=draft`)).data.length, 1);
  assert.equal(ok(await call("GET", `${MANUAL}/${draft._id}`)).lines.length, 2);
  // posting needs a memo, then a balance
  let attempt = await call("POST", `${MANUAL}/${draft._id}/post`); assert.equal(attempt.status, 400); assert.equal(attempt.json.code, "MEMO_REQUIRED");
  ok(await call("PUT", `${MANUAL}/${draft._id}`, { memo: "شراء ماكينة من مال المالك" }));
  attempt = await call("POST", `${MANUAL}/${draft._id}/post`); assert.equal(attempt.status, 400); assert.equal(attempt.json.code, "UNBALANCED");
  assert.equal(await JournalEntry.countDocuments(), entriesBefore);
  const edited = ok(await call("PUT", `${MANUAL}/${draft._id}`, { lines: [{ accountId: fixed, debit: 5000, description: "ماكينة" }, { accountId: capital, credit: 5000 }] }));
  assert.equal(edited.totalCredit, 5000);
  const posted = ok(await call("POST", `${MANUAL}/${draft._id}/post`));
  assert.equal(posted.status, "posted"); assert.match(posted.number, /^JE-\d{6}$/); assert.equal(posted.entry.number, posted.number);
  const entry = await JournalEntry.findById(posted.entry._id).lean();
  assert.equal(entry.type, "manual"); assert.equal(entry.source.type, "manual"); assert.equal(String(entry.source.id), String(draft._id)); assert.equal(entry.source.number, posted.number);
  assert.equal(entry.totalDebit, 5000); assert.equal(entry.lines.find((line) => line.accountCode === "121").description, "ماكينة");
  assert.equal(flat(ok(await call("GET", `/api/reports/balance-sheet?asOf=${TODAY}`)).sections.assets.children).find((row) => row.code === "12").amount, 5000);
  assert.equal(ok(await call("GET", `/api/accounting/journal?type=manual`)).data.length, 1);
  // posted: never edited, never deleted, never posted twice
  assert.equal((await call("PUT", `${MANUAL}/${draft._id}`, { memo: "x" })).json.code, "NOT_DRAFT");
  assert.equal((await call("DELETE", `${MANUAL}/${draft._id}`)).json.code, "NOT_DRAFT");
  assert.equal((await call("POST", `${MANUAL}/${draft._id}/post`)).json.code, "ALREADY_POSTED");
  // another draft is deletable
  const other = await draftOf([{ accountId: fixed, debit: 1 }]);
  assert.equal((await call("DELETE", `${MANUAL}/${other._id}`)).status, 204);
  assert.equal((await call("GET", `${MANUAL}/${other._id}`)).status, 404);
  // no future dates
  const future = await call("POST", MANUAL, { date: dayAfter(dayAfter(TODAY)), memo: "x", lines: [] }); assert.equal(future.status, 400); assert.equal(future.json.code, "FUTURE_DATE");
  assert.equal((await call("POST", MANUAL, { memo: "x", lines: [] })).json.code, "DATE_REQUIRED");
  await assertHealthy();
});

it("manual entry forbidden accounts: boxes, inventory, VAT (when on), invoice accounts and a customer debit are refused with the Arabic errors; the rest is allowed", async () => {
  await poorShop();
  const customer = await makeCustomer();
  const capital = await accountId("CAPITAL");
  const wallet = ok(await call("POST", "/api/cashbox/boxes", { name: "فودافون كاش", type: "wallet" }), 201);
  const refused = async (id, message, reason, extra = {}) => {
    const { response } = await postManual([{ accountId: id, debit: 100, ...extra }, { accountId: capital, credit: 100 }]);
    assert.equal(response.status, 400, JSON.stringify(response.json)); assert.equal(response.json.code, "FORBIDDEN_ACCOUNT"); assert.equal(response.json.reason, reason);
    assert.ok(response.json.message.includes(message), response.json.message);
  };
  const BOX = "استخدم شاشة الخزائن أو المصروفات";
  await refused(await accountId("1111"), BOX, "BOX_ACCOUNT");
  await refused(String((await Account.findOne({ _id: (await mongoose.connection.db.collection("cashboxes").findOne({ _id: new mongoose.Types.ObjectId(wallet._id) })).accountId }).lean())._id), BOX, "BOX_ACCOUNT");
  await refused(await accountId("114"), "استخدم تعديل الصنف", "INVENTORY_ACCOUNT");
  const INVOICE = "الحساب ده بيتحرك من الفواتير؛ صحّح بالمرتجع أو الإلغاء أو تعديل الفاتورة";
  for (const code of ["410", "420", "430", "440", "510"]) await refused(await accountId(code), INVOICE, "INVOICE_ACCOUNT");
  await refused(await accountId("520"), "تجميعي", "GROUP_ACCOUNT");
  // VAT accounts: allowed while VAT is off, forbidden once it is on
  const vatInput = await accountId("VAT_INPUT"); const vatPayable = await accountId("VAT_PAYABLE");
  const vatEntry = await postManual([{ accountId: vatInput, debit: 10 }, { accountId: capital, credit: 10 }]);
  ok(vatEntry.response);
  // (a VAT balance with no document behind it would fail the VAT health check once VAT is on, so this one is reversed first)
  ok(await call("POST", `${MANUAL}/${vatEntry.draft._id}/reverse`, { reason: "تجربة قبل تفعيل الضريبة" }));
  ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: true, rate: 14, pricesIncludeVat: true } }));
  await refused(vatInput, "استخدم شاشة الضريبة", "VAT_ACCOUNT"); await refused(vatPayable, "استخدم شاشة الضريبة", "VAT_ACCOUNT");
  // a customer DEBIT is forbidden (make a credit invoice instead); party rules
  const customers = await accountId("CUSTOMERS");
  let attempt = await postManual([{ accountId: customers, debit: 100, partyType: "customer", partyId: customer._id }, { accountId: capital, credit: 100 }]);
  assert.equal(attempt.response.status, 400); assert.equal(attempt.response.json.code, "CUSTOMER_DEBIT_FORBIDDEN"); assert.equal(attempt.response.json.message, "اعمل فاتورة آجل بدل القيد اليدوي");
  attempt = await postManual([{ accountId: await accountId("525"), debit: 100 }, { accountId: customers, credit: 100 }]);
  assert.equal(attempt.response.json.code, "PARTY_REQUIRED");
  attempt = await postManual([{ accountId: await accountId("525"), debit: 100, partyType: "customer", partyId: customer._id }, { accountId: capital, credit: 100 }]);
  assert.equal(attempt.response.json.code, "PARTY_NOT_ALLOWED");
  attempt = await postManual([{ accountId: await accountId("525"), debit: 100 }, { accountId: capital, credit: 100 }, { accountId: capital, debit: 0, credit: 0 }]);
  assert.equal(attempt.response.json.code, "LINE_ONE_SIDE");
  // the picker endpoint says the same
  const options = ok(await call("GET", `${MANUAL}/accounts`)).data; const optionOf = (code) => options.find((row) => row.code === code);
  assert.equal(optionOf("1111").blocked.code, "BOX_ACCOUNT"); assert.equal(optionOf("410").blocked.code, "INVOICE_ACCOUNT"); assert.equal(optionOf("114").blocked.code, "INVENTORY_ACCOUNT");
  assert.equal(optionOf("22").blocked.code, "VAT_ACCOUNT"); assert.equal(optionOf("523").blocked, null); assert.equal(optionOf("113").needsParty, "customer");
  assert.equal(options.find((row) => row.isGroup), undefined);
  // allowed: capital, drawings, retained earnings, fixed assets, accrued expenses, income and expense accounts (450, 530, 540, 523)
  const lines = [
    { accountId: await accountId("523"), debit: 100 }, { accountId: await accountId("540"), debit: 50 }, { accountId: await accountId("530"), debit: 25 },
    { accountId: await accountId("33"), debit: 10 }, { accountId: await accountId("121"), debit: 5 },
    { accountId: await accountId("450"), credit: 90 }, { accountId: await accountId("23"), credit: 50 }, { accountId: capital, credit: 25 }, { accountId: await accountId("32"), credit: 25 },
  ];
  assert.equal((await postManual(lines)).response.status, 200);
  await assertHealthy();
});

const twoInvoices = async () => {
  await poorShop();
  const p = await product({ code: "P22", stock: 100, cost: 20 });
  const customer = await makeCustomer("عميل متعثر");
  const inv1 = await creditSale(customer, [{ productId: p._id, quantity: 2, price: 100 }], { sellingDate: inLastMonth(3) });
  const inv2 = await creditSale(customer, [{ productId: p._id, quantity: 5, price: 100 }], { sellingDate: inLastMonth(9) });
  return { p, customer, inv1, inv2 };
};
const writeOff = async (customer, amount, extra = {}) => postManual([{ accountId: await accountId("525"), debit: amount, description: "ديون معدومة" }, { accountId: await accountId("CUSTOMERS"), credit: amount, partyType: "customer", partyId: customer._id, description: "إعدام دين" }], { memo: "إعدام دين عميل متعثر", ...extra });

it("bad debt write-off 300: both open invoices drop oldest first, ONE statement line, a receipt collects only the rest, statement = ledger, health 0", async () => {
  const { customer, inv1, inv2 } = await twoInvoices();
  const { draft, response } = await writeOff(customer, 300);
  const posted = ok(response);
  assert.deepEqual(posted.allocations.map((row) => [row.number, row.amount]), [[inv1.number, 200], [inv2.number, 100]]);
  const one = await invoiceOf(inv1); const two = await invoiceOf(inv2);
  assert.equal(one.remainingAmount, 0); assert.equal(one.status, "paid"); assert.equal(two.remainingAmount, 400); assert.equal(two.status, "partially_paid");
  const statement = await customerStatement(customer);
  const manualLines = statement.lines.filter((line) => line.type === "manual");
  assert.equal(manualLines.length, 1); assert.equal(manualLines[0].credit, 300); assert.match(manualLines[0].description, /^قيد يدوي JE-\d+$/); assert.equal(manualLines[0].number, posted.number); assert.equal(manualLines[0].memo, "إعدام دين عميل متعثر");
  assert.equal(statement.lines.filter((line) => line.type === "payment").length, 0, "no separate allocation lines");
  assert.equal(statement.totals.balance, 400); assert.equal(statement.outstanding, 400); assert.equal(statement.aging.total, 400);
  assert.equal(ok(await call("GET", `/api/customers/${customer._id}/credit`)).balance, 400);
  // the ledger party balance equals the statement (health customers 0)
  const ledger = ok(await call("GET", `/api/accounting/accounts/${await accountId("CUSTOMERS")}/ledger?partyId=${customer._id}`));
  assert.equal(ledger.balance, 400);
  await assertHealthy();
  // the party report equals the statement too
  const row = ok(await call("GET", "/api/reports/party-balances?type=customers")).customers.rows.find((entry) => String(entry.partyId) === String(customer._id));
  assert.equal(row.balance, 400); assert.equal(row.aging.total, 400);
  // a receipt can only collect what is left
  const over = await call("POST", `/api/customers/${customer._id}/payments`, { amount: 401, firstInvoice: true });
  assert.ok(over.status >= 400 && over.status < 500, `over-collection ${over.status}`);
  ok(await call("POST", `/api/customers/${customer._id}/payments`, { amount: 400, firstInvoice: true }), 201);
  assert.equal((await invoiceOf(inv2)).remainingAmount, 0);
  assert.equal((await customerStatement(customer)).totals.balance, 0);
  await assertHealthy();
  assert.equal((await ManualEntryDraft.findById(draft._id).lean()).allocations.length, 2);
});

it("a write-off bigger than the open invoices: the excess stays as customer credit; a manual DEBIT on a customer is refused", async () => {
  const { customer } = await twoInvoices();
  const posted = ok((await writeOff(customer, 1000)).response);
  assert.equal(posted.allocations.reduce((sum, row) => sum + row.amount, 0), 700);
  const statement = await customerStatement(customer);
  assert.equal(statement.totals.balance, -300); assert.equal(statement.aging.credit, 300); assert.equal(statement.outstanding, 0);
  assert.equal(ok(await call("GET", `/api/customers/${customer._id}/credit`)).credit, 300);
  await assertHealthy();
  const debit = await postManual([{ accountId: await accountId("CUSTOMERS"), debit: 50, partyType: "customer", partyId: customer._id }, { accountId: await accountId("450"), credit: 50 }]);
  assert.equal(debit.response.status, 400);
});

it("reversing the write-off restores the remaining amounts on the same items (also when the customer paid since); health 0", async () => {
  const { customer, inv1, inv2 } = await twoInvoices();
  const { draft, response } = await writeOff(customer, 300); const posted = ok(response);
  assert.equal((await call("POST", `${MANUAL}/${draft._id}/reverse`, {})).json.code, "REASON_REQUIRED");
  const reversed = ok(await call("POST", `${MANUAL}/${draft._id}/reverse`, { reason: "العميل سدّد بره" }));
  assert.equal(reversed.reversal.number.startsWith("JE-"), true); assert.equal(reversed.reversal.reason, "العميل سدّد بره");
  assert.equal((await invoiceOf(inv1)).remainingAmount, 200); assert.equal((await invoiceOf(inv1)).status, "pending");
  assert.equal((await invoiceOf(inv2)).remainingAmount, 500); assert.equal((await invoiceOf(inv2)).status, "pending");
  assert.equal((await invoiceOf(inv1)).payments.filter((payment) => payment.source === "manual_entry").length, 0);
  const statement = await customerStatement(customer);
  assert.equal(statement.totals.balance, 700); assert.equal(statement.outstanding, 700);
  assert.deepEqual(statement.lines.filter((line) => line.type === "manual" || line.type === "manual_reversal").map((line) => [line.type, line.debit, line.credit]), [["manual", 0, 300], ["manual_reversal", 300, 0]]);
  // linked both ways in the ledger
  const original = await JournalEntry.findById(posted.entry._id).lean(); const mirror = await JournalEntry.findById(reversed.reversal._id).lean();
  assert.equal(String(original.reversedBy), String(mirror._id)); assert.equal(String(mirror.reversalOf), String(original._id)); assert.equal(mirror.type, "reversal");
  assert.equal((await call("POST", `${MANUAL}/${draft._id}/reverse`, { reason: "مرة تانية" })).json.code, "ALREADY_REVERSED");
  await assertHealthy();
  // paid since: write off again, the customer pays the rest, THEN reverse: the invoices are reopened for what had been written off
  const again = await writeOff(customer, 300); const second = ok(again.response);
  ok(await call("POST", `/api/customers/${customer._id}/payments`, { amount: 400, firstInvoice: true }), 201);
  assert.equal((await customerStatement(customer)).totals.balance, 0);
  ok(await call("POST", `${MANUAL}/${again.draft._id}/reverse`, { reason: "غلط في العميل" }));
  assert.equal((await invoiceOf(inv1)).remainingAmount, 200); assert.equal((await invoiceOf(inv2)).remainingAmount, 100);
  const finalStatement = await customerStatement(customer);
  assert.equal(finalStatement.totals.balance, 300); assert.equal(finalStatement.outstanding, 300);
  assert.equal(second.allocations.length, 2);
  await assertHealthy();
});

it("a write-off that cannot be undone exactly (the invoice changed since) refuses the reversal and changes nothing", async () => {
  const { customer, inv1 } = await twoInvoices();
  const { draft, response } = await writeOff(customer, 300); const posted = ok(response);
  await CreditSale.updateOne({ _id: inv1._id }, { $set: { status: "cancelled" } });
  const refusal = await call("POST", `${MANUAL}/${draft._id}/reverse`, { reason: "تجربة" });
  assert.equal(refusal.status, 409); assert.equal(refusal.json.code, "ALLOCATION_LOCKED");
  assert.equal((await ManualEntryDraft.findById(draft._id).lean()).reversal, undefined);
  assert.equal((await JournalEntry.findById(posted.entry._id).lean()).reversedBy, null);
  assert.equal((await CreditSale.findById(inv1._id).lean()).payments.filter((payment) => payment.source === "manual_entry").length, 1);
});

it("supplier lines: a credit is a payable item due on the entry date, a debit settles the oldest; the statement equals the ledger; a reversal nets to zero", async () => {
  await poorShop();
  const supplier = await makeSupplier("مورد خدمات");
  const suppliers = await accountId("SUPPLIERS");
  const first = ok((await postManual([{ accountId: await accountId("523"), debit: 1000 }, { accountId: suppliers, credit: 1000, partyType: "supplier", partyId: supplier._id }], { memo: "فاتورة كهرباء مستحقة" })).response);
  let statement = ok(await call("GET", `/api/suppliers/${supplier._id}/statement`));
  const line = statement.lines.find((row) => row.type === "manual");
  assert.equal(line.credit, 1000); assert.equal(line.number, first.number); assert.match(line.description, /^قيد يدوي JE-/);
  assert.equal(statement.balance, 1000); assert.equal(statement.aging.current, 1000); assert.equal(statement.aging.total, 1000);
  assert.equal(ok(await call("GET", "/api/suppliers")).find((row) => String(row._id) === String(supplier._id)).balance, 1000);
  await assertHealthy();
  const second = await postManual([{ accountId: suppliers, debit: 400, partyType: "supplier", partyId: supplier._id }, { accountId: await accountId("450"), credit: 400 }], { memo: "خصم من المورد" });
  ok(second.response);
  statement = ok(await call("GET", `/api/suppliers/${supplier._id}/statement`));
  assert.equal(statement.balance, 600); assert.equal(statement.aging.total, 600);
  await assertHealthy();
  ok(await call("POST", `${MANUAL}/${first._id}/reverse`, { reason: "تعديل المحاسب" }));
  statement = ok(await call("GET", `/api/suppliers/${supplier._id}/statement`));
  assert.equal(statement.balance, -400); assert.equal(statement.aging.advance, 400); assert.equal(statement.aging.total, 0);
  assert.deepEqual(statement.lines.map((row) => row.type), ["manual", "manual", "manual_reversal"]);
  await assertHealthy();
});

it("manual reversal: linked both ways, dated today or a chosen open date (not the future), reason required, once only; the income statement nets", async () => {
  await poorShop();
  const { draft, response } = await postManual([{ accountId: await accountId("523"), debit: 300 }, { accountId: await accountId("23"), credit: 300 }], { date: inLastMonth(15), memo: "كهرباء مستحقة" });
  const posted = ok(response);
  assert.equal(rowOf(ok(await call("GET", `/api/reports/income-statement?from=${FROM}&to=${TO}`)), "netProfit").amount, -300);
  assert.equal((await call("POST", `${MANUAL}/${draft._id}/reverse`, { reason: "x" })).status, 400);
  assert.equal((await call("POST", `${MANUAL}/${draft._id}/reverse`, { reason: "غلط", date: dayAfter(dayAfter(TODAY)) })).json.code, "FUTURE_DATE");
  const reversed = ok(await call("POST", `${MANUAL}/${draft._id}/reverse`, { reason: "غلط في الحساب", date: inLastMonth(20) }));
  const mirror = await JournalEntry.findById(reversed.reversal._id).lean();
  assert.equal(localDate(new Date(mirror.date)).slice(0, 10) === inLastMonth(20) || mirror.date.toISOString().slice(0, 10) === inLastMonth(20), true);
  assert.equal(rowOf(ok(await call("GET", `/api/reports/income-statement?from=${FROM}&to=${TO}`)), "netProfit").amount, 0);
  assert.equal((await ManualEntryDraft.findById(draft._id).lean()).reversal.number, mirror.number);
  assert.equal((await JournalEntry.findById(posted.entry._id).lean()).reversedBy.toString(), String(mirror._id));
  await assertHealthy();
  // today is the default
  const second = await postManual([{ accountId: await accountId("523"), debit: 10 }, { accountId: await accountId("23"), credit: 10 }]);
  const todayReversal = ok(await call("POST", `${MANUAL}/${second.draft._id}/reverse`, { reason: "اختبار اليوم" }));
  assert.equal((await JournalEntry.findById(todayReversal.reversal._id).lean()).date.toISOString().slice(0, 10), TODAY);
});

it("health fails (can-fail) when a manual entry is missing its draft or a draft claims an entry that is gone", async () => {
  await poorShop();
  const { draft, response } = await postManual([{ accountId: await accountId("523"), debit: 10 }, { accountId: await accountId("23"), credit: 10 }]);
  const posted = ok(response);
  assert.equal((await healthOf()).entries.difference, 0);
  await ManualEntryDraft.updateOne({ _id: draft._id }, { $set: { status: "draft" } });
  assert.equal((await healthOf()).entries.bySource.manual.orphaned, 1);
  await ManualEntryDraft.updateOne({ _id: draft._id }, { $set: { status: "posted" } });
  await JournalEntry.deleteMany({ _id: posted.entry._id });
  assert.equal((await healthOf()).entries.bySource.manual.missing, 1);
  // a customer manual line the statement does not know about breaks the customers check
  await poorShop();
  const customer = await makeCustomer();
  await JournalEntry.create({ number: "JE-X-1", date: new Date(), type: "manual", source: { type: "manual", id: new mongoose.Types.ObjectId() }, totalDebit: 50, totalCredit: 50, memo: "x", lines: [
    { accountId: await accountId("525"), accountCode: "525", accountName: "m", accountNameAr: "م", accountNameEn: "m", debit: 50 },
    { accountId: await accountId("CUSTOMERS"), accountCode: "113", accountName: "c", accountNameAr: "ع", accountNameEn: "c", credit: 50, partyType: "customer", partyId: customer._id },
  ] });
  const health = await healthOf();
  assert.equal(health.customers.difference, 50); assert.equal(health.entries.bySource.manual.orphaned, 1);
});

// ------------------------------------------------------------ accounts management

const ACCOUNTS = "/api/accounting/accounts";
const addAccount = async (parentCode, body = {}, expected = 201) => ok(await call("POST", ACCOUNTS, { parentId: await accountId(parentCode), nameAr: "حساب جديد", ...body }), expected);

it("add an account: the code is the next free child per branch, the type is inherited, a leaf under 520 becomes an expense category and shows in the income statement", async () => {
  await poorShop();
  const codes = {};
  for (const parent of ["520", "4", "3", "2", "12", "11", "1"]) codes[parent] = (await addAccount(parent, { nameAr: `تحت ${parent}` })).code;
  assert.deepEqual(codes, { 520: "52001", 4: "460", 3: "34", 2: "24", 12: "122", 11: "116", 1: "13" });
  assert.equal((await addAccount("520")).code, "52002");
  assert.equal((await addAccount("4")).code, "470"); assert.equal((await addAccount("5")).code, "550");
  const preview = ok(await call("GET", `${ACCOUNTS}/next-code?parentId=${await accountId("4")}`));
  assert.equal(preview.code, "480"); assert.equal(preview.type, "revenue"); assert.equal(preview.normalSide, "credit"); assert.equal(preview.scheme, "tens");
  // type and side come from the parent; English name defaults to the Arabic one
  const leaf = await Account.findOne({ code: "52001" }).lean();
  assert.equal(leaf.type, "expense"); assert.equal(leaf.normalSide, "debit"); assert.equal(leaf.isSystem, false); assert.equal(leaf.isGroup, false); assert.equal(leaf.nameEn, "تحت 520");
  const english = await addAccount("520", { nameAr: "صيانة", nameEn: "Maintenance" }); assert.equal(english.nameEn, "Maintenance");
  // it is an expense category (Stage 19) and usable in an expense; it appears in the income statement without any change
  assert.ok(ok(await call("GET", "/api/expenses/categories")).data.some((row) => row.code === "52001"));
  await expense("52001", 120, TODAY);
  const income = ok(await call("GET", `/api/reports/income-statement?from=${TODAY}&to=${TODAY}`));
  assert.equal(flat(income.rows).find((row) => row.code === "52001").amount, 120); assert.equal(rowOf(income, "netProfit").amount, -120);
  // a revenue leaf shows under "other income"
  assert.ok(flat(rowOf(income, "otherIncome").children).some((row) => row.code === "460" && row.nameAr === "تحت 4"));
  // a group: its first child gets parent + "01", then +1
  const group = await addAccount("5", { nameAr: "مجموعة", isGroup: true }); assert.equal(group.code, "560"); assert.equal(group.isGroup, true);
  const child = ok(await call("POST", ACCOUNTS, { parentId: group._id, nameAr: "ابن" }), 201); assert.equal(child.code, "56001");
  assert.equal(ok(await call("POST", ACCOUNTS, { parentId: group._id, nameAr: "ابن 2" }), 201).code, "56002");
  // refusals: parent must be a group, never the box branches, a name is required
  assert.equal((await call("POST", ACCOUNTS, { parentId: await accountId("113"), nameAr: "x" })).json.code, "PARENT_NOT_GROUP");
  assert.equal((await call("POST", ACCOUNTS, { parentId: await accountId("111"), nameAr: "x" })).json.code, "BOX_BRANCH");
  assert.equal((await call("POST", ACCOUNTS, { parentId: await accountId("112"), nameAr: "x" })).json.code, "BOX_BRANCH");
  assert.equal((await call("POST", ACCOUNTS, { parentId: await accountId("4"), nameAr: "  " })).json.code, "INVALID_NAME");
  assert.equal((await call("GET", `${ACCOUNTS}/next-code?parentId=${await accountId("111")}`)).status, 400);
  // a group takes no entries
  const posting = await postManual([{ accountId: group._id, debit: 10 }, { accountId: await accountId("31"), credit: 10 }]);
  assert.equal(posting.response.json.reason, "GROUP_ACCOUNT");
  await assertHealthy();
});

it("a branch that ran out of codes refuses a new account", async () => {
  await poorShop();
  for (const expected of ["460", "470", "480", "490"]) assert.equal((await addAccount("4")).code, expected);
  const full = await call("POST", ACCOUNTS, { parentId: await accountId("4"), nameAr: "زيادة" });
  assert.equal(full.status, 409); assert.equal(full.json.code, "CODE_EXHAUSTED");
});

it("edit: any account can be renamed (system included); parent and code never once it has lines, never on a system account; the type never", async () => {
  await poorShop();
  const sales = await Account.findOne({ systemKey: "SALES" }).lean();
  const renamed = ok(await call("PUT", `${ACCOUNTS}/${sales._id}`, { nameAr: "مبيعات البضاعة", nameEn: "Goods sales" }));
  assert.equal(renamed.nameAr, "مبيعات البضاعة"); assert.equal(renamed.code, "410");
  assert.equal((await call("PUT", `${ACCOUNTS}/${sales._id}`, { nameAr: " " })).json.code, "INVALID_NAME");
  assert.equal((await call("PUT", `${ACCOUNTS}/${sales._id}`, { code: "411" })).json.code, "SYSTEM_ACCOUNT");
  assert.equal((await call("PUT", `${ACCOUNTS}/${sales._id}`, { type: "expense" })).json.code, "TYPE_LOCKED");
  const mine = await addAccount("4", { nameAr: "إيراد خدمات" });
  const group = await addAccount("4", { nameAr: "مجموعة إيراد", isGroup: true });
  // no lines yet: parent and code can change (same type only)
  const moved = ok(await call("PUT", `${ACCOUNTS}/${mine._id}`, { parentId: group._id }));
  assert.equal(String(moved.parentId), String(group._id)); assert.equal(moved.code, "47001");
  assert.equal(ok(await call("PUT", `${ACCOUNTS}/${mine._id}`, { code: "47010" })).code, "47010");
  assert.equal((await call("PUT", `${ACCOUNTS}/${mine._id}`, { code: "5001" })).json.code, "INVALID_CODE");
  assert.equal((await call("PUT", `${ACCOUNTS}/${mine._id}`, { code: "410" })).json.code, "INVALID_CODE");
  assert.equal((await call("PUT", `${ACCOUNTS}/${mine._id}`, { parentId: await accountId("520") })).json.code, "TYPE_LOCKED");
  // once it has lines: names only
  ok((await postManual([{ accountId: await accountId("523"), debit: 10 }, { accountId: mine._id, credit: 10 }])).response);
  assert.equal((await call("PUT", `${ACCOUNTS}/${mine._id}`, { code: "47011" })).json.code, "ACCOUNT_HAS_LINES");
  assert.equal((await call("PUT", `${ACCOUNTS}/${mine._id}`, { parentId: await accountId("4") })).json.code, "ACCOUNT_HAS_LINES");
  assert.equal(ok(await call("PUT", `${ACCOUNTS}/${mine._id}`, { nameAr: "إيراد خدمات فنية" })).nameAr, "إيراد خدمات فنية");
  // a box account is edited from the box screens
  const wallet = ok(await call("POST", "/api/cashbox/boxes", { name: "محفظة", type: "wallet" }), 201);
  const walletAccount = (await mongoose.connection.db.collection("cashboxes").findOne({ _id: new mongoose.Types.ObjectId(wallet._id) })).accountId;
  assert.equal((await call("PUT", `${ACCOUNTS}/${walletAccount}`, { code: "11299" })).json.code, "BOX_ACCOUNT");
});

it("deactivate: only a non-system leaf with balance 0 and no open drafts; inactive accounts take no postings; reactivate; delete only if it never had lines", async () => {
  await poorShop();
  const system = await Account.findOne({ systemKey: "EXP_RENT" }).lean(); const group = await Account.findOne({ code: "520" }).lean();
  assert.equal((await call("POST", `${ACCOUNTS}/${system._id}/deactivate`)).json.code, "SYSTEM_ACCOUNT");
  assert.equal((await call("POST", `${ACCOUNTS}/${group._id}/deactivate`)).json.code, "SYSTEM_ACCOUNT");
  const grp = await addAccount("5", { isGroup: true }); assert.equal((await call("POST", `${ACCOUNTS}/${grp._id}/deactivate`)).json.code, "GROUP_ACCOUNT");
  const leaf = await addAccount("520", { nameAr: "بند للتجربة" });
  const usage = ok(await call("GET", `${ACCOUNTS}/${leaf._id}/usage`));
  assert.equal(usage.hasLines, false); assert.equal(usage.canDeactivate, true); assert.equal(usage.canDelete, true); assert.equal(usage.canEditStructure, true);
  // a draft that uses it blocks the deactivation
  const draft = await draftOf([{ accountId: leaf._id, debit: 50 }, { accountId: await accountId("31"), credit: 50 }]);
  let refusal = await call("POST", `${ACCOUNTS}/${leaf._id}/deactivate`); assert.equal(refusal.json.code, "HAS_OPEN_DRAFTS");
  assert.equal((await call("DELETE", `${ACCOUNTS}/${leaf._id}`)).json.code, "HAS_OPEN_DRAFTS");
  ok(await call("POST", `${MANUAL}/${draft._id}/post`));
  // a balance blocks it
  refusal = await call("POST", `${ACCOUNTS}/${leaf._id}/deactivate`); assert.equal(refusal.json.code, "HAS_BALANCE"); assert.equal(refusal.json.balance, 50);
  assert.equal((await call("DELETE", `${ACCOUNTS}/${leaf._id}`)).json.code, "ACCOUNT_HAS_LINES");
  // zero it with a second entry: the balance is 0 but the account HAS lines, so it can be stopped, not deleted
  ok((await postManual([{ accountId: await accountId("31"), debit: 50 }, { accountId: leaf._id, credit: 50 }])).response);
  assert.equal(ok(await call("GET", `${ACCOUNTS}/${leaf._id}/usage`)).canDelete, false);
  const stopped = ok(await call("POST", `${ACCOUNTS}/${leaf._id}/deactivate`)); assert.equal(stopped.isActive, false);
  assert.equal((await call("POST", `${ACCOUNTS}/${leaf._id}/deactivate`)).json.code, "ALREADY_INACTIVE");
  // inactive: hidden from the manual picker and the expense categories, and nothing can be posted to it
  assert.ok(!ok(await call("GET", `${MANUAL}/accounts`)).data.some((row) => row.code === leaf.code));
  assert.equal((await postManual([{ accountId: leaf._id, debit: 1 }, { accountId: await accountId("31"), credit: 1 }])).response.json.reason, "INACTIVE_ACCOUNT");
  assert.equal((await call("POST", "/api/expenses", { accountId: String(leaf._id), amount: 5, date: TODAY })).status >= 400, true);
  const reactivated = ok(await call("POST", `${ACCOUNTS}/${leaf._id}/reactivate`)); assert.equal(reactivated.isActive, true);
  assert.equal((await call("POST", `${ACCOUNTS}/${leaf._id}/reactivate`)).json.code, "ALREADY_ACTIVE");
  // never used: deleted for good; system accounts and accounts with children never
  const unused = await addAccount("520", { nameAr: "غير مستخدم" });
  assert.equal((await call("DELETE", `${ACCOUNTS}/${unused._id}`)).status, 204); assert.equal(await Account.exists({ _id: unused._id }), null);
  assert.equal((await call("DELETE", `${ACCOUNTS}/${system._id}`)).json.code, "SYSTEM_ACCOUNT");
  const parent = await addAccount("5", { isGroup: true }); ok(await call("POST", ACCOUNTS, { parentId: parent._id, nameAr: "ابن" }), 201);
  assert.equal((await call("DELETE", `${ACCOUNTS}/${parent._id}`)).json.code, "HAS_CHILDREN");
  assert.equal((await call("GET", `${ACCOUNTS}/000000000000000000000000/usage`)).status, 404);
  await assertHealthy();
});

// ------------------------------------------------------------ period closing

const CLOSING = "/api/accounting/closing";
const finalizeOpening = async () => ok(await call("POST", "/api/accounting/opening/finalize", { confirm: true }));
const closingState = async () => ok(await call("GET", CLOSING));
const closeNext = async (extra = {}) => call("POST", `${CLOSING}/close`, { confirm: true, ...extra });
const reopen = async (reason = "سبب إعادة الفتح") => call("POST", `${CLOSING}/reopen`, { reason, confirm: true });
const ddmmyyyy = (iso) => iso.split("-").reverse().join("/");
const monthsBack = (count, day = 1) => { const now = new Date(); return localDate(new Date(now.getFullYear(), now.getMonth() - count, day)); };
const monthEndOf = (count) => { const now = new Date(); return localDate(new Date(now.getFullYear(), now.getMonth() - count + 1, 0)); };
const lockedCode = (response) => { assert.equal(response.status, 409, JSON.stringify(response.json)); assert.equal(response.json.code, "PERIOD_LOCKED"); return response.json; };

/** October plus a purchase, a supplier and a customer with credit; the opening finalized and last month closed. */
async function closedOctober() {
  const shop = await october();
  const supplier = await makeSupplier("مورد المصنع");
  const purchase = ok(await call("POST", "/api/purchases", { supplierId: supplier._id, date: inLastMonth(5), items: [{ productId: shop.a._id, qty: 5, unitPrice: 60 }], paidAmount: 0 }), 201);
  const owed = await makeCustomer("عميل دائن");
  ok((await postManual([{ accountId: await accountId("525"), debit: 80 }, { accountId: await accountId("CUSTOMERS"), credit: 80, partyType: "customer", partyId: owed._id }])).response);
  const wallet = ok(await call("POST", "/api/cashbox/boxes", { name: "محفظة", type: "wallet" }), 201);
  await finalizeOpening();
  const closed = ok(await closeNext());
  return { ...shop, supplier, purchase, owed, wallet, closed };
}

it("monthly close: the oldest open month only, in order, only after it ended; a stale screen and a missing confirm are refused", async () => {
  await poorShop();
  const p = await product({ code: "ORD", stock: 100, cost: 20 });
  await cashSale([{ productId: p._id, quantity: 2, price: 100 }], { sellingDate: monthsBack(2, 10) });
  await cashSale([{ productId: p._id, quantity: 3, price: 100 }], { sellingDate: monthsBack(1, 12) });
  // the opening is not finalized: blocked first
  let state = await closingState();
  assert.equal(state.lockedThrough, null); assert.equal(state.next.end, monthEndOf(2)); assert.equal(state.next.ended, true); assert.equal(state.next.canClose, false);
  assert.equal(state.checklist.blocking.find((item) => item.key === "openingNotFinalized").ok, false);
  const blocked = await closeNext(); assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "CHECKLIST_BLOCKED");
  await finalizeOpening();
  state = await closingState();
  assert.equal(state.next.canClose, true); assert.equal(state.checklist.canClose, true); assert.equal(state.next.label, monthEndOf(2).slice(0, 7)); assert.equal(state.next.yearEnd, false);
  assert.ok(state.checklist.blocking.every((item) => item.ok));
  assert.equal((await call("POST", `${CLOSING}/close`, {})).json.code, "CONFIRM_REQUIRED");
  const stale = await closeNext({ periodEnd: monthEndOf(1) }); assert.equal(stale.json.code, "PERIOD_CHANGED"); assert.equal(stale.json.nextPeriodEnd, monthEndOf(2));
  const first = ok(await closeNext({ periodEnd: monthEndOf(2) }));
  assert.equal(first.lockedThrough, monthEndOf(2)); assert.equal(first.close.status, "closed"); assert.equal(first.entry, null);
  assert.equal(ok(await call("GET", "/api/accounting/lock-date")).lockedThrough, monthEndOf(2));
  state = await closingState();
  assert.equal(state.next.end, monthEndOf(1)); assert.equal(state.history.length, 1); assert.equal(state.latestClosedId, first.close._id);
  ok(await closeNext());
  assert.equal(ok(await call("GET", "/api/accounting/lock-date")).lockedThrough, monthEndOf(1));
  // this month has not ended
  state = await closingState();
  assert.equal(state.next.ended, false); assert.equal(state.next.canClose, false); assert.equal(state.next.start, monthsBack(0, 1));
  const early = await closeNext(); assert.equal(early.status, 409); assert.equal(early.json.code, "PERIOD_NOT_ENDED");
  assert.equal((await closingState()).history.length, 2);
  await assertHealthy();
});

it("PERIOD_LOCKED on every posting path family; returns, cancels and receipts on a locked invoice still work, dated today", async () => {
  const shop = await closedOctober();
  const lockedDay = inLastMonth(20);
  assert.equal(shop.closed.lockedThrough, TO);
  const refused = (response) => { const body = lockedCode(response); assert.ok(response.json.message.includes(ddmmyyyy(TO)), response.json.message); assert.equal(body.lockedThrough, TO); };
  // sales
  refused(await call("POST", "/api/sellings", { customerName: "x", customerPhone: "01017171718", sellingDate: lockedDay, items: [{ productId: shop.a._id, quantity: 1, price: 100 }] }));
  refused(await call("POST", "/api/credit-sales", { customerId: String(shop.customer._id), sellingDate: lockedDay, items: [{ productId: shop.b._id, quantity: 1, price: 100 }] }));
  // edits of documents dated in the locked month
  refused(await call("PUT", `/api/sellings/${shop.cash._id}`, { customerName: "اسم تاني" }));
  refused(await call("PUT", `/api/credit-sales/${shop.credit._id}`, { notes: "ملاحظة" }));
  // receipts, returns
  refused(await call("POST", `/api/customers/${shop.customer._id}/payments`, { amount: 100, firstInvoice: true, paymentDate: lockedDay }));
  refused(await call("POST", `/api/credit-sales/${shop.credit._id}/payments`, { amount: 100, paymentDate: lockedDay }));
  refused(await call("POST", "/api/returns", { returnType: "cash", invoiceId: shop.cash._id, returnDate: lockedDay, items: [{ productId: shop.a._id, quantity: 1, returnReason: "x" }] }));
  refused(await call("POST", "/api/returns", { returnType: "credit", invoiceId: shop.credit._id, returnDate: lockedDay, items: [{ productId: shop.b._id, quantity: 1, returnReason: "x" }] }));
  // purchases, PV, SR, PR
  refused(await call("POST", "/api/purchases", { supplierId: shop.supplier._id, date: lockedDay, items: [{ productId: shop.a._id, qty: 1, unitPrice: 60 }], paidAmount: 0 }));
  refused(await call("POST", `/api/suppliers/${shop.supplier._id}/payments`, { amount: 50, date: lockedDay }));
  refused(await call("POST", `/api/suppliers/${shop.supplier._id}/refunds`, { amount: 5, date: lockedDay }));
  refused(await call("POST", `/api/purchases/${shop.purchase._id}/returns`, { items: [{ itemId: shop.purchase.items[0]._id, qty: 1 }], date: lockedDay }));
  // expenses, transfers, drawings, payouts
  refused(await call("POST", "/api/expenses", { accountId: await accountId("525"), amount: 10, date: lockedDay }));
  const boxes = ok(await call("GET", "/api/cashbox/boxes")).data;
  refused(await call("POST", "/api/cashbox/transfers", { fromBoxId: boxes.find((box) => box.isMain)._id, toBoxId: shop.wallet._id, amount: 10, date: lockedDay }));
  refused(await call("POST", "/api/cashbox/drawings", { amount: 10, date: lockedDay }));
  refused(await call("POST", `/api/customers/${shop.owed._id}/payouts`, { amount: 10, date: lockedDay }));
  // manual entries: posting and reversing on a locked date
  const dated = await draftOf([{ accountId: await accountId("523"), debit: 5 }, { accountId: await accountId("23"), credit: 5 }], { date: lockedDay });
  refused(await call("POST", `${MANUAL}/${dated._id}/post`));
  const todayEntry = ok((await postManual([{ accountId: await accountId("523"), debit: 5 }, { accountId: await accountId("23"), credit: 5 }])).response);
  refused(await call("POST", `${MANUAL}/${todayEntry._id}/reverse`, { reason: "في فترة مقفولة", date: lockedDay }));
  // nothing was written by any refusal
  assert.equal(await JournalEntry.countDocuments({ date: { $gte: new Date(`${FROM}T00:00:00Z`), $lte: new Date(`${TO}T23:59:59Z`) }, createdAt: { $gt: new Date(shop.closed.close.closedAt) }, "source.type": { $ne: "period_close" } }), 0);
  await assertHealthy();

  // ---- still allowed: they are dated by the request (today), so they land in the open period
  const todayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const returned = await ret("cash", shop.cash, [[shop.a, 2]]);
  const returnEntry = await JournalEntry.findOne({ "source.type": "return", "source.id": returned.returnLog?._id || returned._id }).lean() || await JournalEntry.findOne({ "source.type": "return" }).sort({ createdAt: -1 }).lean();
  assert.ok(new Date(returnEntry.date) >= todayStart, `return entry dated ${returnEntry.date}`);
  ok(await call("POST", `/api/customers/${shop.customer._id}/payments`, { amount: 100, firstInvoice: true }), 201);
  const receiptEntry = await JournalEntry.findOne({ "source.type": "receipt" }).sort({ createdAt: -1 }).lean(); assert.ok(new Date(receiptEntry.date) >= todayStart);
  ok(await call("POST", `/api/credit-sales/${shop.credit._id}/payments`, { amount: 100 }), 201);
  ok(await call("POST", `/api/sellings/${shop.cash._id}/cancel`, { reason: "إلغاء فاتورة الشهر المقفول" }));
  const cancelEntries = await JournalEntry.find({ "source.type": "sale", "source.id": shop.cash._id, type: "reversal" }).lean();
  assert.ok(cancelEntries.length >= 1 && cancelEntries.every((entry) => new Date(entry.date) >= todayStart));
  ok(await call("POST", `${MANUAL}/${todayEntry._id}/reverse`, { reason: "عكس بتاريخ اليوم" }));
  // the closed month's figures did not change; this month carries the effects
  const october2 = ok(await call("GET", `/api/reports/income-statement?from=${FROM}&to=${TO}`));
  assert.equal(rowOf(october2, "410").amount, 37450 + 0); assert.equal(rowOf(october2, "420").amount, 650);
  const now = ok(await call("GET", `/api/reports/income-statement?from=${dayAfter(TO)}&to=${TODAY}`));
  // the cancel reversed the sale (and the return that came before it) in THIS month: October itself is untouched
  assert.equal(rowOf(now, "410").amount, -30000); assert.equal(rowOf(now, "420").amount, -400); assert.equal(rowOf(now, "430").amount, 0);
  // posting with no date, products and shifts (dated now) are unaffected by the lock
  await product({ code: "NEW1", stock: 3, cost: 10 });
  await assertHealthy();
});

it("price sync skips invoices dated in a closed period (their cost never changes)", async () => {
  const shop = await closedOctober();
  const before = (await ok(await call("GET", `/api/sellings/${shop.cash._id}`)).items[0].purchasePrice);
  ok(await call("PUT", `/api/products/${shop.a._id}`, { purchasePrice: 99, wholesalePrice: 200, retailPrice: 250, inventoryCount: 100 }));
  const result = ok(await call("POST", `/api/products/${shop.a._id}/sync-purchase-price`, {}));
  assert.equal(result.updatedInvoices, 0); assert.equal(result.skippedClosedPeriod, 1);
  assert.equal(ok(await call("GET", `/api/sellings/${shop.cash._id}`)).items[0].purchasePrice, before);
  await assertHealthy();
});

it("the pre-close checklist blocks: an open shift, an unposted draft dated in the period, a failing health check, unfiled VAT months, the opening not finalized", async () => {
  const shop = await october();
  const blockedKeys = async () => { const response = await closeNext(); assert.equal(response.status, 409, JSON.stringify(response.json)); assert.equal(response.json.code, "CHECKLIST_BLOCKED"); return response.json.checklist.blocking.filter((item) => !item.ok).map((item) => item.key); };
  assert.deepEqual(await blockedKeys(), ["openingNotFinalized"]);
  await finalizeOpening();
  // an open shift opened inside the period
  const drawer = ok(await call("POST", "/api/cashbox/boxes", { name: "درج ١", type: "cash" }), 201);
  const shift = ok(await call("POST", "/api/shifts", { boxId: drawer._id, openingFloat: 0 }), 201);
  const Shift = require("../src/models/shift.model");
  await Shift.updateOne({ _id: shift._id }, { $set: { openedAt: new Date(`${inLastMonth(20)}T10:00:00`) } });
  assert.deepEqual(await blockedKeys(), ["openShifts"]);
  assert.equal((await closingState()).checklist.blocking.find((item) => item.key === "openShifts").items[0].number, shift.number);
  ok(await call("POST", `/api/shifts/${shift._id}/close`, { counted: 0 }));
  // an unposted manual draft dated in the period
  const draft = await draftOf([{ accountId: await accountId("523"), debit: 5 }, { accountId: await accountId("23"), credit: 5 }], { date: inLastMonth(28) });
  assert.deepEqual(await blockedKeys(), ["manualDrafts"]);
  assert.equal((await call("DELETE", `${MANUAL}/${draft._id}`)).status, 204);
  // a failing health check
  const Product = require("../src/models/product.model");
  await Product.updateOne({ _id: shop.a._id }, { $inc: { inventoryCount: 1 } });
  assert.deepEqual(await blockedKeys(), ["health"]);
  assert.equal((await closingState()).checklist.blocking.find((item) => item.key === "health").items[0].name, "inventory");
  await Product.updateOne({ _id: shop.a._id }, { $inc: { inventoryCount: -1 } });
  // VAT on: the months of the period must be filed first
  ok(await call("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: true, rate: 14, pricesIncludeVat: true } }));
  const ShopProfile = require("../src/models/shopProfile.model");
  await ShopProfile.updateOne({ key: "default" }, { $set: { "vat.startDate": new Date(`${FROM}T00:00:00Z`) } });
  assert.deepEqual(await blockedKeys(), ["vatUnfiled"]);
  assert.deepEqual((await closingState()).checklist.blocking.find((item) => item.key === "vatUnfiled").items, [FROM.slice(0, 7)]);
  ok(await call("POST", `/api/vat/returns/${FROM.slice(0, 7)}/file`), 201);
  // nothing blocks now; the warnings say who still owes
  const state = await closingState();
  assert.equal(state.checklist.canClose, true); assert.equal(state.checklist.warnings.find((item) => item.key === "customerBalances").count, 1);
  assert.equal(state.checklist.warnings.find((item) => item.key === "customerBalances").total, 7200);
  ok(await closeNext());
  assert.equal(ok(await call("GET", "/api/accounting/lock-date")).lockedThrough, TO);
  await assertHealthy();
});

// the year of the year-end tests: two months of last year (November and December)
const LAST_YEAR = new Date().getFullYear() - 1;
async function lastYearShop() {
  await poorShop();
  const p = await product({ code: "YE", stock: 100, cost: 60 });
  await cashSale([{ productId: p._id, quantity: 10, price: 100 }], { sellingDate: `${LAST_YEAR}-11-10` });
  await expense("523", 100, `${LAST_YEAR}-12-15`);
  ok(await call("POST", "/api/cashbox/drawings", { amount: 50, date: `${LAST_YEAR}-12-20` }), 201);
  await finalizeOpening();
  return p;
}
const entryByNumber = async (number) => JournalEntry.findOne({ number }).lean();
const codesOf = async (entry) => Object.fromEntries(entry.lines.map((line) => [`${line.accountCode}${line.debit ? "D" : "C"}${entry.lines.filter((other) => other.accountCode === line.accountCode).length > 1 ? line.description : ""}`, line.debit || line.credit]));

it("year-end: the closing entry zeroes revenue, expenses and drawings into 32; last year's income statement keeps its profit, the new year starts at 0; health 0", async () => {
  await lastYearShop();
  const november = ok(await closeNext());
  assert.equal(november.close.yearEnd, false); assert.equal(november.entry, null);
  assert.equal(november.lockedThrough, `${LAST_YEAR}-11-30`);
  const state = await closingState();
  assert.equal(state.next.label, `${LAST_YEAR}-12`); assert.equal(state.next.yearEnd, true);
  const december = ok(await closeNext());
  assert.equal(december.close.yearEnd, true); assert.equal(december.close.netProfit, 300); assert.equal(december.lockedThrough, `${LAST_YEAR}-12-31`);
  assert.ok(december.entry.number.startsWith("JE-"));
  const entry = await entryByNumber(december.entry.number);
  assert.equal(entry.type, "closing"); assert.equal(entry.source.type, "period_close"); assert.equal(entry.date.toISOString().slice(0, 10), `${LAST_YEAR}-12-31`);
  assert.equal(entry.totalDebit, 1050); assert.equal(entry.totalCredit, 1050);
  const lines = {}; for (const line of entry.lines) lines[`${line.accountCode}${line.debit ? "D" : "C"}`] = (lines[`${line.accountCode}${line.debit ? "D" : "C"}`] || 0) + (line.debit || line.credit);
  assert.deepEqual(lines, { "410D": 1000, "510C": 600, "523C": 100, "33C": 50, "32C": 300, "32D": 50 });
  // every P&L account and the drawings are exactly zero at the year end; 32 holds the profit less the drawings
  const trial = ok(await call("GET", `/api/reports/trial-balance?from=${LAST_YEAR}-01-01&to=${LAST_YEAR}-12-31`));
  const leaf = (code) => flat(trial.rows).find((row) => row.code === code);
  for (const code of ["410", "510", "523", "33"]) { assert.equal(leaf(code).closingDebit, 0, code); assert.equal(leaf(code).closingCredit, 0, code); }
  assert.equal(leaf("32").closingCredit, 250);
  // last year's income statement does not see the closing entry; this year starts at 0
  const lastYear = ok(await call("GET", `/api/reports/income-statement?from=${LAST_YEAR}-01-01&to=${LAST_YEAR}-12-31`));
  assert.equal(rowOf(lastYear, "410").amount, 1000); assert.equal(rowOf(lastYear, "netProfit").amount, 300);
  const thisYear = ok(await call("GET", `/api/reports/income-statement?from=${LAST_YEAR + 1}-01-01&to=${TODAY}`));
  assert.equal(rowOf(thisYear, "410").amount, 0); assert.equal(rowOf(thisYear, "netProfit").amount, 0);
  // the balance sheet shows the profit inside 32, nothing as current-period profit, and balances
  const sheet = ok(await call("GET", `/api/reports/balance-sheet?asOf=${TODAY}`));
  assert.equal(sheet.check.difference, 0); assert.equal(sheet.periodProfit, 0);
  const equity = Object.fromEntries(flat(sheet.sections.equity.children).map((row) => [row.code || row.id, row.amount]));
  assert.equal(equity["32"], 250); assert.equal(equity["33"], 0);
  // as of the day before the year end the profit is still "current period"
  const before = ok(await call("GET", `/api/reports/balance-sheet?asOf=${LAST_YEAR}-12-30`));
  assert.equal(before.periodProfit, 300); assert.equal(before.check.difference, 0);
  // the history carries the entry
  const history = (await closingState()).history.find((row) => row.label === `${LAST_YEAR}-12`);
  assert.equal(history.entryNumber, december.entry.number); assert.equal(history.netProfit, 300);
  await assertHealthy();
  // a loss year: the profit line is a debit to 32 (checked on the next-year close below via a second shop)
});

it("year-end with a loss: the loss is debited to 32", async () => {
  await poorShop();
  await expense("523", 400, `${LAST_YEAR}-12-15`);
  await finalizeOpening();
  const body = ok(await closeNext()); // the first (and oldest) month with entries is that December: a year end
  assert.equal(body.close.yearEnd, true); assert.equal(body.close.netProfit, -400);
  const entry = await entryByNumber(body.entry.number);
  const sums = {}; for (const line of entry.lines) sums[`${line.accountCode}${line.debit ? "D" : "C"}`] = line.debit || line.credit;
  assert.deepEqual(sums, { "523C": 400, "32D": 400 });
  assert.equal(ok(await call("GET", `/api/reports/balance-sheet?asOf=${TODAY}`)).check.difference, 0);
  await assertHealthy();
});

it("reopen: owner only, a reason, only the latest closed period; the lock moves back and the year-end entry is reversed (linked); then it can be closed again", async () => {
  await lastYearShop();
  ok(await closeNext()); const december = ok(await closeNext());
  // permissions: a custom user with accounting.close is still not the owner
  const custom = ok(await call("POST", "/api/users", { name: "c", username: "closer22", password: "secret-pass-1", role: "custom", permissions: ["accounting.close", "accounting.view", "products.viewCost"] }), 201);
  const closer = await login("closer22", "secret-pass-1");
  assert.ok(custom);
  assert.equal((await as(closer, () => reopen())).json.code, "OWNER_ONLY");
  assert.equal((await call("POST", `${CLOSING}/reopen`, { confirm: true })).json.code, "REASON_REQUIRED");
  assert.equal((await call("POST", `${CLOSING}/reopen`, { reason: "سبب كافي" })).json.code, "CONFIRM_REQUIRED");
  const reopened = ok(await reopen("اكتشفنا فاتورة ناقصة"));
  assert.equal(reopened.lockedThrough, `${LAST_YEAR}-11-30`); assert.equal(reopened.reopened.status, "reopened"); assert.equal(reopened.reopened.reopenReason, "اكتشفنا فاتورة ناقصة");
  assert.ok(reopened.reversal.number.startsWith("JE-"));
  // the closing entry is reversed, linked both ways, and dated the year end: the P&L accounts are back as of that day
  const original = await entryByNumber(december.entry.number); const mirror = await entryByNumber(reopened.reversal.number);
  assert.equal(String(original.reversedBy), String(mirror._id)); assert.equal(String(mirror.reversalOf), String(original._id)); assert.equal(mirror.date.toISOString().slice(0, 10), `${LAST_YEAR}-12-31`);
  const trial = ok(await call("GET", `/api/reports/trial-balance?from=${LAST_YEAR}-01-01&to=${LAST_YEAR}-12-31`));
  const leaf = (code) => flat(trial.rows).find((row) => row.code === code);
  assert.equal(leaf("410").closingCredit, 1000); assert.equal(leaf("510").closingDebit, 600); assert.equal(leaf("33").closingDebit, 50); assert.equal(leaf("32").closingCredit, 0);
  const history = (await closingState()).history;
  assert.equal(history.find((row) => row.label === `${LAST_YEAR}-12`).status, "reopened"); assert.ok(history.find((row) => row.label === `${LAST_YEAR}-12`).reversalEntryId);
  assert.equal(ok(await call("GET", "/api/accounting/lock-date")).lockedThrough, `${LAST_YEAR}-11-30`);
  // the reopened month takes postings again
  ok(await call("POST", "/api/cashbox/drawings", { amount: 10, date: `${LAST_YEAR}-12-21` }), 201);
  await assertHealthy();
  // close again: a NEW closing entry, with the extra drawing
  const again = ok(await closeNext());
  assert.notEqual(again.entry.number, december.entry.number);
  const second = await entryByNumber(again.entry.number);
  assert.equal(second.lines.find((line) => line.accountCode === "33").credit, 60);
  await assertHealthy();
  // only the latest closed one reopens, one at a time, down to nothing
  ok(await reopen("الأخير")); ok(await reopen("اللي قبله"));
  assert.equal(ok(await call("GET", "/api/accounting/lock-date")).lockedThrough, null);
  assert.equal((await reopen("مفيش")).json.code, "NOTHING_TO_REOPEN");
  await assertHealthy();
});

it("yearly frequency: only a whole fiscal year closes, after it ended, with the year-end entry; the settings are the owner's and validated", async () => {
  await lastYearShop();
  // settings
  assert.equal(ok(await call("GET", "/api/shop-profile")).closing, undefined);
  assert.equal((await call("PUT", "/api/shop-profile", { name: "x", closing: { frequency: "weekly" } })).status, 400);
  assert.equal((await call("PUT", "/api/shop-profile", { name: "x", closing: { fiscalYearStartMonth: 13 } })).status, 400);
  assert.equal((await call("PUT", "/api/shop-profile", { name: "x", closing: { fiscalYearStartMonth: 1.5 } })).status, 400);
  const saved = ok(await call("PUT", "/api/shop-profile", { name: "x", closing: { frequency: "yearly" } }));
  assert.deepEqual(saved.closing, { frequency: "yearly", fiscalYearStartMonth: 1 });
  assert.deepEqual(ok(await call("GET", "/api/shop-profile")).closing, { frequency: "yearly", fiscalYearStartMonth: 1 });
  assert.equal((await call("PUT", "/api/shop-profile", { name: "x" })).status, 200); // a PUT without it keeps it
  assert.equal(ok(await call("GET", "/api/shop-profile")).closing.frequency, "yearly");
  const state = await closingState();
  assert.equal(state.next.label, `FY${LAST_YEAR}`); assert.equal(state.next.start, `${LAST_YEAR}-01-01`); assert.equal(state.next.end, `${LAST_YEAR}-12-31`); assert.equal(state.next.yearEnd, true);
  const done = ok(await closeNext());
  assert.equal(done.lockedThrough, `${LAST_YEAR}-12-31`); assert.equal(done.close.yearEnd, true); assert.ok(done.entry);
  // this year is the next period and it has not ended
  const next = await closingState();
  assert.equal(next.next.label, `FY${LAST_YEAR + 1}`); assert.equal(next.next.ended, false);
  assert.equal((await closeNext()).json.code, "PERIOD_NOT_ENDED");
  // the fiscal year start cannot move once a period was closed; the frequency can
  const move = await call("PUT", "/api/shop-profile", { name: "x", closing: { fiscalYearStartMonth: 7 } }); assert.equal(move.status, 409); assert.equal(move.json.code, "CLOSING_SETTINGS_LOCKED");
  assert.equal(ok(await call("PUT", "/api/shop-profile", { name: "x", closing: { frequency: "monthly" } })).closing.frequency, "monthly");
  await assertHealthy();
});

it("a fiscal year that starts in July: the period ending June 30 is the year end", async () => {
  await poorShop();
  const p = await product({ code: "JUL", stock: 50, cost: 10 });
  await cashSale([{ productId: p._id, quantity: 4, price: 25 }], { sellingDate: `${LAST_YEAR - 1}-09-10` });
  await finalizeOpening();
  ok(await call("PUT", "/api/shop-profile", { name: "x", closing: { frequency: "yearly", fiscalYearStartMonth: 7 } }));
  const state = await closingState();
  assert.equal(state.next.start, `${LAST_YEAR - 1}-07-01`); assert.equal(state.next.end, `${LAST_YEAR}-06-30`); assert.equal(state.next.yearEnd, true); assert.equal(state.next.label, `FY${LAST_YEAR}`);
  const done = ok(await closeNext());
  assert.equal(done.lockedThrough, `${LAST_YEAR}-06-30`); assert.equal(done.close.netProfit, 60);
  const entry = await entryByNumber(done.entry.number); assert.equal(entry.date.toISOString().slice(0, 10), `${LAST_YEAR}-06-30`);
  await assertHealthy();
});

it("closing health: an entry created after a close inside the closed period fails it, with the entry named (can-fail)", async () => {
  const shop = await closedOctober();
  const clean = await assertHealthy(); assert.equal(clean.closing.closes, 1); assert.equal(clean.closing.lockedThrough !== null, true);
  const bad = await JournalEntry.create({ number: "JE-LATE-1", date: new Date(`${inLastMonth(15)}T00:00:00Z`), type: "manual", source: { type: "manual", id: new mongoose.Types.ObjectId() }, totalDebit: 25, totalCredit: 25, memo: "x", lines: [
    { accountId: await accountId("523"), accountCode: "523", accountName: "u", accountNameAr: "ك", accountNameEn: "u", debit: 25 },
    { accountId: await accountId("23"), accountCode: "23", accountName: "a", accountNameAr: "م", accountNameEn: "a", credit: 25 },
  ] });
  const health = await healthOf();
  assert.equal(health.closing.difference, 25); assert.equal(health.closing.violations.length, 1); assert.equal(health.closing.violations[0].number, "JE-LATE-1");
  await JournalEntry.deleteOne({ _id: bad._id });
  assert.equal((await healthOf()).closing.difference, 0);
  assert.ok(shop);
});

it("closing health: a year-end closing entry that is gone leaves the P&L accounts non-zero at the year end (can-fail)", async () => {
  await lastYearShop();
  ok(await closeNext()); const december = ok(await closeNext());
  assert.equal((await healthOf()).closing.difference, 0);
  await JournalEntry.deleteOne({ number: december.entry.number });
  const report = await healthOf();
  assert.equal(report.closing.yearEnd.difference, 1750); assert.equal(report.closing.difference, 1750);
  assert.deepEqual(report.closing.yearEnd.byPeriod[0].accounts.map((row) => row.code).sort(), ["33", "410", "510", "523"]);
});

it("the lock date rides on login, /me and refresh only while a period is closed (the posting forms disable locked dates)", async () => {
  await october();
  assert.equal(ok(await call("GET", "/api/auth/me")).lockedThrough, undefined);
  assert.equal(ok(await call("POST", "/api/auth/login", { username: "stage22-owner", password: "owner-pass-123" })).lockedThrough, undefined);
  await finalizeOpening(); ok(await closeNext());
  assert.equal(ok(await call("GET", "/api/auth/me")).lockedThrough, TO);
  assert.equal(ok(await call("POST", "/api/auth/login", { username: "stage22-owner", password: "owner-pass-123" })).lockedThrough, TO);
  assert.equal(ok(await call("POST", "/api/auth/refresh")).lockedThrough, TO);
  ok(await reopen("اختبار")); assert.equal(ok(await call("GET", "/api/auth/me")).lockedThrough, undefined);
});

it("timing: the five reports over ~20,000 journal entries", async () => {
  await poorShop();
  const cash = await Account.findOne({ systemKey: "CASH_MAIN" }).lean(); const sales = await Account.findOne({ systemKey: "SALES" }).lean();
  const cogs = await Account.findOne({ systemKey: "COGS" }).lean(); const inventory = await Account.findOne({ systemKey: "INVENTORY" }).lean();
  const line = (account, side, amount) => ({ accountId: account._id, accountCode: account.code, accountName: account.nameEn, accountNameAr: account.nameAr, accountNameEn: account.nameEn, debit: side === "d" ? amount : 0, credit: side === "c" ? amount : 0 });
  const ENTRIES = 20000; let totalSales = 0; const docs = [];
  for (let index = 0; index < ENTRIES; index += 1) {
    const amount = (index % 97) + 1; totalSales += amount;
    docs.push({ number: `JE-T-${String(index).padStart(6, "0")}`, date: new Date(Date.UTC(LAST_YEAR, index % 12, (index % 27) + 1)), type: "auto", source: { type: "sale", id: new mongoose.Types.ObjectId() }, totalDebit: amount * 2, totalCredit: amount * 2, memo: "t",
      lines: [line(cash, "d", amount), line(sales, "c", amount), line(cogs, "d", amount), line(inventory, "c", amount)] });
  }
  for (let start = 0; start < docs.length; start += 2000) await JournalEntry.insertMany(docs.slice(start, start + 2000), { ordered: false });
  assert.equal(await JournalEntry.countDocuments() >= ENTRIES, true);
  const timings = {};
  const timed = async (name, path) => { const began = Date.now(); const response = await call("GET", path); timings[name] = Date.now() - began; assert.equal(response.status, 200); return response.json; };
  const income = await timed("income-statement", `/api/reports/income-statement?from=${LAST_YEAR}-01-01&to=${LAST_YEAR}-12-31&compare=1`);
  const balance = await timed("balance-sheet", `/api/reports/balance-sheet?asOf=${TODAY}`);
  const trial = await timed("trial-balance", `/api/reports/trial-balance?from=${LAST_YEAR}-03-01&to=${LAST_YEAR}-09-30`);
  const boxes = await timed("box-movements", `/api/reports/box-movements?from=${LAST_YEAR}-01-01&to=${LAST_YEAR}-12-31`);
  await timed("party-balances", "/api/reports/party-balances");
  console.log(`stage22 timing with ${ENTRIES} entries (ms): ${JSON.stringify(timings)}`);
  assert.equal(rowOf(income, "410").amount, totalSales); assert.equal(rowOf(income, "510").amount, totalSales);
  assert.equal(balance.check.difference, 0); assert.equal(trial.balanced, true);
  assert.equal(boxes.boxes.find((box) => box.isMain).in > 0, true);
  for (const [name, ms] of Object.entries(timings)) assert.ok(ms < 5000, `${name} took ${ms} ms`);
});
