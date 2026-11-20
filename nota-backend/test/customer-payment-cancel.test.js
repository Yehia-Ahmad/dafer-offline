// Fixes 1: cancel a customer payment (تحصيل). POST /api/customers/:id/receipts/:receiptId/cancel (credit.payment.cancel: owner and manager).
// Real throwaway mongod (port 27133, replica set: transactions are required).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "payment-cancel-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "payment-cancel-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const { businessDayOf, dayString, today } = require("./helpers/shopDay");
const test = require("node:test");
const mongoose = require("mongoose");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const AuditLog = require("../src/models/auditLog.model");
const CreditSale = require("../src/models/creditSale.model");
const Counter = require("../src/models/counter.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const PartyOpening = require("../src/models/partyOpening.model");
const Product = require("../src/models/product.model");
const Receipt = require("../src/models/receipt.model");
const { runMigrations } = require("../src/migrations");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let ownerToken;
let phoneSeq = 0; let categorySeq = 0;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27133 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "pc-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "pc-owner", password: "owner-pass-123" } })).json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text };
}
const staff = (method, path, body, token = ownerToken, headers = {}) => call(method, path, { token, body, headers });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };
const idOf = (row) => String(row?._id ?? row?.id ?? row?.creditSale?._id ?? row?.invoice?._id);
const DEVICE_A = "device-pcancel-0001";
const asDevice = (id, name = "PC") => ({ "X-Nota-Device-Id": id, "X-Nota-Device-Name": encodeURIComponent(name) });

async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function makeStaff(username, role, permissions) {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
}
async function seedProduct({ stock = 500, retail = 100 } = {}) {
  const created = ok(await staff("POST", "/api/categories", { name: `فئة ${++categorySeq}` }), 201);
  const category = created._id || created.id || created.category?._id;
  const product = ok(await staff("POST", "/api/products", { name: "منتج", code: `P${categorySeq}`, categoryId: category, inventoryCount: stock, purchasePrice: 40, wholesalePrice: Math.min(60, retail), retailPrice: retail }), 201);
  return product._id || product.product?._id;
}
async function newCustomer(name = "عميل") {
  return ok(await staff("POST", "/api/customers", { name, phone: `0101${String(++phoneSeq).padStart(7, "0")}` }), 201);
}
async function newInvoice(customer, productId, { quantity = 1, price = 100, ...extra } = {}) {
  const created = ok(await staff("POST", "/api/credit-sales", { customerId: customer._id, customerName: customer.name, customerPhone: customer.phone, sellingDate: dayString(), items: [{ productId, quantity, price }], ...extra }), 201);
  return CreditSale.findById(idOf(created)).lean();
}
/** One payment through the customer route; returns the Receipt document. */
async function pay(customer, amount, extra = {}) {
  const result = ok(await staff("POST", `/api/customers/${customer._id}/payments`, { amount, firstInvoice: true, ...extra }), 201);
  return Receipt.findOne({ number: result.receiptNumber }).lean();
}
const cancel = (customer, receipt, reason = "المبلغ اتكتب غلط", token = ownerToken) => staff("POST", `/api/customers/${customer._id}/receipts/${receipt._id}/cancel`, { reason }, token);
const owed = async (customer) => {
  const statement = ok(await staff("GET", `/api/customers/${customer._id}/statement`));
  return statement.lines.length ? statement.lines[statement.lines.length - 1].balance : 0;
};
const invoiceOf = (id) => CreditSale.findById(id).lean();
const boxes = async () => ok(await staff("GET", "/api/cashbox/boxes")).data;
const mainBalance = async () => (await boxes()).find((box) => box.isMain).balance;
async function newBox(name, type = "wallet", extra = {}) {
  const created = ok(await staff("POST", "/api/cashbox/boxes", { name, type, ...extra }), 201);
  return created._id || created.box?._id || created.id;
}
async function assertHealthy() {
  const health = ok(await staff("GET", "/api/accounting/health"));
  for (const [name, check] of Object.entries(health)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
}

it("a payment is cancelled: the invoice owes it again, the box gives it back, the statement shows a cancel line, the ledger and health agree", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { price: 300 });
  const before = await mainBalance();
  const receipt = await pay(customer, 100);
  assert.equal(await mainBalance(), before + 100);
  assert.equal(await owed(customer), 200);

  const cancelled = ok(await cancel(customer, receipt));
  assert.equal(cancelled.receipt.status, "cancelled");
  assert.deepEqual(cancelled.restored.map((row) => [row.kind, row.amount]), [["invoice", 100]]);
  const stored = await Receipt.findById(receipt._id).lean();
  assert.equal(stored.status, "cancelled"); assert.equal(stored.cancelReason, "المبلغ اتكتب غلط"); assert.ok(stored.cancelledAt); assert.ok(stored.cancelledByName);
  const row = await invoiceOf(invoice._id);
  assert.equal(row.paidAmount, 0); assert.equal(row.remainingAmount, 300); assert.equal(row.status, "pending");
  assert.equal(row.payments.length, 1, "the payment row stays (history)"); assert.ok(row.payments[0].cancelledAt);
  assert.equal(await mainBalance(), before, "the box is back where it was");
  assert.equal(await owed(customer), 300);

  const statement = ok(await staff("GET", `/api/customers/${customer._id}/statement`));
  const types = statement.lines.map((line) => line.type);
  assert.deepEqual(types, ["invoice", "payment", "payment_cancel"]);
  const cancelLine = statement.lines[2];
  assert.equal(cancelLine.number, receipt.number); assert.equal(cancelLine.debit, 100); assert.equal(cancelLine.balance, 300);

  const entries = await JournalEntry.find({ "source.type": "receipt", "source.id": receipt._id }).sort({ createdAt: 1 }).lean();
  assert.equal(entries.length, 2, "the original entry and its reversal");
  assert.equal(entries[1].type, "reversal"); assert.equal(String(entries[1].reversalOf), String(entries[0]._id));
  assert.equal(businessDayOf(entries[1].date), dayString(), "the reversal is dated today");
  assert.ok(await AuditLog.findOne({ action: "credit.payment.cancelled" }).lean(), "audited");
  await assertHealthy();
});

it("a payment spread over two invoices and the opening balance: all three are restored", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  await PartyOpening.create({ partyType: "customer", partyId: customer._id, amount: 80, date: new Date(`${dayString(-30)}T00:00:00Z`), number: "OB-T1", payments: [] });
  const first = await newInvoice(customer, product, { price: 50 });
  const second = await newInvoice(customer, product, { price: 70 });
  const receipt = await pay(customer, 150, { firstInvoice: false, lastInvoice: true }); // newest invoice first, the opening last: 70 + 50 + 30 of the opening
  assert.equal((await invoiceOf(second._id)).remainingAmount, 0); assert.equal((await invoiceOf(first._id)).remainingAmount, 0);
  assert.equal(ok(await staff("GET", `/api/customers/${customer._id}`)).opening.collected, 30);
  const cancelled = ok(await cancel(customer, receipt));
  assert.deepEqual(cancelled.restored.map((row) => row.kind).sort(), ["invoice", "invoice", "opening"]);
  assert.equal((await invoiceOf(first._id)).remainingAmount, 50); assert.equal((await invoiceOf(first._id)).status, "pending");
  assert.equal((await invoiceOf(second._id)).remainingAmount, 70);
  const opening = ok(await staff("GET", `/api/customers/${customer._id}`)).opening;
  assert.equal(opening.collected, 0); assert.equal(opening.remaining, 80);
  assert.ok((await PartyOpening.findOne({ partyId: customer._id }).lean()).payments[0].cancelledAt);
});

it("a payment made through the credit-sale route is cancelled the same way", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { price: 200 });
  const result = ok(await staff("POST", `/api/credit-sales/${invoice._id}/payments`, { amount: 60 }), 201);
  const receipt = await Receipt.findOne({ number: result.receiptNumber }).lean();
  ok(await cancel(customer, receipt));
  assert.equal((await invoiceOf(invoice._id)).remainingAmount, 200);
});

it("a later payment on the same invoice stays: only the cancelled one comes back", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { price: 300 });
  const first = await pay(customer, 100); const second = await pay(customer, 50);
  ok(await cancel(customer, first));
  const row = await invoiceOf(invoice._id);
  assert.equal(row.paidAmount, 50); assert.equal(row.remainingAmount, 250); assert.equal(row.status, "partially_paid");
  assert.equal((await Receipt.findById(second._id).lean()).status || "posted", "posted");
  ok(await cancel(customer, second));
  assert.equal((await invoiceOf(invoice._id)).remainingAmount, 300);
  await assertHealthy();
});

it("cancelling twice (and two cancels at the same time) cancels once: the other answers ALREADY_CANCELLED", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  await newInvoice(customer, product, { price: 300 });
  const receipt = await pay(customer, 100);
  const results = await Promise.all([cancel(customer, receipt), cancel(customer, receipt)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(results.find((r) => r.status === 409).json.code, "ALREADY_CANCELLED");
  assert.equal(await JournalEntry.countDocuments({ "source.type": "receipt", "source.id": receipt._id, type: "reversal" }), 1, "one reversal only");
  assert.equal((await cancel(customer, receipt)).json.code, "ALREADY_CANCELLED");
  assert.equal(await owed(customer), 300);
  await assertHealthy();
});

it("a payment on the same customer at the same time as a cancel: both end consistent", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { price: 300 });
  const first = await pay(customer, 100);
  const [cancelled, paid] = await Promise.all([cancel(customer, first), staff("POST", `/api/customers/${customer._id}/payments`, { amount: 40, firstInvoice: true })]);
  assert.equal(cancelled.status, 200, cancelled.text); assert.equal(paid.status, 201, paid.text);
  const row = await invoiceOf(invoice._id);
  assert.equal(row.paidAmount, 40); assert.equal(row.remainingAmount, 260);
  assert.equal(await owed(customer), 260);
  await assertHealthy();
});

// ----------------------------------------------------------------------------------------------------------------- refusals

const refusedLeavesNothing = async (customer, receipt, invoice, code, status = 409) => {
  const entriesBefore = await JournalEntry.countDocuments({});
  const response = await cancel(customer, receipt);
  assert.equal(response.status, status, response.text);
  assert.equal(response.json.code, code, response.text);
  assert.equal((await Receipt.findById(receipt._id).lean()).status || "posted", "posted", "the flip rolled back");
  assert.equal(await JournalEntry.countDocuments({}), entriesBefore, "no entry posted");
  if (invoice) assert.equal((await invoiceOf(invoice._id)).payments.filter((payment) => payment.cancelledAt).length, 0, "no payment row flagged");
};

it("refused: a return that handed the paid money back (credit or other invoices) - PAYMENT_USED_BY_RETURN with the way out", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { quantity: 2, price: 50 });
  const receipt = await pay(customer, 100);
  ok(await staff("POST", "/api/returns", { returnType: "credit", invoiceId: invoice._id, items: [{ productId: product, quantity: 1, returnReason: "x" }] }), 201);
  const stored = await invoiceOf(invoice._id);
  assert.ok(stored.returnedPaidAmount + stored.reallocatedPaidAmount > 0, "the return released paid money");
  const response = await cancel(customer, receipt);
  assert.equal(response.status, 409); assert.equal(response.json.code, "PAYMENT_USED_BY_RETURN");
  assert.match(response.json.message, /اصرف الرصيد الدائن|اخصمه/, "the message says what to do instead");
  assert.equal((await Receipt.findById(receipt._id).lean()).status || "posted", "posted");
});

it("allowed: a return that only reduced what was still owed", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { quantity: 2, price: 50 });
  const receipt = await pay(customer, 30);
  ok(await staff("POST", "/api/returns", { returnType: "credit", invoiceId: invoice._id, items: [{ productId: product, quantity: 1, returnReason: "x" }] }), 201);
  const mid = await invoiceOf(invoice._id);
  assert.equal(mid.returnedPaidAmount + mid.reallocatedPaidAmount, 0); assert.equal(mid.remainingAmount, 20);
  ok(await cancel(customer, receipt));
  const row = await invoiceOf(invoice._id);
  assert.equal(row.paidAmount, 0); assert.equal(row.remainingAmount, 50); assert.equal(row.status, "pending");
  await assertHealthy();
});

it("refused: a written-off invoice, a cancelled invoice, a website cash-on-delivery receipt, a down payment", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const written = await newInvoice(customer, product, { price: 300 });
  const receipt = await pay(customer, 100);
  await CreditSale.updateOne({ _id: written._id }, { $push: { payments: { amount: 1, paymentDate: new Date(), source: "manual_entry", manualEntryId: new mongoose.Types.ObjectId() } } });
  await refusedLeavesNothing(customer, receipt, written, "WRITTEN_OFF");
  await CreditSale.updateOne({ _id: written._id }, { $pull: { payments: { source: "manual_entry" } } });

  await CreditSale.updateOne({ _id: written._id }, { $set: { status: "cancelled" } });
  await refusedLeavesNothing(customer, receipt, written, "INVOICE_CLOSED");
  await CreditSale.updateOne({ _id: written._id }, { $set: { status: "partially_paid" } });

  await mongoose.connection.collection("weborders").insertOne({ paymentIds: [receipt._id], number: "W-T1" });
  await refusedLeavesNothing(customer, receipt, written, "RECEIPT_OF_WEB_ORDER");
  await mongoose.connection.collection("weborders").deleteMany({});

  const other = await newCustomer("بمقدم");
  const withDown = await newInvoice(other, product, { price: 200, downPayment: 50 });
  const down = await Receipt.findOne({ customer: other._id, kind: "down_payment" }).lean();
  assert.ok(down && withDown);
  assert.equal((await cancel(other, down)).json.code, "USE_INVOICE_CANCEL");
  ok(await cancel(customer, receipt)); // nothing above left a trace: it still cancels
});

it("refused: the box is stopped, no longer holds the money, or is a drawer with no open shift", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  await newInvoice(customer, product, { price: 1000 });
  const main = (await boxes()).find((box) => box.isMain);
  // short of money: collected into a wallet that then sent the money away
  const wallet = await newBox("محفظة");
  const inWallet = await pay(customer, 100, { boxId: wallet });
  ok(await staff("POST", "/api/cashbox/transfers", { fromBoxId: wallet, toBoxId: main._id, amount: 100 }), 201);
  let response = await cancel(customer, inWallet);
  assert.equal(response.status, 409); assert.equal(response.json.code, "INSUFFICIENT_BALANCE"); assert.equal(response.json.required, 100);
  // a stopped box
  ok(await staff("PUT", `/api/cashbox/boxes/${wallet}`, { isActive: false }));
  response = await cancel(customer, inWallet);
  assert.equal(response.json.code, "BOX_INACTIVE");
  // a drawer: needs an open shift to take the cash out of
  const drawer = ok(await staff("POST", "/api/cashbox/boxes", { name: "درج", type: "cash", shiftsEnabled: true, deviceId: DEVICE_A }), 201);
  const shift = ok(await staff("POST", "/api/shifts", { boxId: drawer._id, openingFloat: 0 }, ownerToken, asDevice(DEVICE_A)), 201);
  const inDrawer = await pay(customer, 70, { boxId: drawer._id });
  ok(await staff("POST", `/api/shifts/${shift._id}/close`, { counted: 70, depositBoxId: main._id, depositAmount: 70 }, ownerToken, asDevice(DEVICE_A)));
  const closedReport = ok(await staff("GET", `/api/shifts/${shift._id}`)).expected;
  await Receipt.updateOne({ _id: inDrawer._id }, { $set: { boxId: drawer._id } });
  response = await cancel(customer, inDrawer);
  assert.equal(response.status, 409); assert.equal(response.json.code, "NO_OPEN_SHIFT");
  assert.equal(ok(await staff("GET", `/api/shifts/${shift._id}`)).expected, closedReport, "a closed shift's report never changes");
});

// ----------------------------------------------------------------------------------------------------------------- shift effect

it("shift: a payment cancelled in the same shift nets out of expected cash; a cancel after the shift closed lands in the next shift", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  await newInvoice(customer, product, { price: 1000 });
  const main = (await boxes()).find((box) => box.isMain);
  const drawer = ok(await staff("POST", "/api/cashbox/boxes", { name: "درج", type: "cash", shiftsEnabled: true, deviceId: DEVICE_A }), 201);
  const device = asDevice(DEVICE_A);
  const first = ok(await staff("POST", "/api/shifts", { boxId: drawer._id, openingFloat: 0 }, ownerToken, device), 201);
  const expectedOf = async (shift) => ok(await staff("GET", `/api/shifts/${shift._id}`)).expected;
  const a = await pay(customer, 200, { boxId: drawer._id }); const b = await pay(customer, 100, { boxId: drawer._id });
  assert.equal(await expectedOf(first), 300);
  ok(await cancel(customer, a));
  assert.equal(await expectedOf(first), 100, "the cancelled payment left the drawer's expected cash");
  const lines = ok(await staff("GET", `/api/shifts/${first._id}`)).lines;
  assert.equal(lines.find((line) => line.key === "receipts").amount, 100, "the receipts line is the net");
  // close the first shift with the cash still in it, then cancel b in the second shift
  ok(await staff("POST", `/api/shifts/${first._id}/close`, { counted: 100 }, ownerToken, device));
  const closed = await expectedOf(first);
  const second = ok(await staff("POST", "/api/shifts", { boxId: drawer._id, openingFloat: 100 }, ownerToken, device), 201);
  assert.equal(await expectedOf(second), 100);
  ok(await cancel(customer, b));
  assert.equal(await expectedOf(second), 0, "the second shift carries the cash that left");
  assert.equal(await expectedOf(first), closed, "the closed shift's report is untouched");
  await assertHealthy();
  assert.equal(main.isMain, true);
});

// ----------------------------------------------------------------------------------------------------------------- dates

it("closed period: a payment dated in a closed month can be cancelled; the reversal is dated today, the old statement lines do not move; a locked today refuses", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  await newInvoice(customer, product, { price: 300 });
  const oldDay = dayString(-45);
  const receipt = await pay(customer, 100, { paymentDate: oldDay });
  await Meta.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": new Date(`${dayString(-20)}T00:00:00Z`) } });
  ok(await cancel(customer, receipt));
  const reversal = await JournalEntry.findOne({ "source.id": receipt._id, type: "reversal" }).lean();
  assert.equal(businessDayOf(reversal.date), dayString(), "dated today, in the open period");
  const statement = ok(await staff("GET", `/api/customers/${customer._id}/statement`));
  assert.equal(statement.lines.find((line) => line.type === "payment").date.slice(0, 10), oldDay, "the original line keeps its date");
  assert.equal(statement.lines.find((line) => line.type === "payment_cancel").date.slice(0, 10), today());

  const again = await pay(customer, 40);
  await Meta.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": new Date(`${today()}T00:00:00Z`) } });
  const response = await cancel(customer, again);
  assert.equal(response.status, 409); assert.equal(response.json.code, "PERIOD_LOCKED");
  assert.equal((await Receipt.findById(again._id).lean()).status || "posted", "posted");
});

// ----------------------------------------------------------------------------------------------------------------- permission, reason, reads

it("permission: owner and manager may cancel; a cashier and an accountant (who may collect) may not", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  await newInvoice(customer, product, { price: 900 });
  const manager = await makeStaff("pc-manager", "manager"); const cashier = await makeStaff("pc-cashier", "cashier"); const accountant = await makeStaff("pc-accountant", "accountant");
  const first = await pay(customer, 100); const second = await pay(customer, 100); const third = await pay(customer, 100);
  assert.equal((await cancel(customer, first, "سبب", cashier)).status, 403);
  assert.equal((await cancel(customer, first, "سبب", accountant)).status, 403);
  assert.equal((await Receipt.findById(first._id).lean()).status || "posted", "posted");
  assert.equal((await cancel(customer, second, "سبب", manager)).status, 200);
  assert.equal((await cancel(customer, third)).status, 200);
  const { permissionsForRole } = require("../src/auth/permissions");
  assert.ok(permissionsForRole("owner").includes("credit.payment.cancel") && permissionsForRole("manager").includes("credit.payment.cancel"));
  assert.ok(!permissionsForRole("cashier").includes("credit.payment.cancel") && !permissionsForRole("accountant").includes("credit.payment.cancel"));
});

it("a reason of 3 to 500 characters is required; an unknown receipt is 404; a receipt of another customer is 404", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer(); const other = await newCustomer("تاني");
  await newInvoice(customer, product, { price: 300 });
  const receipt = await pay(customer, 100);
  for (const reason of ["", "ab", "x".repeat(501)]) {
    const response = await staff("POST", `/api/customers/${customer._id}/receipts/${receipt._id}/cancel`, { reason });
    assert.equal(response.status, 400); assert.equal(response.json.code, "REASON_REQUIRED");
  }
  assert.equal((await cancel(other, receipt)).status, 404);
  assert.equal((await staff("POST", `/api/customers/${customer._id}/receipts/${new mongoose.Types.ObjectId()}/cancel`, { reason: "سبب" })).status, 404);
  assert.equal((await staff("POST", `/api/customers/${customer._id}/receipts/not-an-id/cancel`, { reason: "سبب" })).status, 404);
});

it("the receipts list shows each payment with its box, allocations and status; print-data carries the cancel stamp", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { price: 300 });
  const kept = await pay(customer, 50); const gone = await pay(customer, 100);
  ok(await cancel(customer, gone, "غلط في المبلغ"));
  const list = ok(await staff("GET", `/api/customers/${customer._id}/receipts`)).data;
  assert.deepEqual(list.map((row) => [row.number, row.status]).sort(), [[kept.number, "posted"], [gone.number, "cancelled"]].sort());
  const cancelledRow = list.find((row) => row.status === "cancelled");
  assert.equal(cancelledRow.cancelReason, "غلط في المبلغ"); assert.equal(cancelledRow.allocations[0].invoiceNumber, invoice.number); assert.ok(cancelledRow.boxName);
  const print = ok(await staff("GET", `/api/customers/${customer._id}/receipts/${gone.number}/print-data`)).receipt;
  assert.equal(print.status, "cancelled"); assert.equal(print.cancelReason, "غلط في المبلغ"); assert.ok(print.cancelledAt);
  assert.equal(ok(await staff("GET", `/api/customers/${customer._id}/receipts/${kept.number}/print-data`)).receipt.status, "posted");
  const cashier = await makeStaff("pc-cashier2", "cashier");
  assert.equal((await staff("GET", `/api/customers/${customer._id}/receipts`, undefined, cashier)).status, 200);
});

it("an invoice whose only live payments were cancelled can be cancelled itself again", async () => {
  await startLedger();
  const product = await seedProduct(); const customer = await newCustomer();
  const invoice = await newInvoice(customer, product, { price: 300 });
  const receipt = await pay(customer, 100);
  assert.equal((await staff("POST", `/api/credit-sales/${invoice._id}/cancel`, { reason: "سبب" })).json.code, "HAS_PAYMENTS");
  ok(await cancel(customer, receipt));
  ok(await staff("POST", `/api/credit-sales/${invoice._id}/cancel`, { reason: "الفاتورة غلط" }));
  assert.equal((await invoiceOf(invoice._id)).status, "cancelled");
  assert.equal((await Product.findById((await invoiceOf(invoice._id)).items[0].product).lean()).inventoryCount, 500, "stock back");
});
