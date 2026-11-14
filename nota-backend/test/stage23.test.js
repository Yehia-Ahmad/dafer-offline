process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage23-test-secret-0123456789abcdef-0123456789";

// Stage 23: the print backend. POST /api/print/reserve|confirm|release (copy numbers + the document.printed audit) and the
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

// Minimal real documents (only the number matters to the print endpoints): one per prefix.
const { PREFIX_MODELS } = require("../src/controllers/print.controller");
const PrintReservation = require("../src/models/printReservation.model");
const seedDocument = async (number) => { await PREFIX_MODELS[number.split("-")[0]].collection.insertOne({ number }); return number; };
const reserve = (number, paperClass = "page") => call("POST", "/api/print/reserve", { number, paperClass });
const reserved = async (number, paperClass = "page") => ok(await reserve(number, paperClass), 201);
const confirm = (reservationId) => call("POST", "/api/print/confirm", { reservationId });
const release = (reservationId) => call("POST", "/api/print/release", { reservationId });
const counterOf = async (number, paperClass = "page") => (await PrintCount.findById(`${number}|${paperClass}`).lean())?.count ?? 0;
const auditOf = (action, number) => AuditLog.find({ action, entityId: number }).sort({ at: 1 }).lean();

it("print reserve: copy 1 is the original, 2+ are reprints; confirm writes ONE document.printed audit entry with the copy number, user, type and paper class", async () => {
  await seedDocument("INV-000125"); await seedDocument("INV-000126");
  const first = await reserved("INV-000125", "receipt");
  assert.equal(first.copyNo, 1);
  assert.equal(first.number, "INV-000125");
  assert.equal(first.paperClass, "receipt");
  assert.equal((await auditOf("document.printed", "INV-000125")).length, 0, "a reserve alone writes no printed audit");
  const confirmed = ok(await confirm(first.reservationId));
  assert.equal(confirmed.copyNo, 1);
  const second = await reserved("inv-000125".toUpperCase(), "receipt");
  assert.equal(second.copyNo, 2);
  ok(await confirm(second.reservationId));
  assert.equal((await reserved("INV-000126", "receipt")).copyNo, 1, "another document starts at 1");
  const entries = await auditOf("document.printed", "INV-000125");
  assert.deepEqual(entries.map((entry) => entry.details.copy), [1, 2]);
  assert.equal(entries[0].userName, "Owner");
  assert.deepEqual({ number: entries[0].details.number, type: entries[0].details.type, paperClass: entries[0].details.paperClass }, { number: "INV-000125", type: "INV", paperClass: "receipt" });
  assert.equal(await counterOf("INV-000125", "receipt"), 2);
  const stored = await PrintReservation.findById(first.reservationId).lean();
  assert.equal(stored.status, "printed");
  assert.equal(stored.key, "INV-000125|receipt");
});

it("print reserve: two parallel reserves get copy numbers 1 and 2: exactly one original", async () => {
  await seedDocument("RC-000007");
  const answers = await Promise.all([reserve("RC-000007", "receipt"), reserve("RC-000007", "receipt")]);
  const copies = answers.map((answer) => ok(answer, 201).copyNo).sort();
  assert.deepEqual(copies, [1, 2]);
  const many = await Promise.all(Array.from({ length: 8 }, () => reserve("RC-000007", "page")));
  assert.deepEqual(many.map((answer) => ok(answer, 201).copyNo).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

it("print release: reserve + release with nobody after it gives the number back (the next reserve is 1 again)", async () => {
  await seedDocument("INV-000130");
  const a = await reserved("INV-000130");
  assert.equal(a.copyNo, 1);
  const released = ok(await release(a.reservationId));
  assert.equal(released.gaveBack, true);
  assert.equal(await counterOf("INV-000130"), 0);
  assert.equal((await reserved("INV-000130")).copyNo, 1, "still the original");
  assert.equal((await auditOf("document.print_cancelled", "INV-000130")).length, 0, "nothing to explain");
  assert.equal((await PrintReservation.findById(a.reservationId).lean()).status, "released");
});

it("print release: reserve A, reserve B, release A: the counter stays 2 (a gap) and a document.print_cancelled audit explains it", async () => {
  await seedDocument("INV-000131");
  const a = await reserved("INV-000131");
  const b = await reserved("INV-000131");
  assert.deepEqual([a.copyNo, b.copyNo], [1, 2]);
  const released = ok(await release(a.reservationId));
  assert.equal(released.gaveBack, false);
  assert.equal(await counterOf("INV-000131"), 2);
  const cancelled = await auditOf("document.print_cancelled", "INV-000131");
  assert.equal(cancelled.length, 1);
  assert.deepEqual({ copy: cancelled[0].details.copy, paperClass: cancelled[0].details.paperClass, number: cancelled[0].details.number }, { copy: 1, paperClass: "page", number: "INV-000131" });
  ok(await confirm(b.reservationId));
  assert.equal((await reserved("INV-000131")).copyNo, 3);
});

it("print release, accepted over-count: reserve A, reserve B, release A, release B: the counter stays at 1 and the next print is copy 2 (nothing was printed; there is no cascade over the older released row)", async () => {
  await seedDocument("INV-000132");
  const a = await reserved("INV-000132"); const b = await reserved("INV-000132");
  assert.equal(ok(await release(a.reservationId)).gaveBack, false);
  assert.equal(ok(await release(b.reservationId)).gaveBack, true, "B was the top number: it goes back by one");
  assert.equal(await counterOf("INV-000132"), 1, "A's gap stays");
  assert.equal((await reserved("INV-000132")).copyNo, 2, "the next print is marked as a copy: an over-count, the safe side");
  assert.equal((await auditOf("document.print_cancelled", "INV-000132")).length, 1, "the gap of A is explained");
});

it("print release, scenario A: A reserves 1 and releases; B reserves 1 and confirms; C reserves 2 and releases: the next reserve is 2, never 1", async () => {
  await seedDocument("INV-000136");
  const a = await reserved("INV-000136");
  assert.equal(a.copyNo, 1);
  ok(await release(a.reservationId));
  const b = await reserved("INV-000136");
  assert.equal(b.copyNo, 1, "A gave the original back");
  ok(await confirm(b.reservationId));
  const c = await reserved("INV-000136");
  assert.equal(c.copyNo, 2);
  assert.equal(ok(await release(c.reservationId)).gaveBack, true);
  assert.equal(await counterOf("INV-000136"), 1);
  const next = await reserved("INV-000136");
  assert.equal(next.copyNo, 2, "never 1: the original was printed by B");
});

it("print release, scenario B: a number that was issued again and printed is never given back by a stale release of the older reservation", async () => {
  await seedDocument("INV-000137");
  const a = await reserved("INV-000137");
  const b = await reserved("INV-000137");
  assert.deepEqual([a.copyNo, b.copyNo], [1, 2]);
  assert.equal(ok(await release(b.reservationId)).gaveBack, true);
  const c = await reserved("INV-000137");
  assert.equal(c.copyNo, 2, "number 2 is issued again");
  ok(await confirm(c.reservationId));
  const again = ok(await release(b.reservationId));
  assert.equal(again.alreadyReleased, true);
  assert.equal(await counterOf("INV-000137"), 2, "the stale release changed nothing");
  assert.equal(ok(await release(a.reservationId)).gaveBack, false, "A is below the top: the gap stays");
  assert.equal(await counterOf("INV-000137"), 2);
  assert.equal((await reserved("INV-000137")).copyNo, 3);
  assert.equal((await PrintReservation.findById(c.reservationId).lean()).status, "printed");
  assert.equal((await release(c.reservationId)).status, 409, "a printed number cannot be released");
});

it("print reservations: a unique partial index (key, copyNo) for reserved / printed rows stops two live reservations from holding one number, and allows a released one next to it", async () => {
  await PrintReservation.createIndexes(); // autoIndex is off for this model: ensureIndexes() builds it on startup
  const base = { key: "INV-000138|page", number: "INV-000138", paperClass: "page", copyNo: 1 };
  await PrintReservation.create({ ...base, status: "released" });
  await PrintReservation.create({ ...base, status: "reserved" });
  await assert.rejects(() => PrintReservation.create({ ...base, status: "printed" }), (error) => error.code === 11000);
  await PrintReservation.create({ ...base, status: "released" });
});

it("print confirm is idempotent: a retry answers the same and writes no second audit entry; release is idempotent too", async () => {
  await seedDocument("INV-000133");
  const a = await reserved("INV-000133");
  const first = ok(await confirm(a.reservationId));
  const retry = ok(await confirm(a.reservationId));
  assert.equal(first.alreadyConfirmed, false);
  assert.equal(retry.alreadyConfirmed, true);
  assert.equal(retry.copyNo, 1);
  assert.equal((await auditOf("document.printed", "INV-000133")).length, 1);
  await seedDocument("INV-000134");
  const b = await reserved("INV-000134");
  ok(await release(b.reservationId));
  assert.equal(ok(await release(b.reservationId)).alreadyReleased, true);
  assert.equal(await counterOf("INV-000134"), 0, "the second release does not decrement again");
  const parallel = await reserved("INV-000133");
  await Promise.all([confirm(parallel.reservationId), confirm(parallel.reservationId)]);
  assert.equal((await auditOf("document.printed", "INV-000133")).length, 2, "two simultaneous confirms of one reservation write one entry");
});

it("print reservations belong to their user: another user cannot confirm or release them; release after confirm is 409; confirm after release is 409", async () => {
  await seedDocument("INV-000140");
  const a = await reserved("INV-000140");
  const cashier = await makeUser("cashier23r", "cashier");
  assert.equal((await as(cashier, () => confirm(a.reservationId))).status, 403);
  assert.equal((await as(cashier, () => release(a.reservationId))).status, 403);
  assert.equal((await PrintReservation.findById(a.reservationId).lean()).status, "reserved", "untouched by the other user");
  assert.equal(await counterOf("INV-000140"), 1);
  ok(await confirm(a.reservationId));
  const afterConfirm = await release(a.reservationId);
  assert.equal(afterConfirm.status, 409);
  assert.equal(afterConfirm.json.code, "RESERVATION_PRINTED");
  assert.equal(await counterOf("INV-000140"), 1, "a printed number is never given back");
  const b = await reserved("INV-000140");
  ok(await release(b.reservationId));
  const afterRelease = await confirm(b.reservationId);
  assert.equal(afterRelease.status, 409);
  assert.equal(afterRelease.json.code, "RESERVATION_RELEASED");
  assert.equal((await call("POST", "/api/print/confirm", { reservationId: "nope" })).status, 400);
  assert.equal((await call("POST", "/api/print/release", { reservationId: String(new mongoose.Types.ObjectId()) })).status, 404);
});

it("print reserve: a receipt and a page are separate counters (an A4 print does not make the next 80mm receipt a copy)", async () => {
  await seedDocument("INV-000150");
  assert.equal((await reserved("INV-000150", "page")).copyNo, 1);
  assert.equal((await reserved("INV-000150", "page")).copyNo, 2);
  assert.equal((await reserved("INV-000150", "receipt")).copyNo, 1, "the receipt was never printed");
  assert.equal(await counterOf("INV-000150", "page"), 2);
  assert.equal(await counterOf("INV-000150", "receipt"), 1);
  assert.equal((await call("POST", "/api/print/reserve", { number: "INV-000150", paperClass: "A4" })).status, 400, "the class is receipt or page");
});

it("print reserve: a reservation that is never confirmed nor released (a crash) stays counted: the next print is a copy (an over-count, the safe side)", async () => {
  await seedDocument("INV-000160");
  await reserved("INV-000160");
  assert.equal((await reserved("INV-000160")).copyNo, 2);
  assert.equal(await counterOf("INV-000160"), 2);
});

it("print reserve: a document that does not exist is 404 DOCUMENT_NOT_FOUND and is never counted", async () => {
  const missing = await reserve("INV-000999", "receipt");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "DOCUMENT_NOT_FOUND");
  assert.equal(await PrintCount.countDocuments({}), 0);
  assert.equal(await PrintReservation.countDocuments({}), 0);
  // the prefix decides the collection: an INV number that exists only as a CR is still not found
  await seedDocument("CR-000010");
  assert.equal((await reserve("INV-000010")).status, 404);
  assert.equal((await reserve("CR-000010")).status, 201);
  assert.equal((await call("POST", "/api/print/reserve", { number: "CR-000010", prefix: "INV", paperClass: "page" })).status, 400, "a prefix that does not match the number");
});

it("print reserve refuses bad numbers and needs the document's permission (cashier: sales and receipts yes, journal/purchase/drawing no)", async () => {
  for (const number of ["", "INV", "INV-1", "XX-000001", "INV-000001; DROP", 5, null]) {
    assert.equal((await reserve(number)).status, 400, String(number));
  }
  assert.equal((await call("POST", "/api/print/reserve", {})).status, 400);
  for (const prefix of ["INV", "CR", "RC", "RT", "SH", "CP", "PO", "PV", "JE", "DR", "VP", "EX"]) await seedDocument(`${prefix}-000001`);
  const cashier = await makeUser("cashier23", "cashier");
  const status = async (number) => (await as(cashier, () => reserve(number))).status;
  for (const number of ["INV-000001", "CR-000001", "RC-000001", "RT-000001", "SH-000001", "CP-000001"]) assert.equal(await status(number), 201, number);
  for (const number of ["PO-000001", "PV-000001", "JE-000001", "DR-000001", "VP-000001", "EX-000001"]) {
    if (ROLE_TEMPLATES.cashier.some((key) => PREFIX_PERMISSIONS[number.split("-")[0]].includes(key))) continue;
    assert.equal(await status(number), 403, number);
  }
  assert.equal(await PrintCount.countDocuments({ number: { $in: ["PO-000001", "JE-000001", "DR-000001"] } }), 0, "a refused reserve is not counted");
  const accountant = await makeUser("accountant23", "accountant");
  assert.equal((await as(accountant, () => reserve("JE-000001"))).status, 201);
  token = null;
  assert.equal((await reserve("INV-000001")).status, 401);
  assert.equal((await confirm("x")).status, 401);
  assert.equal((await release("x")).status, 401);
});

it("the old print endpoints are gone: GET /api/print/next-copy and POST /api/print/log", async () => {
  await seedDocument("INV-000170");
  assert.equal((await call("GET", "/api/print/next-copy?number=INV-000170&paper=A4")).status, 404);
  assert.equal((await call("POST", "/api/print/log", { number: "INV-000170", paper: "A4" })).status, 404);
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
  assert.equal((await as(cashier, () => call("POST", "/api/print/reserve", { number: refund.number, paperClass: "page" }))).status, 403, "SR needs suppliers.view / suppliers.pay");
  const accountant = await makeUser("acc23sr", "accountant");
  assert.equal((await as(accountant, () => call("POST", "/api/print/reserve", { number: refund.number, paperClass: "page" }))).json.copyNo, 1);
});

// ---- the printreservations index upgrade (migration 11)
const { ensureIndexes } = require("../src/config/db");
const { migrations } = require("../src/migrations");
const resetCollection = async () => { try { await PrintReservation.collection.drop(); } catch (error) { if (error.codeName !== "NamespaceNotFound") throw error; } };
const indexesOf = async () => (await PrintReservation.collection.indexes()).map((index) => index.name).sort();
const atVersion10 = () => Meta.updateOne({ _id: "schema" }, { $set: { version: 10 } }, { upsert: true });
const LIVE_INDEX = "print_reservation_live_unique";

it("migration 11 is the next number after 10 and runs outside a transaction (index changes cannot)", () => {
  const last = migrations[migrations.length - 1];
  assert.equal(last.version, 11);
  assert.equal(last.outsideTransaction, true);
  assert.equal(migrations[migrations.length - 2].version, 10);
});

it("a database that still has the OLD non-unique key_1_copyNo_1 index: startup (migrations, then ensureIndexes) works, the old index is gone, print_reservation_live_unique has unique + the partial filter", async () => {
  await resetCollection();
  await PrintReservation.collection.createIndex({ key: 1, copyNo: 1 }); // what the earlier build created: name key_1_copyNo_1, not unique
  assert.ok((await indexesOf()).includes("key_1_copyNo_1"));
  await atVersion10();
  // why the new index needs its own name: under the default name (key_1_copyNo_1) the unique partial index clashes with the old one
  await assert.rejects(() => PrintReservation.collection.createIndex({ key: 1, copyNo: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["reserved", "printed"] } } }), (error) => error.codeName === "IndexOptionsConflict" || /already exists|conflict/i.test(error.message));
  assert.ok((await indexesOf()).includes("key_1_copyNo_1"), "still only the old index before the migration");
  assert.equal(await runMigrations(), 11);
  await ensureIndexes();
  const indexes = await PrintReservation.collection.indexes();
  assert.ok(!indexes.some((index) => index.name === "key_1_copyNo_1"), "the old index is gone");
  const live = indexes.find((index) => index.name === LIVE_INDEX);
  assert.ok(live, "the new index exists");
  assert.equal(live.unique, true);
  assert.deepEqual(live.key, { key: 1, copyNo: 1 });
  assert.deepEqual(live.partialFilterExpression, { status: { $in: ["reserved", "printed"] } });
  assert.equal((await Meta.findById("schema").lean()).version, 11);
});

it("(d) a database with the UNIQUE partial index under the default name key_1_copyNo_1 (as 7534eba6 built it): migrations then ensureIndexes start fine, only _id_, key_1 and print_reservation_live_unique remain", async () => {
  await resetCollection();
  await PrintReservation.collection.createIndex({ key: 1, copyNo: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["reserved", "printed"] } } });
  assert.ok((await indexesOf()).includes("key_1_copyNo_1"));
  await atVersion10();
  assert.equal(await runMigrations(), 11);
  await ensureIndexes();
  assert.deepEqual(await indexesOf(), ["_id_", LIVE_INDEX, "key_1"].sort());
  const live = (await PrintReservation.collection.indexes()).find((index) => index.name === LIVE_INDEX);
  assert.equal(live.unique, true);
  assert.deepEqual(live.partialFilterExpression, { status: { $in: ["reserved", "printed"] } });
});

it("a fresh database (no collection yet): the migration is a no-op and only the new index is built", async () => {
  await resetCollection();
  await atVersion10();
  assert.equal(await runMigrations(), 11);
  await ensureIndexes();
  const names = await indexesOf();
  assert.ok(names.includes(LIVE_INDEX));
  assert.ok(!names.includes("key_1_copyNo_1"));
  assert.deepEqual(names, ["_id_", LIVE_INDEX, "key_1"].sort());
});

it("running migration 11 twice is a no-op (it never drops the new unique index)", async () => {
  await resetCollection();
  await PrintReservation.collection.createIndex({ key: 1, copyNo: 1 });
  await atVersion10();
  await runMigrations();
  await ensureIndexes();
  const before = await PrintReservation.collection.indexes();
  const migration = migrations.find((entry) => entry.version === 11);
  assert.deepEqual(await migration.run(), { dropped: false }, "called directly again: nothing to drop");
  await atVersion10();
  assert.equal(await runMigrations(), 11, "and through the runner");
  await ensureIndexes();
  assert.deepEqual(await PrintReservation.collection.indexes(), before);
  assert.ok((await indexesOf()).includes(LIVE_INDEX));
});
