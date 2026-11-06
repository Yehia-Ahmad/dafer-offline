process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage19-test-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const app = require("../src/app");
const Account = require("../src/models/account.model");
const AuditLog = require("../src/models/auditLog.model");
const CashBox = require("../src/models/cashBox.model");
const Category = require("../src/models/category.model");
const Counter = require("../src/models/counter.model");
const CreditSale = require("../src/models/creditSale.model");
const Customer = require("../src/models/customer.model");
const Device = require("../src/models/device.model");
const Expense = require("../src/models/expense.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Receipt = require("../src/models/receipt.model");
const ReturnLog = require("../src/models/returnLog.model");
const Selling = require("../src/models/selling.model");
const Shift = require("../src/models/shift.model");
const { runMigrations } = require("../src/migrations");
const { postEntry, accountMap, line } = require("../src/accounting/posting");
const { withTransaction } = require("../src/utils/transaction");
const { ROLE_TEMPLATES } = require("../src/auth/permissions");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

let stop; let server; let baseUrl; let token; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27119 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null; resetDeviceThrottle();
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "stage19-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token; ownerToken = token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

const DEVICE_A = "device-aaaa-0001";
const DEVICE_B = "device-bbbb-0002";
async function call(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text(); return { status: response.status, json: text ? JSON.parse(text) : null };
}
const asDevice = (id, name = "PC") => ({ "X-Nota-Device-Id": id, "X-Nota-Device-Name": encodeURIComponent(name) });

async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function product({ code, stock = 50, cost = 20 } = {}) {
  const category = await Category.create({ name: `Stage19 ${code || Math.random()}` });
  const response = await call("POST", "/api/products", { name: code || "Product", code: code || `P-${Math.random()}`, categoryId: String(category._id), inventoryCount: stock, purchasePrice: cost, wholesalePrice: cost + 5, retailPrice: cost + 10 });
  assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json;
}
const sellBody = (p, price, extra = {}) => ({ customerName: "Cash customer", customerPhone: "01017171718", sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price }], ...extra });
const sell = async (p, price = 100, extra = {}, headers = {}) => call("POST", "/api/sellings", sellBody(p, price, extra), headers);
const sold = async (p, price = 100, extra = {}, headers = {}) => { const sale = await sell(p, price, extra, headers); assert.equal(sale.status, 201, JSON.stringify(sale.json)); return sale.json; };
const customer = (name, phone) => Customer.create({ name, phone });
const creditSale = async (c, p, price, extra = {}, headers = {}) => {
  const invoice = await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price }], ...extra }, headers);
  assert.equal(invoice.status, 201, JSON.stringify(invoice.json)); return invoice.json;
};
async function entriesOf(type, id) {
  const entries = await JournalEntry.find({ "source.type": type, "source.id": id }).sort({ createdAt: 1 }).lean();
  const accounts = await Account.find({}).lean();
  const keys = new Map(accounts.map((account) => [String(account._id), account.systemKey || account.code]));
  return entries.map((entry) => ({ type: entry.type, lines: entry.lines.map((row) => ({ key: keys.get(String(row.accountId)), debit: row.debit, credit: row.credit })) }));
}
const lineOf = (entry, key) => entry.lines.find((row) => row.key === key);
async function assertHealthy() {
  const response = await call("GET", "/api/accounting/health"); assert.equal(response.status, 200);
  for (const [name, check] of Object.entries(response.json)) {
    assert.equal(check.difference, 0, `${name}: ${JSON.stringify(check)}`);
    if ("ok" in check) assert.equal(check.ok, true, `${name}: ${JSON.stringify(check)}`);
  }
  assert.ok(response.json.boxes, "the health report has the boxes check");
  return response.json;
}
const login = async (username, password) => { const response = await call("POST", "/api/auth/login", { username, password }); assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json.token; };

/** A ledger with the wizard's cash 20,000 in the main box and a 5,000 wallet. */
async function shop() {
  await startLedger();
  const saved = await call("POST", "/api/accounting/opening", { cash: 20000, banks: [{ name: "Vodafone Cash", type: "wallet", amount: 5000 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const list = (await call("GET", "/api/cashbox/boxes")).json.data;
  return { main: list.find((box) => box.isMain), wallet: list.find((box) => box.type === "wallet") };
}
const createBox = async (body, headers = {}) => { const response = await call("POST", "/api/cashbox/boxes", body, headers); assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json; };
const balanceOf = async (box) => (await call("GET", `/api/cashbox/boxes/${box._id}`)).json.balance;
const transfer = async (from, to, amount) => { const response = await call("POST", "/api/cashbox/transfers", { fromBoxId: from._id, toBoxId: to._id, amount }); assert.equal(response.status, 201, JSON.stringify(response.json)); return response.json; };
const openShift = async (box, openingFloat, extra = {}, headers = {}) => call("POST", "/api/shifts", { boxId: box._id, openingFloat, ...extra }, headers);
const category = async (code = "521") => String((await Account.findOne({ code }).lean())._id);
const makeUser = async (username, role) => {
  const created = await call("POST", "/api/users", { name: username, username, password: "secret-pass-1", role });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return login(username, "secret-pass-1");
};

// ------------------------------------------------------------ migration

it("the migration creates the main box (account 1111) and a box per 112xx leaf, and puts the main box on every old money document", async () => {
  const { wallet } = await shop();
  const p = await product({ code: "OLD-1" }); const c = await customer("Old Customer", "01010000191");
  const sale = await sold(p, 100);
  const credit = await creditSale(c, p, 300, { downPayment: 100 });
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] })).status, 201);
  assert.equal((await call("POST", `/api/credit-sales/${credit._id}/cancel`, { reason: "cancel old" })).status, 200);
  // Make it look like an install from before Stage 19, then upgrade.
  await forgetBoxes(); await Meta.updateOne({ _id: "schema" }, { $set: { version: 6 } });
  assert.equal(await CashBox.countDocuments({}), 0); assert.equal(await Selling.countDocuments({ boxId: { $exists: true } }), 0);
  assert.equal(await runMigrations(), 7);
  const boxes = await CashBox.find({}).sort({ sortOrder: 1 }).lean();
  assert.deepEqual(boxes.map((box) => [box.name, box.type, box.isMain, box.shiftsEnabled]), [["الخزنة الرئيسية", "cash", true, false], ["Vodafone Cash", "wallet", false, false]]);
  const main = boxes[0];
  assert.equal((await Account.findById(main.accountId).lean()).systemKey, "CASH_MAIN");
  assert.equal(String((await Account.findById(boxes[1].accountId).lean())._id), String((await Account.findOne({ code: "11201" }).lean())._id));
  assert.equal(String(wallet.accountId), String(boxes[1].accountId), "the wallet box keeps the wizard's account");
  for (const [Model, filter] of [[Selling, {}], [Receipt, {}], [ReturnLog, { returnType: "cash" }]]) {
    const docs = await Model.collection.find(filter).toArray();
    assert.ok(docs.length > 0); assert.ok(docs.every((doc) => String(doc.boxId) === String(main._id)), Model.modelName);
  }
  assert.equal(String((await CreditSale.findById(credit._id).lean()).cancelRefundBoxId), String(main._id));
  assert.equal(await runMigrations(), 7, "idempotent");
  assert.equal(await CashBox.countDocuments({}), 2);
  await assertHealthy();
});

it("a shop that never opens the cash page keeps one main box and no shifts: every document goes to 1111", async () => {
  await startLedger();
  const p = await product({ code: "DEFAULT-1" });
  const sale = await sold(p, 100);
  const main = await CashBox.findOne({ isMain: true }).lean();
  assert.equal(String(sale.boxId), String(main._id));
  const [entry] = await entriesOf("sale", sale._id);
  assert.deepEqual(lineOf(entry, "CASH_MAIN"), { key: "CASH_MAIN", debit: 100, credit: 0 });
  assert.equal(await Shift.countDocuments({}), 0);
  assert.equal(await CashBox.countDocuments({}), 1);
  await assertHealthy();
});

// ------------------------------------------------------------ boxes

it("create boxes: drawers are 11102, 11103..., wallets and banks the next 112xx; shifts default on for drawers only", async () => {
  const { main, wallet } = await shop();
  const drawer = await createBox({ name: "درج 1", type: "cash" });
  const second = await createBox({ name: "درج 2", type: "cash", shiftsEnabled: false });
  const insta = await createBox({ name: "InstaPay", type: "wallet", shiftsEnabled: true });
  const bank = await createBox({ name: "CIB", type: "bank" });
  assert.deepEqual([drawer.accountCode, second.accountCode, insta.accountCode, bank.accountCode], ["11102", "11103", "11202", "11203"]);
  assert.deepEqual([drawer.shiftsEnabled, second.shiftsEnabled, insta.shiftsEnabled, bank.shiftsEnabled], [true, false, false, false]);
  assert.equal((await Account.findOne({ code: "11102" }).lean()).kind, null);
  assert.equal((await Account.findOne({ code: "11203" }).lean()).kind, "bank");
  assert.equal(wallet.shiftsEnabled, false);
  assert.equal((await call("POST", "/api/cashbox/boxes", { name: "", type: "cash" })).status, 400);
  assert.equal((await call("POST", "/api/cashbox/boxes", { name: "X", type: "safe" })).status, 400);
  assert.equal(await CashBox.countDocuments({ isMain: true }), 1);
  // رصيد البداية: moved in from the main box when the box is created.
  const funded = await createBox({ name: "درج 3", type: "cash", openingAmount: 500 });
  assert.equal(funded.balance, 500);
  assert.equal(await balanceOf(main), 19500, "the opening amount came out of the main box");
  assert.equal((await call("POST", "/api/cashbox/boxes", { name: "درج 4", type: "cash", openingAmount: 99999 })).json.code, "INSUFFICIENT_BALANCE");
  assert.equal(await CashBox.countDocuments({ name: "درج 4" }), 0, "all or nothing");
  assert.equal(await Account.countDocuments({ nameAr: "درج 4" }), 0);
  assert.ok(await AuditLog.findOne({ action: "cashbox.created" }));
  await assertHealthy();
});

it("deactivate: only with a zero balance and no open shift; the main box never; a box with lines is never deleted", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 300);
  let r = await call("PUT", `/api/cashbox/boxes/${drawer._id}`, { isActive: false });
  assert.equal(r.status, 409); assert.equal(r.json.code, "BOX_NOT_EMPTY"); assert.equal(r.json.balance, 300);
  const back = await transfer(drawer, main, 300);
  assert.equal(back.fromAfter, 0);
  assert.equal((await openShift(drawer, 0)).status, 201);
  r = await call("PUT", `/api/cashbox/boxes/${drawer._id}`, { isActive: false });
  assert.equal(r.status, 409); assert.equal(r.json.code, "BOX_HAS_OPEN_SHIFT");
  const shift = await Shift.findOne({ status: "open" }).lean();
  assert.equal((await call("POST", `/api/shifts/${shift._id}/close`, { counted: 0 })).status, 200);
  r = await call("PUT", `/api/cashbox/boxes/${drawer._id}`, { isActive: false });
  assert.equal(r.status, 200); assert.equal(r.json.isActive, false);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${main._id}`, { isActive: false })).json.code, "MAIN_BOX");
  r = await call("DELETE", `/api/cashbox/boxes/${drawer._id}`);
  assert.equal(r.status, 409); assert.equal(r.json.code, "BOX_HAS_LINES");
  const clean = await createBox({ name: "جديد", type: "wallet" });
  assert.equal((await call("DELETE", `/api/cashbox/boxes/${clean._id}`)).status, 200);
  assert.equal(await Account.countDocuments({ code: clean.accountCode }), 0);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${drawer._id}`, { isActive: true })).status, 200);
});

// ------------------------------------------------------------ devices

it("device header: registers the PC (name, role, throttled), picks the default box, never authenticates", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج PC1", type: "cash", shiftsEnabled: false, deviceId: DEVICE_A });
  const p = await product({ code: "DEV-1" });
  const fromA = await sold(p, 100, {}, asDevice(DEVICE_A, "كاشير 1"));
  assert.equal(String(fromA.boxId), String(drawer._id), "this PC's drawer");
  const fromB = await sold(p, 100, {}, asDevice(DEVICE_B));
  assert.equal(String(fromB.boxId), String(main._id), "another PC: the main box");
  const noHeader = await sold(p, 100);
  assert.equal(String(noHeader.boxId), String(main._id));
  const invalid = await sold(p, 100, {}, { "X-Nota-Device-Id": "bad id with spaces!!" });
  assert.equal(String(invalid.boxId), String(main._id), "an invalid id is ignored");
  assert.equal(await Device.countDocuments({ deviceId: "bad id with spaces!!" }), 0);
  const registered = await Device.findOne({ deviceId: DEVICE_A }).lean();
  assert.equal(registered.name, "كاشير 1"); assert.equal(registered.role, "client");
  const first = registered.lastSeenAt.getTime();
  await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_A, "اسم تاني"));
  const again = await Device.findOne({ deviceId: DEVICE_A }).lean();
  assert.equal(again.lastSeenAt.getTime(), first, "at most one write a minute per device");
  assert.equal(again.name, "كاشير 1");
  resetDeviceThrottle();
  await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_A, "اسم تاني"));
  assert.equal((await Device.findOne({ deviceId: DEVICE_A }).lean()).name, "اسم تاني");
  assert.equal(await Device.countDocuments({ deviceId: DEVICE_A }), 1, "an upsert, never a duplicate");
  // Unsigned requests register nothing and the header is not an auth factor.
  const saved = token; token = null;
  assert.equal((await call("GET", "/api/cashbox/payment-boxes", null, asDevice("device-cccc-0003"))).status, 401);
  token = saved;
  assert.equal(await Device.countDocuments({ deviceId: "device-cccc-0003" }), 0);
  // The main PC is recognised by NOTA_INSTANCE_ID.
  process.env.NOTA_INSTANCE_ID = "device-main-0000"; resetDeviceThrottle();
  try { await call("GET", "/api/cashbox/payment-boxes", null, asDevice("device-main-0000", "Main PC")); } finally { delete process.env.NOTA_INSTANCE_ID; }
  assert.equal((await Device.findOne({ deviceId: "device-main-0000" }).lean()).role, "main");
  const long = "x".repeat(200); resetDeviceThrottle();
  await call("GET", "/api/cashbox/payment-boxes", null, asDevice("device-dddd-0004", long));
  assert.equal((await Device.findOne({ deviceId: "device-dddd-0004" }).lean()).name.length, 64);
});

it("GET /api/devices lists the PCs with their drawer; a PC can be the default of one box only (DEVICE_ALREADY_BOUND)", async () => {
  await shop();
  await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_A, "PC-A"));
  await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_B, "PC-B"));
  const drawer = await createBox({ name: "درج A", type: "cash", deviceId: DEVICE_A });
  const second = await call("POST", "/api/cashbox/boxes", { name: "درج تاني", type: "cash", deviceId: DEVICE_A });
  assert.equal(second.status, 409); assert.equal(second.json.code, "DEVICE_ALREADY_BOUND");
  const other = await createBox({ name: "درج B", type: "cash" });
  const taken = await call("PUT", `/api/cashbox/boxes/${other._id}`, { deviceId: DEVICE_A });
  assert.equal(taken.status, 409); assert.equal(taken.json.code, "DEVICE_ALREADY_BOUND");
  assert.equal((await call("PUT", `/api/cashbox/boxes/${other._id}`, { deviceId: DEVICE_B })).status, 200);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${other._id}`, { deviceId: null })).json.deviceId, null);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${other._id}`, { deviceId: "no good" })).status, 400);
  const list = (await call("GET", "/api/devices", null, asDevice(DEVICE_A, "PC-A"))).json;
  assert.equal(list.currentDeviceId, DEVICE_A);
  const a = list.data.find((row) => row.deviceId === DEVICE_A);
  assert.deepEqual([a.name, a.isCurrent, String(a.boxId), a.boxName], ["PC-A", true, String(drawer._id), "درج A"]);
  assert.equal(list.data.find((row) => row.deviceId === DEVICE_B).boxId, null);
  // Deactivating a drawer frees its PC.
  assert.equal((await call("PUT", `/api/cashbox/boxes/${drawer._id}`, { isActive: false })).status, 200);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${other._id}`, { deviceId: DEVICE_A })).status, 200);
  assert.equal(await CashBox.countDocuments({ deviceId: DEVICE_A }), 1);
});

// ------------------------------------------------------------ every money document goes through its box

it("every money document posts to its box: cash sale, down payment, receipt, cash return, cash cancel, رد المقدم", async () => {
  const { main, wallet } = await shop();
  const p = await product({ code: "BOX-DOCS" }); const c = await customer("Box Customer", "01010000192");

  const sale = await sold(p, 100, { boxId: wallet._id });
  assert.equal(String(sale.boxId), String(wallet._id));
  assert.deepEqual(lineOf((await entriesOf("sale", sale._id))[0], "11201"), { key: "11201", debit: 100, credit: 0 });
  assert.equal(lineOf((await entriesOf("sale", sale._id))[0], "CASH_MAIN"), undefined);

  const credit = await creditSale(c, p, 300, { downPayment: 120, boxId: wallet._id });
  const down = await Receipt.findOne({ kind: "down_payment" }).lean();
  assert.equal(String(down.boxId), String(wallet._id));
  assert.deepEqual((await entriesOf("receipt", down._id))[0].lines.map((row) => [row.key, row.debit, row.credit]), [["11201", 120, 0], ["CUSTOMERS", 0, 120]]);

  const paid = await call("POST", `/api/credit-sales/${credit._id}/payments`, { amount: 30, boxId: wallet._id });
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  const receipt = await Receipt.findOne({ number: paid.json.receiptNumber }).lean();
  assert.equal(String(receipt.boxId), String(wallet._id));
  const viaCustomer = await call("POST", `/api/customers/${c._id}/payments`, { amount: 20, firstInvoice: true });
  assert.equal(viaCustomer.status, 201, JSON.stringify(viaCustomer.json));
  const defaulted = await Receipt.findOne({ number: viaCustomer.json.receiptNumber }).lean();
  assert.equal(String(defaulted.boxId), String(main._id), "no box in the request: the main box");
  assert.deepEqual(lineOf((await entriesOf("receipt", defaulted._id))[0], "CASH_MAIN"), { key: "CASH_MAIN", debit: 20, credit: 0 });

  const cashSale = await sold(p, 200, { boxId: main._id });
  const returned = await call("POST", "/api/returns", { returnType: "cash", invoiceId: cashSale._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }], boxId: wallet._id });
  assert.equal(returned.status, 201, JSON.stringify(returned.json));
  const returnLog = await ReturnLog.findOne({ invoiceId: cashSale._id }).lean();
  assert.equal(String(returnLog.boxId), String(wallet._id));
  assert.deepEqual(lineOf((await entriesOf("return", returnLog._id))[0], "11201"), { key: "11201", debit: 0, credit: 200 });

  // Cancel of a cash sale reverses on its own box.
  const cancelSale = await sold(p, 100, { boxId: wallet._id });
  assert.equal((await call("POST", `/api/sellings/${cancelSale._id}/cancel`, { reason: "wrong item" })).status, 200);
  const cancelEntries = await entriesOf("sale", cancelSale._id);
  assert.equal(cancelEntries.length, 2);
  assert.deepEqual(lineOf(cancelEntries[1], "11201"), { key: "11201", debit: 0, credit: 100 });

  // رد المقدم comes out of the box the request names.
  const refundInvoice = await creditSale(c, p, 500, { downPayment: 200, boxId: main._id });
  const cancelled = await call("POST", `/api/credit-sales/${refundInvoice._id}/cancel`, { reason: "customer left", boxId: wallet._id });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal(String((await CreditSale.findById(refundInvoice._id).lean()).cancelRefundBoxId), String(wallet._id));
  const [refund] = await entriesOf("refund", refundInvoice._id);
  assert.deepEqual(refund.lines.map((row) => [row.key, row.debit, row.credit]), [["CUSTOMERS", 200, 0], ["11201", 0, 200]]);

  const health = await assertHealthy();
  assert.deepEqual(health.boxes.byBox.map((row) => row.difference), [0, 0]);
  assert.equal(health.boxes.byBox.find((row) => row.name === "Vodafone Cash").actual, await balanceOf(wallet));
});

it("a cash sale cancelled after a return from another box ends every box where the cash really is", async () => {
  const { main, wallet } = await shop();
  const p = await product({ code: "CROSS-BOX", stock: 10 });
  const sale = await call("POST", "/api/sellings", { ...sellBody(p, 100), items: [{ productId: p._id, quantity: 3, price: 100 }], boxId: main._id });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }], boxId: wallet._id })).status, 201);
  assert.equal((await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "cancel after return" })).status, 200);
  // The customer paid 300, got 100 back from the wallet, and the cancel pays the other 200 from the main box.
  assert.equal(await balanceOf(main), 20000 + 100, "300 in, 200 out");
  assert.equal(await balanceOf(wallet), 5000 - 100);
  await assertHealthy();
});

it("an edited sale keeps its box: the reversal and the re-post both land on the wallet", async () => {
  const { wallet } = await shop();
  const p = await product({ code: "EDIT-BOX" });
  const sale = await sold(p, 100, { boxId: wallet._id });
  const edited = await call("PUT", `/api/sellings/${sale._id}`, { price: 150 });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(String(edited.json.boxId), String(wallet._id));
  assert.equal(await balanceOf(wallet), 5000 + 150);
  assert.equal(await entriesOf("sale", sale._id).then((rows) => rows.every((row) => !lineOf(row, "CASH_MAIN"))), true);
  await assertHealthy();
});

it("BOX_INACTIVE and NO_OPEN_SHIFT: a stopped box and a drawer without a shift refuse every money document", async () => {
  const { main } = await shop();
  const p = await product({ code: "REFUSE-1" }); const c = await customer("Refuse", "01010000193");
  const stopped = await createBox({ name: "محفظة قديمة", type: "wallet" });
  assert.equal((await call("PUT", `/api/cashbox/boxes/${stopped._id}`, { isActive: false })).status, 200);
  for (const result of [await sell(p, 100, { boxId: stopped._id }), await call("POST", "/api/expenses", { accountId: await category(), amount: 10, boxId: stopped._id })]) {
    assert.equal(result.status, 409); assert.equal(result.json.code, "BOX_INACTIVE");
  }
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 1000);
  const invoice = await creditSale(c, p, 400);
  const attempts = [
    await sell(p, 100, { boxId: drawer._id }),
    await call("POST", `/api/credit-sales/${invoice._id}/payments`, { amount: 50, boxId: drawer._id }),
    await call("POST", `/api/customers/${c._id}/payments`, { amount: 50, boxId: drawer._id, firstInvoice: true }),
    await call("POST", "/api/expenses", { accountId: await category(), amount: 10, boxId: drawer._id }),
    await call("POST", "/api/cashbox/drawings", { amount: 10, boxId: drawer._id }),
  ];
  for (const result of attempts) { assert.equal(result.status, 409, JSON.stringify(result.json)); assert.equal(result.json.code, "NO_OPEN_SHIFT"); }
  const noDown = await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 100 }], downPayment: 10, boxId: drawer._id });
  assert.equal(noDown.status, 409); assert.equal(noDown.json.code, "NO_OPEN_SHIFT");
  assert.equal((await call("POST", "/api/sellings", { ...sellBody(p, 100), boxId: "not-an-id" })).json.code, "INVALID_BOX");
  assert.equal((await call("POST", "/api/sellings", { ...sellBody(p, 100), boxId: "6aedeb5a72fe63af6a006478" })).json.code, "BOX_NOT_FOUND");
  // A credit sale with no down payment moves no money, so it needs no box and no shift.
  assert.equal((await call("POST", "/api/credit-sales", { customerId: String(c._id), sellingDate: "2026-11-05", items: [{ productId: p._id, quantity: 1, price: 100 }], boxId: drawer._id })).status, 201);
  assert.equal((await openShift(drawer, 1000)).status, 201);
  assert.equal((await sell(p, 100, { boxId: drawer._id })).status, 201);
  assert.equal(await Selling.countDocuments({ boxId: drawer._id }), 1, "only the sale made inside the shift exists");
});

// ------------------------------------------------------------ shifts

it("the design's shift: float 500, sales 6,820, receipts 600, refunds 120, expenses 250 → expected 7,550; counted 7,500 = shortage 50; deposit 7,000 leaves 500", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج الكاشير", type: "cash" });
  await transfer(main, drawer, 500);
  const opened = await openShift(drawer, 500);
  assert.equal(opened.status, 201, JSON.stringify(opened.json)); assert.match(opened.json.number, /^SH-\d{6}$/);
  const p = await product({ code: "SHIFT-1", stock: 20 }); const c = await customer("Shift Customer", "01010000194");
  await sold(p, 6700, { boxId: drawer._id });
  const small = await sold(p, 120, { boxId: drawer._id });
  const invoice = await creditSale(c, p, 1000);
  assert.equal((await call("POST", `/api/credit-sales/${invoice._id}/payments`, { amount: 600, boxId: drawer._id })).status, 201);
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: small._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }], boxId: drawer._id })).status, 201);
  const expense = await call("POST", "/api/expenses", { accountId: await category(), amount: 250, boxId: drawer._id, note: "نقل" });
  assert.equal(expense.status, 201, JSON.stringify(expense.json));

  const report = (await call("GET", `/api/shifts/${opened.json._id}`)).json;
  const lines = Object.fromEntries(report.lines.map((row) => [row.key, row.amount]));
  assert.deepEqual(lines, { float: 500, sales: 6820, receipts: 600, transfersIn: 0, refunds: 120, expenses: 250, transfersOut: 0, payouts: 0, drawings: 0 });
  assert.equal(report.expected, 7550);

  const noNote = await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 7500 });
  assert.equal(noNote.status, 400); assert.equal(noNote.json.code, "NOTE_REQUIRED"); assert.equal(noNote.json.difference, -50);
  const tooMuch = await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 7500, differenceNote: "عجز", depositBoxId: main._id, depositAmount: 7600 });
  assert.equal(tooMuch.json.code, "INVALID_DEPOSIT");
  const closed = await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 7500, differenceNote: "عجز 50 جنيه", depositBoxId: main._id, depositAmount: 7000 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.deepEqual([closed.json.expected, closed.json.counted, closed.json.difference, closed.json.depositAmount, closed.json.remaining, closed.json.status], [7550, 7500, -50, 7000, 500, "closed"]);

  const [shortage] = await entriesOf("shift", opened.json._id);
  assert.deepEqual(shortage.lines.map((row) => [row.key, row.debit, row.credit]), [["CASH_OVER_SHORT", 50, 0], ["11102", 0, 50]]);
  const deposit = await Selling.db.collection("transfers").findOne({ kind: "shift_deposit" });
  assert.equal(deposit.amount, 7000); assert.equal(String(deposit.toBoxId), String(main._id)); assert.match(deposit.number, /^TR-\d{6}$/);
  assert.equal(await balanceOf(drawer), 500, "الباقي يفضل في الدرج");
  assert.equal(await balanceOf(main), 20000 - 500 + 7000);
  assert.equal((await Account.findOne({ code: "530" }).lean()).systemKey, "CASH_OVER_SHORT");
  const shift = await Shift.findById(opened.json._id).lean();
  assert.deepEqual(shift.breakdown.map((row) => row.key), ["float", "sales", "receipts", "transfersIn", "refunds", "expenses", "transfersOut", "payouts", "drawings"]);
  assert.equal((await call("GET", `/api/shifts/${opened.json._id}`)).json.expected, 7550, "a closed shift's report never changes");
  assert.equal((await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 1 })).json.code, "SHIFT_CLOSED");
  const audit = await AuditLog.findOne({ action: "shift.closed" }).lean();
  assert.equal(audit.details.difference, -50);
  assert.ok(await AuditLog.findOne({ action: "shift.opened" }));
  await assertHealthy();
});

it("shift close: a zero difference posts nothing, an overage credits 530, and the next shift can open on what stays in the drawer", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 200);
  const first = (await openShift(drawer, 200)).json;
  const p = await product({ code: "SHIFT-2" });
  await sold(p, 300, { boxId: drawer._id });
  const zero = await call("POST", `/api/shifts/${first._id}/close`, { counted: 500 });
  assert.equal(zero.status, 200); assert.equal(zero.json.difference, 0);
  assert.equal(await JournalEntry.countDocuments({ "source.type": "shift" }), 0, "no difference, no entry");
  // Next shift: the float must equal the balance, else confirm.
  const mismatch = await openShift(drawer, 480);
  assert.equal(mismatch.status, 409); assert.equal(mismatch.json.code, "FLOAT_MISMATCH");
  assert.deepEqual([mismatch.json.balance, mismatch.json.openingFloat, mismatch.json.difference], [500, 480, -20]);
  const second = await openShift(drawer, 480, { confirmFloat: true });
  assert.equal(second.status, 201); assert.equal(second.json.openingBalance, 500);
  assert.equal((await openShift(drawer, 500)).json.code, "SHIFT_ALREADY_OPEN");
  assert.equal(await JournalEntry.countDocuments({ "source.type": "shift" }), 0, "opening posts nothing");
  await sold(p, 100, { boxId: drawer._id });
  const over = await call("POST", `/api/shifts/${second.json._id}/close`, { counted: 600, differenceNote: "زيادة" });
  assert.equal(over.json.expected, 580); assert.equal(over.json.difference, 20);
  const [entry] = await entriesOf("shift", second.json._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["11102", 20, 0], ["CASH_OVER_SHORT", 0, 20]]);
  // The confirmed 20 gap at opening is carried in the difference: the documents (and health) agree with the ledger.
  assert.equal(await balanceOf(drawer), 620);
  assert.equal((await openShift(main, 0)).json.code, "SHIFTS_DISABLED");
  await assertHealthy();
});

it("expected cash comes from documents, never from the ledger: tampering with the drawer's ledger changes health, not the report", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 100);
  const shift = (await openShift(drawer, 100)).json;
  const p = await product({ code: "TAMPER-1" });
  await sold(p, 400, { boxId: drawer._id });
  const before = (await call("GET", `/api/shifts/${shift._id}`)).json.expected;
  assert.equal(before, 500);
  // 77 appears in the drawer's ledger from nowhere.
  await withTransaction(async (session) => {
    const accounts = await accountMap(["CAPITAL"], session);
    const boxAccount = await Account.findById(drawer.accountId).lean();
    await postEntry({ date: new Date(), source: { type: "tamper", id: new (require("mongoose").Types.ObjectId)(), number: "T-1" }, session, lines: [line(boxAccount, 77, "debit"), line(accounts.get("CAPITAL"), 77, "credit")] });
  });
  assert.equal((await call("GET", `/api/shifts/${shift._id}`)).json.expected, 500, "the report ignores the ledger");
  const health = (await call("GET", "/api/accounting/health")).json;
  assert.equal(health.boxes.difference, 77);
  assert.equal(health.boxes.byBox.find((row) => row.name === "درج").difference, 77);
  // Counting the 577 that is really there closes with a 77 overage against the documents.
  const closed = await call("POST", `/api/shifts/${shift._id}/close`, { counted: 577, differenceNote: "زيادة" });
  assert.equal(closed.json.difference, 77);
});

it("shift visibility and close rights: shift.operate closes your own, shift.manage anyone's", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash", deviceId: DEVICE_A });
  await transfer(main, drawer, 50);
  const p = await product({ code: "VIS-1" });
  const cashierOne = await makeUser("cash-one", "cashier");
  const cashierTwo = await makeUser("cash-two", "cashier");
  token = cashierOne;
  const opened = await openShift(drawer, 50, {}, asDevice(DEVICE_A));
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  assert.equal(opened.json.userName, "cash-one");
  assert.equal((await openShift(drawer, 50, {}, asDevice(DEVICE_A))).json.code, "SHIFT_ALREADY_OPEN");
  assert.equal((await openShift(drawer, 50, {}, asDevice(DEVICE_B))).json.code, "BOX_NOT_ALLOWED", "another PC's drawer is not yours");
  token = cashierTwo;
  const sale = await sell(p, 100, {}, asDevice(DEVICE_A));
  assert.equal(sale.status, 201, "any user with sales.create sells into the open shift");
  assert.equal((await call("GET", `/api/shifts/${opened.json._id}`)).status, 403, "not your shift");
  assert.equal((await call("GET", "/api/shifts")).json.data.length, 0, "a cashier lists only their own");
  assert.equal((await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 150 })).status, 403);
  token = ownerToken;
  assert.equal((await call("GET", "/api/shifts")).json.data.length, 1);
  const closed = await call("POST", `/api/shifts/${opened.json._id}/close`, { counted: 150 });
  assert.equal(closed.status, 200, JSON.stringify(closed.json)); assert.equal(closed.json.closedByName, "Owner");
  token = cashierOne;
  assert.equal((await call("GET", "/api/shifts")).json.data.length, 1);
});

// ------------------------------------------------------------ transfers

it("transfers: Dr to / Cr from, balances before and after, INSUFFICIENT_BALANCE, cancel is a reversal with a reason", async () => {
  const { main, wallet } = await shop();
  const made = await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: wallet._id, amount: 1500.5, note: "إيداع", date: "2026-11-05" });
  assert.equal(made.status, 201, JSON.stringify(made.json)); assert.match(made.json.number, /^TR-\d{6}$/);
  assert.deepEqual([made.json.fromBefore, made.json.fromAfter, made.json.toBefore, made.json.toAfter], [20000, 18499.5, 5000, 6500.5]);
  const [entry] = await entriesOf("transfer", made.json._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["11201", 1500.5, 0], ["CASH_MAIN", 0, 1500.5]]);
  const broke = await call("POST", "/api/cashbox/transfers", { fromBoxId: wallet._id, toBoxId: main._id, amount: 6500.51 });
  assert.equal(broke.status, 409); assert.equal(broke.json.code, "INSUFFICIENT_BALANCE"); assert.equal(broke.json.balance, 6500.5);
  assert.equal((await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: main._id, amount: 1 })).json.code, "SAME_BOX");
  assert.equal((await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: wallet._id, amount: 0 })).status, 400);
  assert.equal((await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: wallet._id, amount: 1.234 })).status, 400);
  assert.equal((await call("POST", `/api/cashbox/transfers/${made.json._id}/cancel`, { reason: "x" })).status, 400, "a reason of 3+ characters");
  // The wallet spends the money: the transfer can no longer be undone.
  const spent = await call("POST", "/api/expenses", { accountId: await category(), amount: 6000, boxId: wallet._id });
  assert.equal(spent.status, 201);
  const blocked = await call("POST", `/api/cashbox/transfers/${made.json._id}/cancel`, { reason: "غلط في المبلغ" });
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "INSUFFICIENT_BALANCE");
  assert.equal((await call("POST", `/api/expenses/${spent.json._id}/cancel`, { reason: "كان غلط" })).status, 200);
  const cancelled = await call("POST", `/api/cashbox/transfers/${made.json._id}/cancel`, { reason: "غلط في المبلغ" });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.json.status, "cancelled"); assert.equal(cancelled.json.cancelReason, "غلط في المبلغ");
  assert.equal((await entriesOf("transfer", made.json._id)).length, 2, "the original stays, a reversal is added");
  assert.equal(await balanceOf(main), 20000); assert.equal(await balanceOf(wallet), 5000);
  assert.equal((await call("POST", `/api/cashbox/transfers/${made.json._id}/cancel`, { reason: "again again" })).json.code, "ALREADY_CANCELLED");
  const list = (await call("GET", "/api/cashbox/transfers")).json;
  assert.equal(list.data[0].fromBoxName, "الخزنة الرئيسية");
  await assertHealthy();
});

// ------------------------------------------------------------ expenses

it("expenses: Dr category / Cr box, INSUFFICIENT_BALANCE, cancel is a reversal; categories add, rename and stop", async () => {
  const { main, wallet } = await shop();
  const rent = await category("522");
  const made = await call("POST", "/api/expenses", { date: "2026-11-02", accountId: rent, amount: 1200, boxId: main._id, note: "إيجار نوفمبر" });
  assert.equal(made.status, 201, JSON.stringify(made.json)); assert.match(made.json.number, /^EX-\d{6}$/);
  const [entry] = await entriesOf("expense", made.json._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["EXP_RENT", 1200, 0], ["CASH_MAIN", 0, 1200]]);
  const broke = await call("POST", "/api/expenses", { accountId: rent, amount: 5000.01, boxId: wallet._id });
  assert.equal(broke.status, 409); assert.equal(broke.json.code, "INSUFFICIENT_BALANCE");
  assert.equal((await call("POST", "/api/expenses", { accountId: String((await Account.findOne({ code: "520" }).lean())._id), amount: 5 })).json.code, "INVALID_CATEGORY", "a group is not a category");
  assert.equal((await call("POST", "/api/expenses", { accountId: String((await Account.findOne({ code: "410" }).lean())._id), amount: 5 })).json.code, "INVALID_CATEGORY");
  assert.equal((await call("POST", "/api/expenses", { accountId: rent, amount: -5 })).status, 400);
  const cancelled = await call("POST", `/api/expenses/${made.json._id}/cancel`, { reason: "اتسجل مرتين" });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.json.status, "cancelled");
  assert.equal((await entriesOf("expense", made.json._id)).length, 2);
  assert.equal(await balanceOf(main), 20000);
  assert.equal((await call("POST", `/api/expenses/${made.json._id}/cancel`, { reason: "again again" })).json.code, "ALREADY_CANCELLED");

  const added = await call("POST", "/api/expenses/categories", { nameAr: "صيانة", nameEn: "Maintenance" });
  assert.equal(added.status, 201, JSON.stringify(added.json)); assert.equal(added.json.code, "526");
  const second = await call("POST", "/api/expenses/categories", { nameAr: "دعاية" });
  assert.equal(second.json.code, "527"); assert.equal(second.json.nameEn, "دعاية");
  const account = await Account.findOne({ code: "526" }).lean();
  assert.deepEqual([account.type, account.normalSide, account.isSystem, account.isGroup], ["expense", "debit", false, false]);
  assert.equal((await call("PUT", `/api/expenses/categories/${added.json._id}`, { nameAr: "صيانة وإصلاح" })).json.nameAr, "صيانة وإصلاح");
  assert.equal((await call("PUT", `/api/expenses/categories/${rent}`, { nameAr: "x" })).json.code, "SYSTEM_CATEGORY");
  const used = await call("POST", "/api/expenses", { accountId: added.json._id, amount: 10, boxId: main._id });
  assert.equal(used.status, 201);
  assert.equal((await call("PUT", `/api/expenses/categories/${added.json._id}`, { isActive: false })).json.code, "CATEGORY_HAS_LINES");
  assert.equal((await call("PUT", `/api/expenses/categories/${second.json._id}`, { isActive: false })).json.isActive, false);
  assert.equal((await call("POST", "/api/expenses", { accountId: second.json._id, amount: 5 })).json.code, "INVALID_CATEGORY", "a stopped category takes no expense");
  const cats = (await call("GET", "/api/expenses/categories")).json.data;
  assert.deepEqual(cats.map((row) => row.code), ["521", "522", "523", "524", "525", "526", "527"]);
  assert.equal(cats.find((row) => row.code === "526").hasLines, true);
  await assertHealthy();
});

it("expenses list: month, category and box filters, this month's total and last month's breakdown by category", async () => {
  const { main, wallet } = await shop();
  const rent = await category("522"); const power = await category("523"); const misc = await category("525");
  for (const [date, accountId, amount, box] of [
    ["2026-10-03", rent, 1000, main], ["2026-10-15", power, 300, main], ["2026-10-20", power, 200, wallet],
    ["2026-11-02", rent, 1200, main], ["2026-11-04", misc, 80, wallet], ["2026-11-05", power, 150, main],
  ]) assert.equal((await call("POST", "/api/expenses", { date, accountId, amount, boxId: box._id })).status, 201);
  const cancelled = await call("POST", "/api/expenses", { date: "2026-11-06", accountId: misc, amount: 999, boxId: main._id });
  assert.equal((await call("POST", `/api/expenses/${cancelled.json._id}/cancel`, { reason: "غلط في الإدخال" })).status, 200);
  const month = (await call("GET", "/api/expenses?month=2026-11")).json;
  assert.equal(month.month, "2026-11"); assert.equal(month.total, 1430); assert.equal(month.count, 3);
  assert.equal(month.data.length, 4, "the cancelled one is listed but not counted");
  assert.deepEqual(month.byCategory.map((row) => [row.code, row.total]), [["522", 1200], ["523", 150], ["525", 80]]);
  assert.equal(month.previous.month, "2026-10"); assert.equal(month.previous.total, 1500);
  assert.deepEqual(month.previous.byCategory.map((row) => [row.code, row.total]), [["522", 1000], ["523", 500]]);
  assert.equal(month.data[0].categoryName !== null, true);
  const byCategory = (await call("GET", `/api/expenses?month=2026-11&category=${power}`)).json;
  assert.deepEqual([byCategory.total, byCategory.data.length], [150, 1]);
  const byBox = (await call("GET", `/api/expenses?month=2026-11&box=${wallet._id}`)).json;
  assert.deepEqual([byBox.total, byBox.previous.total], [80, 200]);
  assert.equal((await call("GET", "/api/expenses?month=2026-13")).status, 400);
});

// ------------------------------------------------------------ owner drawings

it("owner drawings: Dr OWNER_DRAWINGS (33) / Cr box, DR-000001, a balance check, cancel is a reversal, owner only", async () => {
  const { main, wallet } = await shop();
  const made = await call("POST", "/api/cashbox/drawings", { amount: 2500, boxId: main._id, note: "سحب شخصي", date: "2026-11-05" });
  assert.equal(made.status, 201, JSON.stringify(made.json)); assert.equal(made.json.number, "DR-000001");
  const [entry] = await entriesOf("owner_drawing", made.json._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["OWNER_DRAWINGS", 2500, 0], ["CASH_MAIN", 0, 2500]]);
  assert.equal((await call("POST", "/api/cashbox/drawings", { amount: 5000.01, boxId: wallet._id })).json.code, "INSUFFICIENT_BALANCE");
  assert.equal(await balanceOf(main), 17500);
  assert.equal((await call("GET", "/api/cashbox/drawings")).json.data[0].boxName, "الخزنة الرئيسية");
  assert.equal((await call("POST", `/api/cashbox/drawings/${made.json._id}/cancel`, { reason: "اتسحب بالغلط" })).status, 200);
  assert.equal(await balanceOf(main), 20000);
  assert.equal((await entriesOf("owner_drawing", made.json._id)).length, 2);
  const manager = await makeUser("mgr-draw", "manager");
  token = manager;
  assert.equal((await call("POST", "/api/cashbox/drawings", { amount: 1, boxId: main._id })).status, 403, "the manager template has no owner.drawings");
  assert.equal(ROLE_TEMPLATES.manager.includes("owner.drawings"), false);
  assert.equal(ROLE_TEMPLATES.owner.includes("owner.drawings"), true);
  token = ownerToken;
  await assertHealthy();
});

// ------------------------------------------------------------ customer credit

it("customer credit: pay it out of a box and apply it to open invoices; the ledger equals the statement after each step", async () => {
  const { main, wallet } = await shop();
  const c = await customer("Credit Customer", "01010000195");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, banks: [{ accountId: String(wallet.accountId), amount: 5000 }], customers: [{ customerId: String(c._id), amount: -500 }] })).status, 200);
  const p = await product({ code: "CREDIT-1" });
  let credit = (await call("GET", `/api/customers/${c._id}/credit`)).json;
  assert.deepEqual([credit.balance, credit.credit, credit.applicable], [-500, 500, 0]);
  const tooMuch = await call("POST", `/api/customers/${c._id}/payouts`, { amount: 500.01, boxId: main._id });
  assert.equal(tooMuch.status, 409); assert.equal(tooMuch.json.code, "EXCEEDS_CREDIT");
  const poor = await createBox({ name: "فاضية", type: "wallet" });
  assert.equal((await call("POST", `/api/customers/${c._id}/payouts`, { amount: 100, boxId: poor._id })).json.code, "INSUFFICIENT_BALANCE");

  const payout = await call("POST", `/api/customers/${c._id}/payouts`, { amount: 200, boxId: wallet._id, note: "صرف نقدي" });
  assert.equal(payout.status, 201, JSON.stringify(payout.json)); assert.equal(payout.json.payout.number, "CP-000001");
  const [entry] = await entriesOf("customer_payout", payout.json.payout._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["CUSTOMERS", 200, 0], ["11201", 0, 200]]);
  let statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.deepEqual(statement.lines.map((row) => [row.type, row.description, row.debit, row.credit]), [["opening_balance", "رصيد أول المدة", 0, 500], ["payout", "صرف رصيد دائن", 200, 0]]);
  assert.equal(statement.totals.balance, -300);
  assert.equal(statement.credit.credit, 300, "the statement tells the screen about the credit");
  await assertHealthy();

  // An open invoice: 100 owed, 300 credit. Applying 100 posts nothing and the statement shows nothing new.
  const invoice = await creditSale(c, p, 100);
  credit = (await call("GET", `/api/customers/${c._id}/credit`)).json;
  assert.deepEqual([credit.balance, credit.credit, credit.openItems, credit.applicable], [-200, 200, 100, 100]);
  const entriesBefore = await JournalEntry.countDocuments({});
  const linesBefore = (await call("GET", `/api/customers/${c._id}/statement`)).json.lines.length;
  assert.equal((await call("POST", `/api/customers/${c._id}/apply-credit`, { amount: 100.01 })).json.code, "EXCEEDS_CREDIT");
  const applied = await call("POST", `/api/customers/${c._id}/apply-credit`, { amount: 100 });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.allocations.map((row) => [row.kind, row.amount]), [["invoice", 100]]);
  assert.equal(await JournalEntry.countDocuments({}), entriesBefore, "no entry: same party");
  statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.lines.length, linesBefore, "the statement shows nothing new");
  assert.equal(statement.totals.balance, -200); assert.equal(statement.outstanding, 0);
  const after = (await call("GET", `/api/credit-sales/${invoice._id}`)).json;
  assert.deepEqual([after.remainingAmount, after.status], [0, "paid"]);
  assert.equal((await call("POST", `/api/customers/${c._id}/apply-credit`, { amount: 1 })).json.code, "EXCEEDS_CREDIT", "nothing open any more");
  await assertHealthy();

  // The rest of the credit goes out, and a cancelled payout restores it.
  const rest = await call("POST", `/api/customers/${c._id}/payouts`, { amount: 200, boxId: main._id });
  assert.equal(rest.status, 201); assert.equal(rest.json.credit.credit, 0);
  assert.equal((await call("POST", `/api/customers/${c._id}/payouts`, { amount: 1, boxId: main._id })).json.code, "EXCEEDS_CREDIT");
  const undone = await call("POST", `/api/customers/${c._id}/payouts/${rest.json.payout._id}/cancel`, { reason: "اتصرف بالغلط" });
  assert.equal(undone.status, 200); assert.equal(undone.json.credit.credit, 200);
  statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.deepEqual(statement.lines.slice(-2).map((row) => [row.type, row.debit, row.credit]), [["payout", 200, 0], ["payout_cancel", 0, 200]]);
  assert.equal((await call("POST", `/api/customers/${c._id}/payouts/${rest.json.payout._id}/cancel`, { reason: "again again" })).json.code, "ALREADY_CANCELLED");
  const a = await assertHealthy();
  assert.equal(a.customers.difference, 0);
  assert.equal(await balanceOf(main), 20000, "payout and its cancel net out");
});

it("apply-credit takes the oldest open invoices first and posts nothing", async () => {
  await shop();
  const c = await customer("Two Items", "01010000196");
  const p = await product({ code: "APPLY-2" });
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, customers: [{ customerId: String(c._id), amount: -500 }] })).status, 200);
  const first = await creditSale(c, p, 100); const second = await creditSale(c, p, 100);
  const credit = (await call("GET", `/api/customers/${c._id}/credit`)).json;
  assert.deepEqual([credit.balance, credit.credit, credit.openItems, credit.applicable], [-300, 300, 200, 200]);
  const applied = await call("POST", `/api/customers/${c._id}/apply-credit`, { amount: 150 });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.allocations.map((row) => [row.number, row.amount]), [[first.number, 100], [second.number, 50]]);
  assert.deepEqual([(await call("GET", `/api/credit-sales/${first._id}`)).json.remainingAmount, (await call("GET", `/api/credit-sales/${second._id}`)).json.remainingAmount], [0, 50]);
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  assert.equal(statement.totals.balance, -300, "unchanged"); assert.equal(statement.outstanding, 50);
  assert.deepEqual(statement.aging.total, 50);
  assert.equal(statement.lines.some((row) => row.type === "payment"), false, "no payment line: the credit never left the customer");
  await assertHealthy();
});

// ------------------------------------------------------------ permissions

it("permissions per role: templates, 403s and the cashier's own boxes", async () => {
  const { main, wallet } = await shop();
  const drawer = await createBox({ name: "درج PC", type: "cash", deviceId: DEVICE_A });
  await createBox({ name: "درج PC-B", type: "cash", deviceId: DEVICE_B });
  const roles = { cashier: await makeUser("cash19", "cashier"), accountant: await makeUser("acc19", "accountant"), storekeeper: await makeUser("keep19", "storekeeper"), manager: await makeUser("mgr19", "manager") };
  const rent = await category("522");
  const permProduct = await product({ code: "PERM-1" });
  const seen = {};
  for (const [name, userToken] of Object.entries(roles)) {
    token = userToken;
    seen[name] = {
      boxes: (await call("GET", "/api/cashbox/boxes")).status,
      createBox: (await call("POST", "/api/cashbox/boxes", { name: `B-${name}`, type: "wallet" })).status,
      transfer: (await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: wallet._id, amount: 1 })).status,
      devices: (await call("GET", "/api/devices")).status,
      shifts: (await call("GET", "/api/shifts")).status,
      paymentBoxes: (await call("GET", "/api/cashbox/payment-boxes")).status,
      expenseList: (await call("GET", "/api/expenses")).status,
      expenseCreate: (await call("POST", "/api/expenses", { accountId: rent, amount: 5, boxId: main._id })).status,
      category: (await call("POST", "/api/expenses/categories", { nameAr: `بند ${name}` })).status,
      drawings: (await call("POST", "/api/cashbox/drawings", { amount: 1, boxId: main._id })).status,
    };
  }
  token = ownerToken;
  assert.deepEqual(seen.cashier, { boxes: 403, createBox: 403, transfer: 403, devices: 403, shifts: 200, paymentBoxes: 200, expenseList: 200, expenseCreate: 201, category: 403, drawings: 403 });
  assert.deepEqual(seen.accountant, { boxes: 200, createBox: 403, transfer: 403, devices: 403, shifts: 403, paymentBoxes: 200, expenseList: 200, expenseCreate: 201, category: 201, drawings: 403 });
  assert.deepEqual(seen.storekeeper, { boxes: 403, createBox: 403, transfer: 403, devices: 403, shifts: 403, paymentBoxes: 200, expenseList: 403, expenseCreate: 403, category: 403, drawings: 403 });
  assert.deepEqual(seen.manager, { boxes: 200, createBox: 201, transfer: 201, devices: 200, shifts: 200, paymentBoxes: 200, expenseList: 200, expenseCreate: 201, category: 201, drawings: 403 });
  assert.deepEqual(ROLE_TEMPLATES.cashier.filter((key) => /cashbox|shift|expenses|owner/.test(key)), ["shift.operate", "expenses.create"]);
  assert.deepEqual(ROLE_TEMPLATES.accountant.filter((key) => /cashbox|shift|expenses|owner/.test(key)), ["cashbox.view", "expenses.create", "expenses.manage"]);
  assert.deepEqual(ROLE_TEMPLATES.storekeeper.filter((key) => /cashbox|shift|expenses|owner/.test(key)), []);
  assert.deepEqual(ROLE_TEMPLATES.manager.filter((key) => /cashbox|shift|expenses|owner/.test(key)), ["cashbox.view", "cashbox.manage", "shift.operate", "shift.manage", "expenses.create", "expenses.manage"]);
  assert.equal(ROLE_TEMPLATES.accountant.includes("products.viewCost"), true, "cashbox.view needs no cost permission of its own");
  // A cashier on PC A: their drawer + wallets/banks, never the main box or PC B's drawer.
  token = roles.cashier;
  const listA = (await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_A))).json;
  assert.deepEqual(listA.data.map((box) => box.name).sort(), ["B-manager", "Vodafone Cash", "درج PC"].sort());
  assert.equal(String(listA.defaultBoxId), String(drawer._id));
  assert.equal(listA.data.every((box) => box.balance === undefined), true, "no balances for a cashier");
  assert.equal(listA.mainBox.name, "الخزنة الرئيسية", "the main box is still named, for the shift deposit");
  const noDrawer = (await call("GET", "/api/cashbox/payment-boxes", null, asDevice("device-eeee-0005"))).json;
  assert.deepEqual(noDrawer.data.map((box) => box.name).sort(), ["B-manager", "Vodafone Cash", "الخزنة الرئيسية"].sort(), "no drawer on this PC: the main box is the default");
  assert.equal((await sell(permProduct, 100, { boxId: main._id }, asDevice(DEVICE_A))).json.code, "BOX_NOT_ALLOWED", "the main box is not for a cashier whose PC has a drawer");
  token = ownerToken;
  const managerList = (await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_A))).json;
  assert.equal(managerList.data.length, await CashBox.countDocuments({ isActive: true }), "cashbox.manage sees every active box");
});

// ------------------------------------------------------------ screens' data

it("box detail: balance, open shift, bound device, ledger with source and running balance, and its shifts", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash", deviceId: DEVICE_A });
  await call("GET", "/api/cashbox/payment-boxes", null, asDevice(DEVICE_A, "PC-A"));
  await transfer(main, drawer, 250);
  const shift = (await openShift(drawer, 250)).json;
  const detail = (await call("GET", `/api/cashbox/boxes/${drawer._id}`)).json;
  assert.deepEqual([detail.balance, detail.deviceName, detail.openShift.number, detail.shifts.length, detail.accountCode], [250, "PC-A", shift.number, 1, "11102"]);
  const ledger = await call("GET", `/api/cashbox/boxes/${drawer._id}/ledger`);
  assert.equal(ledger.status, 200);
  assert.deepEqual(ledger.json.lines.map((row) => [row.source.type, row.debit, row.credit, row.balance]), [["transfer", 250, 0, 250]]);
  const all = (await call("GET", "/api/cashbox/boxes")).json;
  assert.equal(all.cashTotal, 20000, "cash-type boxes only (main + drawer; a transfer between them changes nothing), not the wallet");
  assert.equal(all.data.find((box) => box.type === "wallet").balance, 5000);
  assert.equal((await call("GET", "/api/cashbox/boxes/6aedeb5a72fe63af6a006478")).status, 404);
});

// ------------------------------------------------------------ health

it("health boxes can fail: a tampered box line, an expense without its box line, an unboxed account", async () => {
  const { main } = await shop();
  const clean = await assertHealthy();
  assert.deepEqual(clean.boxes.byBox.map((row) => [row.name, row.expected, row.actual, row.difference]), [["الخزنة الرئيسية", 20000, 20000, 0], ["Vodafone Cash", 5000, 5000, 0]]);
  // 1. An expense document with no ledger entry: the box holds more than its documents say.
  await Expense.create({ number: "EX-900001", date: new Date(), accountId: await category(), amount: 40, boxId: main._id });
  let health = (await call("GET", "/api/accounting/health")).json;
  assert.equal(health.boxes.difference, 40); assert.equal(health.boxes.byBox[0].difference, 40);
  await Expense.deleteMany({});
  // 2. A balanced entry that moves 25 into the main box from nowhere.
  await withTransaction(async (session) => {
    const accounts = await accountMap(["CASH_MAIN", "CAPITAL"], session);
    await postEntry({ date: new Date(), source: { type: "tamper", id: new (require("mongoose").Types.ObjectId)(), number: "T-2" }, session, lines: [line(accounts.get("CASH_MAIN"), 25, "debit"), line(accounts.get("CAPITAL"), 25, "credit")] });
  });
  health = (await call("GET", "/api/accounting/health")).json;
  assert.equal(health.boxes.difference, 25);
  assert.equal(health.trialBalance.difference, 0, "the other checks do not see it");
  // 3. Money on a 112xx leaf that has no box.
  await CashBox.deleteOne({ name: "Vodafone Cash" });
  health = (await call("GET", "/api/accounting/health")).json;
  assert.equal(health.boxes.unboxed, 5000);
  assert.equal(health.boxes.difference, 5025);
});

it("a mixed day: sales, receipts, returns, cancels, expenses, transfers, shifts, drawings and payouts keep every health check at zero", async () => {
  const { main, wallet } = await shop();
  const drawer = await createBox({ name: "درج اليوم", type: "cash", deviceId: DEVICE_A });
  const p = await product({ code: "MIXED-1", stock: 100 });
  const c = await customer("Mixed Customer", "01010000197"); const d = await customer("Mixed Owed", "01010000198");
  await transfer(main, drawer, 1000);
  const shift = (await openShift(drawer, 1000, {}, asDevice(DEVICE_A))).json;
  const a = await sold(p, 250, {}, asDevice(DEVICE_A));          // into the drawer by default
  const b = await sold(p, 400, { boxId: wallet._id });
  const invoice = await creditSale(c, p, 900, { downPayment: 300 }, asDevice(DEVICE_A));
  assert.equal((await call("POST", `/api/credit-sales/${invoice._id}/payments`, { amount: 100, boxId: wallet._id })).status, 201);
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: a._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] }, asDevice(DEVICE_A))).status, 201);
  assert.equal((await call("POST", `/api/sellings/${b._id}/cancel`, { reason: "mixed day cancel" })).status, 200);
  const second = await creditSale(d, p, 500, { downPayment: 50, boxId: wallet._id });
  assert.equal((await call("POST", `/api/credit-sales/${second._id}/cancel`, { reason: "mixed day refund", boxId: wallet._id })).status, 200);
  assert.equal((await call("POST", "/api/expenses", { accountId: await category("523"), amount: 75, boxId: drawer._id })).status, 201);
  const extra = await call("POST", "/api/expenses", { accountId: await category("524"), amount: 30, boxId: main._id });
  assert.equal((await call("POST", `/api/expenses/${extra.json._id}/cancel`, { reason: "mixed day expense" })).status, 200);
  await transfer(wallet, main, 200);
  assert.equal((await call("POST", "/api/cashbox/drawings", { amount: 500, boxId: main._id })).status, 201);
  const report = (await call("GET", `/api/shifts/${shift._id}`)).json;
  assert.equal((await call("POST", `/api/shifts/${shift._id}/close`, { counted: report.expected - 10, differenceNote: "عجز 10", depositBoxId: main._id, depositAmount: 500 })).status, 200);
  const health = await assertHealthy();
  assert.ok(health.boxes.byBox.length >= 3);
  assert.equal(health.boxes.byBox.every((row) => row.difference === 0), true);
  assert.equal(health.netSales.difference, 0); assert.equal(health.cogs.difference, 0);
});

it("the opening wizard gives every new bank or wallet its box; the box takes the wizard's opening amount into the health check", async () => {
  await startLedger();
  const saved = await call("POST", "/api/accounting/opening", { cash: 1000, banks: [{ name: "Banque Misr", type: "bank", amount: 30000 }, { name: "InstaPay", type: "wallet", amount: 0 }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const boxes = await CashBox.find({}).sort({ sortOrder: 1 }).lean();
  assert.deepEqual(boxes.map((box) => [box.name, box.type]), [["الخزنة الرئيسية", "cash"], ["Banque Misr", "bank"]]);
  const health = await assertHealthy();
  assert.deepEqual(health.boxes.byBox.map((row) => [row.name, row.expected, row.actual]), [["الخزنة الرئيسية", 1000, 1000], ["Banque Misr", 30000, 30000]]);
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 1000, banks: [{ name: "Banque Misr", type: "bank", amount: 20000, accountId: String(boxes[1].accountId) }, { name: "InstaPay", type: "wallet", amount: 10 }] })).status, 200);
  assert.equal(await CashBox.countDocuments({}), 3, "a later wizard save adds the new wallet's box");
  await assertHealthy();
});

it("stage 19 audit entries and numbers: TR, DR, CP, SH, EX prefixes start at 000001", async () => {
  const { main, wallet } = await shop();
  await transfer(main, wallet, 10);
  await call("POST", "/api/cashbox/drawings", { amount: 10, boxId: main._id });
  await call("POST", "/api/expenses", { accountId: await category(), amount: 10, boxId: main._id });
  const counters = Object.fromEntries((await Counter.find({}).lean()).map((row) => [row._id, row.seq]));
  assert.deepEqual([counters.TR, counters.DR, counters.EX], [1, 1, 1]);
  for (const action of ["transfer.created", "drawing.created", "expense.created"]) assert.ok(await AuditLog.findOne({ action }), action);
});
