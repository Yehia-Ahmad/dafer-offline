process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage23-test-secret-0123456789abcdef-0123456789";

// Stage 23: the print backend. POST /api/print/log (copy numbers + the document.printed audit) and the
// three print-data endpoints (receipt, purchase, stock list): permissions, stored numbers, cost hidden.

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const AuditLog = require("../src/models/auditLog.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const JournalEntry = require("../src/models/journalEntry.model");
const ManualEntryDraft = require("../src/models/manualEntryDraft.model");
const Meta = require("../src/models/meta.model");
const PeriodClose = require("../src/models/periodClose.model");
const PrintCount = require("../src/models/printCount.model");
const Supplier = require("../src/models/supplier.model");
const { runMigrations } = require("../src/migrations");
const { PREFIX_PERMISSIONS } = require("../src/controllers/print.controller");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { setClock } = require("../src/utils/clock");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27163 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage23-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
}
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };
const login = async (username, password) => ok(await call("POST", "/api/auth/login", { username, password })).token;
const makeUser = async (username, role, permissions) => {
  ok(await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return login(username, "secret-pass-1");
};
const as = async (userToken, fn) => { const previous = token; token = userToken; try { return await fn(); } finally { token = previous; } };
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await PeriodClose.deleteMany({}); await ManualEntryDraft.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const pad = (value) => String(value).padStart(2, "0");
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();

async function product({ code, stock = 100, cost = 20, category } = {}) {
  const cat = category || await Category.create({ name: `S23 ${code}` });
  return ok(await call("POST", "/api/products", { name: `منتج ${code}`, code, categoryId: String(cat._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 100 }), 201);
}

// Minimal real documents (only the number matters to the print log): one per prefix.
const { PREFIX_MODELS } = require("../src/controllers/print.controller");
const seedDocument = async (number) => { await PREFIX_MODELS[number.split("-")[0]].collection.insertOne({ number }); return number; };
const nextCopy = async (number, paper) => ok(await call("GET", `/api/print/next-copy?number=${number}${paper ? `&paper=${paper}` : ""}`)).copy;
const commit = async (number, paper) => ok(await call("POST", "/api/print/log", { number, paper })).copy;

it("print log: next-copy counts nothing; copy 0 is the first print, 1+ are reprints; each commit writes a document.printed audit entry with the real number", async () => {
  await seedDocument("INV-000125"); await seedDocument("INV-000126");
  assert.equal(await nextCopy("INV-000125", "80mm"), 0);
  assert.equal(await nextCopy("INV-000125", "80mm"), 0, "asking does not count");
  assert.equal(await PrintCount.countDocuments({}), 0);
  const first = ok(await call("POST", "/api/print/log", { number: "INV-000125", paper: "80mm" }));
  assert.equal(first.copy, 0);
  assert.equal(first.number, "INV-000125");
  assert.ok(!Number.isNaN(Date.parse(first.printedAt)));
  assert.equal(await nextCopy("INV-000125", "80mm"), 1);
  assert.equal(await commit("inv-000125", "80mm"), 1);
  assert.equal(await commit("INV-000125", "80mm"), 2);
  assert.equal(await commit("INV-000126", "80mm"), 0);
  const entries = await AuditLog.find({ action: "document.printed", entityId: "INV-000125" }).sort({ at: 1 }).lean();
  assert.deepEqual(entries.map((entry) => entry.details.copy), [0, 1, 2]);
  assert.equal(entries[0].userName, "Owner");
  assert.deepEqual({ number: entries[0].details.number, type: entries[0].details.type, paper: entries[0].details.paper, paperClass: entries[0].details.paperClass }, { number: "INV-000125", type: "INV", paper: "80mm", paperClass: "receipt" });
  assert.equal((await PrintCount.findById("INV-000125|receipt").lean()).count, 3);
});

it("print log: a receipt and a page are separate counters (an A4 print does not make the next 80mm receipt a copy); a PDF counts in its paper's class", async () => {
  await seedDocument("INV-000130");
  assert.equal(await commit("INV-000130", "A4"), 0);
  assert.equal(await commit("INV-000130", "A5"), 1, "A4 and A5 share the page counter (a PDF of an A4 document is a page print)");
  assert.equal(await nextCopy("INV-000130", "80mm"), 0, "the receipt was never printed");
  assert.equal(await commit("INV-000130", "80mm"), 0);
  assert.equal(await nextCopy("INV-000130", "A4"), 2);
  assert.equal(await nextCopy("INV-000130", "80mm"), 1);
  assert.equal(await commit("INV-000130"), 2, "no paper given: counted as a page");
  const audit = await AuditLog.find({ action: "document.printed", entityId: "INV-000130" }).lean();
  assert.equal(audit.filter((entry) => entry.details.paperClass === "page").length, 3);
});

it("print log: a cancelled dialog logs nothing (the page never commits): counters and audit stay empty however often the next number is asked", async () => {
  await seedDocument("RC-000020");
  for (let i = 0; i < 3; i += 1) assert.equal(await nextCopy("RC-000020", "80mm"), 0);
  assert.equal(await PrintCount.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({ action: "document.printed" }), 0);
});

it("print log: parallel commits each get a distinct real copy number, the audit records those numbers and the counter ends at the number of commits", async () => {
  await seedDocument("RC-000007");
  const answers = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/api/print/log", { number: "RC-000007", paper: "80mm" })));
  const copies = answers.map((answer) => ok(answer).copy).sort((a, b) => a - b);
  assert.deepEqual(copies, [0, 1, 2, 3, 4, 5, 6, 7]);
  const audited = (await AuditLog.find({ action: "document.printed", entityId: "RC-000007" }).lean()).map((entry) => entry.details.copy).sort((a, b) => a - b);
  assert.deepEqual(audited, copies);
  assert.equal(await nextCopy("RC-000007", "80mm"), 8);
});

it("print log: a document that does not exist is 404 DOCUMENT_NOT_FOUND on both endpoints and is never counted", async () => {
  const missing = await call("POST", "/api/print/log", { number: "INV-000999", paper: "80mm" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "DOCUMENT_NOT_FOUND");
  const next = await call("GET", "/api/print/next-copy?number=CR-000999&paper=A4");
  assert.equal(next.status, 404);
  assert.equal(next.json.code, "DOCUMENT_NOT_FOUND");
  assert.equal(await PrintCount.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({ action: "document.printed" }), 0);
  // the prefix decides the collection: an INV number that exists only as a CR is still not found
  await seedDocument("CR-000010");
  assert.equal((await call("POST", "/api/print/log", { number: "INV-000010" })).status, 404);
  assert.equal((await call("POST", "/api/print/log", { number: "CR-000010" })).status, 200);
});

it("print log refuses bad numbers and needs the document's permission (cashier: sales and receipts yes, journal/purchase/drawing no)", async () => {
  for (const number of ["", "INV", "INV-1", "XX-000001", "INV-000001; DROP", 5, null]) {
    assert.equal((await call("POST", "/api/print/log", { number })).status, 400, String(number));
    assert.equal((await call("GET", `/api/print/next-copy?number=${encodeURIComponent(String(number))}`)).status, 400, String(number));
  }
  assert.equal((await call("POST", "/api/print/log", {})).status, 400);
  for (const prefix of ["INV", "CR", "RC", "RT", "SH", "CP", "PO", "PV", "JE", "DR", "VP", "EX"]) await seedDocument(`${prefix}-000001`);
  const cashier = await makeUser("cashier23", "cashier");
  const status = async (number) => (await as(cashier, () => call("POST", "/api/print/log", { number }))).status;
  for (const number of ["INV-000001", "CR-000001", "RC-000001", "RT-000001", "SH-000001", "CP-000001"]) assert.equal(await status(number), 200, number);
  for (const number of ["PO-000001", "PV-000001", "JE-000001", "DR-000001", "VP-000001", "EX-000001"]) {
    if (ROLE_TEMPLATES.cashier.some((key) => PREFIX_PERMISSIONS[number.split("-")[0]].includes(key))) continue;
    assert.equal(await status(number), 403, number);
    assert.equal((await as(cashier, () => call("GET", `/api/print/next-copy?number=${number}`))).status, 403, number);
  }
  assert.equal(await PrintCount.countDocuments({ number: { $in: ["PO-000001", "JE-000001", "DR-000001"] } }), 0, "a refused print is not counted");
  const accountant = await makeUser("accountant23", "accountant");
  assert.equal((await as(accountant, () => call("POST", "/api/print/log", { number: "JE-000001" }))).status, 200);
  token = null;
  assert.equal((await call("POST", "/api/print/log", { number: "INV-000001" })).status, 401);
  assert.equal((await call("GET", "/api/print/next-copy?number=INV-000001")).status, 401);
});

it("receipt print-data: the receipt, its invoices and the customer balance before and after are the statement's stored numbers", async () => {
  await startLedger();
  const p = await product({ code: "R1", stock: 50, cost: 10 });
  const customer = ok(await call("POST", "/api/customers", { name: "عميل الإيصال", phone: "01012345678", taxNumber: "123-456-789" }), 201);
  const sale = ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: [{ productId: p._id, quantity: 10, price: 100 }] }), 201);
  const paid = ok(await call("POST", `/api/customers/${customer._id}/payments`, { amount: 300, firstInvoice: true }), 201);
  const receiptNumber = paid.receipt?.number || paid.number || paid.receiptNumber;
  assert.ok(receiptNumber, JSON.stringify(paid));
  const data = ok(await call("GET", `/api/customers/${customer._id}/receipts/${receiptNumber}/print-data`));
  assert.equal(data.receipt.number, receiptNumber);
  assert.equal(data.receipt.amount, 300);
  assert.equal(data.receipt.createdByName, "Owner");
  assert.equal(data.customer.name, "عميل الإيصال");
  assert.equal(data.customer.taxNumber, "123-456-789");
  assert.deepEqual(data.receipt.allocations.map((row) => [row.invoiceNumber, row.amount]), [[sale.number, 300]]);
  assert.equal(data.balanceBefore, 1000);
  assert.equal(data.balanceAfter, 700);
  const statement = ok(await call("GET", `/api/customers/${customer._id}/statement`));
  const line = statement.lines.find((row) => row.number === receiptNumber);
  assert.equal(data.balanceAfter, line.balance, "the same running balance the statement shows");
  // a later payment does not change an earlier receipt's balances
  ok(await call("POST", `/api/customers/${customer._id}/payments`, { amount: 100, lastInvoice: true }), 201);
  const again = ok(await call("GET", `/api/customers/${customer._id}/receipts/${receiptNumber}/print-data`));
  assert.deepEqual([again.balanceBefore, again.balanceAfter], [1000, 700]);
  assert.equal((await call("GET", `/api/customers/${customer._id}/receipts/RC-999999/print-data`)).status, 404);
  const storekeeper = await makeUser("keeper23", "storekeeper");
  assert.equal((await as(storekeeper, () => call("GET", `/api/customers/${customer._id}/receipts/${receiptNumber}/print-data`))).status, 403);
  const cashier = await makeUser("cashier23b", "cashier");
  assert.equal((await as(cashier, () => call("GET", `/api/customers/${customer._id}/receipts/${receiptNumber}/print-data`))).status, 200);
});

it("purchase print-data: supplier balance before/after, the journal entry number and lines; lines need accounting.view", async () => {
  await startLedger();
  const supplier = await Supplier.create({ name: "الشركة المصرية للإضاءة", paymentTermsDays: 30, taxNumber: "555" });
  ok(await call("POST", "/api/accounting/opening", { cash: 18400, suppliers: [{ supplierId: String(supplier._id), amount: 4200 }] }));
  const main = (await call("GET", "/api/cashbox/boxes")).json.data.find((box) => box.isMain);
  const a = await product({ code: "P1", stock: 0, cost: 28 });
  const b = await product({ code: "P2", stock: 0, cost: 120 });
  const purchase = ok(await call("POST", "/api/purchases", { supplierId: String(supplier._id), supplierInvoiceNo: "EL-8841", date: TODAY, items: [{ productId: a._id, qty: 50, unitPrice: 28 }, { productId: b._id, qty: 20, unitPrice: 120 }], paidAmount: 1000, boxId: main._id }), 201);
  const data = ok(await call("GET", `/api/purchases/${purchase._id}/print-data`));
  assert.equal(data.purchase.number, purchase.number);
  assert.equal(data.purchase.total, 3800);
  assert.equal(data.supplier.name, "الشركة المصرية للإضاءة");
  assert.equal(data.balanceBefore, 4200);
  assert.equal(data.balanceAfter, 4200 + 3800 - 0 - 1000, "the purchase adds 3,800, the payment with it takes 1,000");
  const entry = await JournalEntry.findOne({ "source.type": "purchase", "source.id": purchase._id, type: "auto" }).lean();
  assert.equal(data.journal.number, entry.number);
  assert.equal(data.journal.lines.length, entry.lines.length);
  assert.equal(data.journal.lines.reduce((sum, row) => sum + row.debit, 0), entry.totalDebit);
  assert.equal(data.boxName, main.name);
  assert.equal((await call("GET", `/api/purchases/${new mongoose.Types.ObjectId()}/print-data`)).status, 404);
  const keeper = await makeUser("keeper23b", "storekeeper");
  const limited = ok(await as(keeper, () => call("GET", `/api/purchases/${purchase._id}/print-data`)));
  assert.equal(limited.journal.number, entry.number);
  assert.equal(limited.journal.lines, null, "journal lines need accounting.view");
  const cashier = await makeUser("cashier23c", "cashier");
  assert.equal((await as(cashier, () => call("GET", `/api/purchases/${purchase._id}/print-data`))).status, 403);
});

it("stock print-data: by category then name, low stock flagged, cost only with products.viewCost, a cashier gets no cost", async () => {
  const lights = await Category.create({ name: "إضاءة" });
  const cables = await Category.create({ name: "أسلاك" });
  await product({ code: "L1", stock: 2, cost: 30, category: lights });
  await product({ code: "L2", stock: 40, cost: 35, category: lights });
  await product({ code: "C1", stock: 7, cost: 12, category: cables });
  const all = ok(await call("GET", "/api/products/print-data"));
  assert.equal(all.count, 3);
  assert.deepEqual(all.products.map((row) => row.code), ["C1", "L1", "L2"], "أسلاك before إضاءة");
  assert.deepEqual(all.products.map((row) => row.lowStock), [false, true, false]);
  assert.equal(all.products[0].purchasePrice, 12);
  const one = ok(await call("GET", `/api/products/print-data?categoryId=${lights._id}`));
  assert.deepEqual(one.products.map((row) => row.code), ["L1", "L2"]);
  assert.equal((await call("GET", "/api/products/print-data?categoryId=nope")).status, 400);
  const cashier = await makeUser("cashier23d", "cashier");
  const seen = ok(await as(cashier, () => call("GET", "/api/products/print-data")));
  assert.equal(seen.count, 3);
  assert.ok(seen.products.every((row) => !("purchasePrice" in row)), "no cost for a user without products.viewCost");
  assert.ok(seen.products.every((row) => typeof row.retailPrice === "number"));
  const nobody = await makeUser("custom23", "custom", ["sales.view"]);
  assert.equal((await as(nobody, () => call("GET", "/api/products/print-data"))).status, 403);
});

it("journal-ref: a voucher's journal entry number, with the permission of the document (a cashier cannot ask for a drawing or a journal entry)", async () => {
  await startLedger();
  const p = await product({ code: "J1", stock: 5, cost: 10 });
  const customer = ok(await call("POST", "/api/customers", { name: "عميل القيد", phone: "01011112222" }), 201);
  ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: [{ productId: p._id, quantity: 2, price: 100 }] }), 201);
  const paid = ok(await call("POST", `/api/customers/${customer._id}/payments`, { amount: 50, firstInvoice: true }), 201);
  const number = paid.receipt?.number || paid.number || paid.receiptNumber;
  const entry = await JournalEntry.findOne({ "source.number": number, type: "auto" }).lean();
  assert.ok(entry, "the receipt posted an entry");
  const ref = ok(await call("GET", `/api/print/journal-ref/${number}`));
  assert.deepEqual(ref, { number, journalNumber: entry.number });
  assert.equal(ok(await call("GET", "/api/print/journal-ref/RC-999999")).journalNumber, null);
  assert.equal((await call("GET", "/api/print/journal-ref/NOPE")).status, 400);
  const cashier = await makeUser("cashier23e", "cashier");
  assert.equal((await as(cashier, () => call("GET", `/api/print/journal-ref/${number}`))).status, 200);
  assert.equal((await as(cashier, () => call("GET", "/api/print/journal-ref/DR-000001"))).status, 403);
  assert.equal((await as(cashier, () => call("GET", "/api/print/journal-ref/JE-000001"))).status, 403);
});

it("shift close report: the sales summary (cash invoices, credit invoices, cash returns, discounts) comes from the same documents as the expected cash, is stored at close and never changes", async () => {
  await startLedger();
  const drawer = ok(await call("POST", "/api/cashbox/boxes", { name: "درج 1", type: "cash", shiftsEnabled: true }), 201);
  const p = await product({ code: "SH1", stock: 100, cost: 10 });
  const customer = ok(await call("POST", "/api/customers", { name: "عميل الوردية", phone: "01033334444" }), 201);
  const shift = ok(await call("POST", "/api/shifts", { boxId: drawer._id, openingFloat: 0 }), 201);
  const sale = async (quantity, price, extra = {}) => ok(await call("POST", "/api/sellings", { customerName: "نقدي", customerPhone: "01017171718", sellingDate: TODAY, boxId: drawer._id, items: [{ productId: p._id, quantity, price }], ...extra }), 201);
  const first = await sale(2, 50);
  await sale(3, 40, { discountAmount: 20 });
  ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: [{ productId: p._id, quantity: 4, price: 25 }] }), 201);
  ok(await call("POST", "/api/credit-sales", { customerId: String(customer._id), sellingDate: TODAY, items: [{ productId: p._id, quantity: 1, price: 25 }] }), 201);
  ok(await call("POST", "/api/returns", { returnType: "cash", invoiceId: first._id, boxId: drawer._id, returnDate: TODAY, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] }), 201);
  const live = ok(await call("GET", `/api/shifts/${shift._id}`));
  const salesLine = live.lines.find((row) => row.key === "sales").amount;
  const refundsLine = live.lines.find((row) => row.key === "refunds").amount;
  assert.deepEqual(live.salesSummary.cash, { count: 2, total: salesLine });
  assert.equal(salesLine, 100 + (120 - 20));
  assert.deepEqual(live.salesSummary.credit, { count: 2, total: 125 });
  assert.deepEqual(live.salesSummary.returns, { count: 1, total: 50 });
  assert.equal(refundsLine, 50, "the refunds line is the same return");
  assert.equal(live.salesSummary.discounts, 20);
  const closed = ok(await call("POST", `/api/shifts/${shift._id}/close`, { counted: live.expected }));
  assert.deepEqual(closed.salesSummary, live.salesSummary);
  // a sale into the drawer is refused once its shift is closed; one into the main box never touches this report
  const before = ok(await call("GET", `/api/shifts/${shift._id}`));
  assert.equal((await call("POST", "/api/sellings", { customerName: "x", customerPhone: "01017171718", sellingDate: TODAY, boxId: drawer._id, items: [{ productId: p._id, quantity: 1, price: 10 }] })).json.code, "NO_OPEN_SHIFT");
  const main = (await call("GET", "/api/cashbox/boxes")).json.data.find((box) => box.isMain);
  await sale(1, 10, { boxId: main._id });
  const after = ok(await call("GET", `/api/shifts/${shift._id}`));
  assert.deepEqual(after.salesSummary, before.salesSummary);
  assert.deepEqual(after.salesSummary, live.salesSummary);
  // an old closed shift without a stored summary is read once from its documents up to the close cut
  const Shift = require("../src/models/shift.model");
  await Shift.updateOne({ _id: shift._id }, { $unset: { salesSummary: 1 } });
  const rebuilt = ok(await call("GET", `/api/shifts/${shift._id}`));
  assert.deepEqual(rebuilt.salesSummary, live.salesSummary);
});

it("supplier refunds list carries the box name, for the SR voucher; the statement line has the same number and the balance after it", async () => {
  await startLedger();
  const supplier = await Supplier.create({ name: "مورد الاسترداد", paymentTermsDays: 30 });
  ok(await call("POST", "/api/accounting/opening", { cash: 5000 }));
  const main = (await call("GET", "/api/cashbox/boxes")).json.data.find((box) => box.isMain);
  ok(await call("POST", `/api/suppliers/${supplier._id}/payments`, { amount: 1000, boxId: main._id, confirmAdvance: true }), 201);
  const refund = ok(await call("POST", `/api/suppliers/${supplier._id}/refunds`, { amount: 300, boxId: main._id, note: "رد جزء" }), 201);
  const list = ok(await call("GET", `/api/suppliers/${supplier._id}/refunds`));
  assert.equal(list.data.length, 1);
  assert.deepEqual([list.data[0].number, list.data[0].amount, list.data[0].boxName, list.data[0].status, list.data[0].note], [refund.number, 300, main.name, "posted", "رد جزء"]);
  const statement = ok(await call("GET", `/api/suppliers/${supplier._id}/statement`));
  const line = statement.lines.find((row) => row.type === "supplier_refund");
  assert.equal(line.number, refund.number);
  assert.equal(line.credit, 300);
  assert.equal(line.balance, -700, "advance 1,000 - 300 refunded = we are owed 700");
  const cashier = await makeUser("cashier23sr", "cashier");
  assert.equal((await as(cashier, () => call("POST", "/api/print/log", { number: refund.number }))).status, 403, "SR needs suppliers.view / suppliers.pay");
  const accountant = await makeUser("acc23sr", "accountant");
  assert.equal((await as(accountant, () => call("POST", "/api/print/log", { number: refund.number }))).json.copy, 0);
});
