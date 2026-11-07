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
  assert.equal(await runMigrations(), 8);
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
  assert.equal(await runMigrations(), 8, "idempotent");
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
  assert.equal((await call("POST", `/api/sellings/${cancelSale._id}/cancel`, { reason: "wrong item", boxId: wallet._id })).status, 200);
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
  assert.deepEqual(lines, { float: 500, sales: 6820, receipts: 600, transfersIn: 0, supplierRefunds: 0, refunds: 120, expenses: 250, transfersOut: 0, payouts: 0, drawings: 0, supplierPayments: 0 });
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
  assert.deepEqual(shift.breakdown.map((row) => row.key), ["float", "sales", "receipts", "transfersIn", "supplierRefunds", "refunds", "expenses", "transfersOut", "payouts", "drawings", "supplierPayments"]);
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
  const noNote = await openShift(drawer, 480, { confirmFloat: true });
  assert.equal(noNote.status, 400); assert.equal(noNote.json.code, "NOTE_REQUIRED");
  const second = await openShift(drawer, 480, { confirmFloat: true, openingNote: "20 ناقصة في العد" });
  assert.equal(second.status, 201); assert.equal(second.json.openingBalance, 500); assert.equal(second.json.openingDifference, -20);
  assert.equal(await balanceOf(drawer), 480, "the opening shortage is posted: the box balance is the float");
  const [openEntry] = await entriesOf("shift_open", second.json._id);
  assert.deepEqual(openEntry.lines.map((row) => [row.key, row.debit, row.credit]), [["CASH_OVER_SHORT", 20, 0], ["11102", 0, 20]]);
  assert.equal((await openShift(drawer, 500)).json.code, "SHIFT_ALREADY_OPEN");
  assert.equal(await JournalEntry.countDocuments({ "source.type": "shift" }), 0, "opening an even float posts nothing at close");
  await sold(p, 100, { boxId: drawer._id });
  const over = await call("POST", `/api/shifts/${second.json._id}/close`, { counted: 600, differenceNote: "زيادة" });
  assert.equal(over.json.expected, 580); assert.equal(over.json.difference, 20);
  const [entry] = await entriesOf("shift", second.json._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["11102", 20, 0], ["CASH_OVER_SHORT", 0, 20]]);
  assert.equal(await balanceOf(drawer), 600, "ledger = counted");
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
  assert.equal(added.status, 201, JSON.stringify(added.json)); assert.equal(added.json.code, "52001");
  const second = await call("POST", "/api/expenses/categories", { nameAr: "دعاية" });
  assert.equal(second.json.code, "52002"); assert.equal(second.json.nameEn, "دعاية");
  const account = await Account.findOne({ code: "52001" }).lean();
  assert.deepEqual([account.type, account.normalSide, account.isSystem, account.isGroup], ["expense", "debit", false, false]);
  assert.equal((await call("PUT", `/api/expenses/categories/${added.json._id}`, { nameAr: "صيانة وإصلاح" })).json.nameAr, "صيانة وإصلاح");
  assert.equal((await call("PUT", `/api/expenses/categories/${rent}`, { nameAr: "x" })).json.code, "SYSTEM_CATEGORY");
  const used = await call("POST", "/api/expenses", { accountId: added.json._id, amount: 10, boxId: main._id });
  assert.equal(used.status, 201);
  assert.equal((await call("PUT", `/api/expenses/categories/${added.json._id}`, { isActive: false })).json.code, "CATEGORY_HAS_LINES");
  assert.equal((await call("PUT", `/api/expenses/categories/${second.json._id}`, { isActive: false })).json.isActive, false);
  assert.equal((await call("POST", "/api/expenses", { accountId: second.json._id, amount: 5 })).json.code, "INVALID_CATEGORY", "a stopped category takes no expense");
  const cats = (await call("GET", "/api/expenses/categories")).json.data;
  assert.deepEqual(cats.map((row) => row.code), ["521", "522", "523", "524", "525", "52001", "52002"]);
  assert.equal(cats.find((row) => row.code === "52001").hasLines, true);
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
  assert.deepEqual(seen.cashier, { boxes: 403, createBox: 403, transfer: 403, devices: 403, shifts: 200, paymentBoxes: 200, expenseList: 200, expenseCreate: 403, category: 403, drawings: 403 });
  assert.deepEqual(seen.accountant, { boxes: 200, createBox: 403, transfer: 403, devices: 403, shifts: 403, paymentBoxes: 200, expenseList: 200, expenseCreate: 403, category: 201, drawings: 403 });
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

// ================================================================== Stage 19 review fixes

const healthOf = async () => (await call("GET", "/api/accounting/health")).json;
const closeShift = (shift, counted, extra = {}) => call("POST", `/api/shifts/${shift._id}/close`, { counted, ...extra });
const ledgerOf = async (box) => (await call("GET", `/api/cashbox/boxes/${box._id}`)).json.balance;
const ObjectId = (value) => new (require("mongoose").Types.ObjectId)(value);

// ---- 1. a confirmed float difference is posted at opening

it("review 1: balance 960, float 930 confirmed with a note, a sale of 100, an honest count of 1,030: opening diff 30 posted, close diff 0, ledger 1,030", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 960);
  assert.equal((await openShift(drawer, 930)).json.code, "FLOAT_MISMATCH");
  assert.equal((await openShift(drawer, 930, { confirmFloat: true })).json.code, "NOTE_REQUIRED");
  const opened = await openShift(drawer, 930, { confirmFloat: true, openingNote: "30 ناقصة" });
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  assert.deepEqual([opened.json.openingDifference, opened.json.openingNote], [-30, "30 ناقصة"]);
  const [entry] = await entriesOf("shift_open", opened.json._id);
  assert.deepEqual(entry.lines.map((row) => [row.key, row.debit, row.credit]), [["CASH_OVER_SHORT", 30, 0], ["11102", 0, 30]]);
  assert.equal(await ledgerOf(drawer), 930, "after opening the box balance is the float");
  const p = await product({ code: "REV-1" });
  await sold(p, 100, { boxId: drawer._id });
  const report = (await call("GET", `/api/shifts/${opened.json._id}`)).json;
  assert.deepEqual([report.expected, report.openingDifference], [1030, -30]);
  const closed = await closeShift(opened.json, 1030);
  assert.equal(closed.status, 200, JSON.stringify(closed.json)); assert.equal(closed.json.difference, 0);
  assert.equal(await ledgerOf(drawer), 1030);
  const health = await assertHealthy();
  assert.deepEqual(health.shifts.byShift.map((row) => [row.phase, row.expected, row.actual]), [["open", 930, 930], ["close", 1030, 1030]]);
  // An overage at opening is the reverse.
  const second = await openShift(drawer, 1050, { confirmFloat: true, openingNote: "20 زيادة" });
  assert.equal(second.json.openingDifference, 20);
  assert.deepEqual((await entriesOf("shift_open", second.json._id))[0].lines.map((row) => [row.key, row.debit, row.credit]), [["11102", 20, 0], ["CASH_OVER_SHORT", 0, 20]]);
  assert.equal(await ledgerOf(drawer), 1050);
  await assertHealthy();
});

it("review 1, can fail: an opening difference that was never posted (the old behaviour) leaves the drawer 30 off: only the shifts check sees it", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 960);
  const opened = (await openShift(drawer, 930, { confirmFloat: true, openingNote: "30 ناقصة" })).json;
  // Old code: nothing posted, nothing recorded.
  await JournalEntry.deleteMany({ "source.type": "shift_open" });
  await Shift.updateOne({ _id: opened._id }, { $unset: { openingDifference: "", openingNote: "" } });
  const p = await product({ code: "REV-1B" });
  await sold(p, 100, { boxId: drawer._id });
  assert.equal((await closeShift(opened, 1030)).json.difference, 0, "930 + 100 = 1,030 counted: nothing to post");
  const health = await healthOf();
  assert.equal(health.boxes.difference, 0, "the documents agree with the ledger (both miss the 30)");
  assert.equal(health.shifts.difference, 60, "but the ledger holds 960 at opening instead of 930 and 1,060 at close instead of 1,030");
  assert.deepEqual(health.shifts.byShift.map((row) => [row.phase, row.difference]), [["open", 30], ["close", 30]]);
});

// ---- 2. an edit made in a later shift

const twoShifts = async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  const p = await product({ code: "REV-2" });
  const one = (await openShift(drawer, 0)).json;
  const sale = await sold(p, 300, { boxId: drawer._id });
  assert.equal((await closeShift(one, 300)).status, 200);
  const two = (await openShift(drawer, 300)).json;
  return { main, drawer, sale, two };
};

it("review 2: a sale of 300 in shift 1 edited to 250 during shift 2: shift 2 expected includes -50, an honest close posts 0, health stays 0", async () => {
  const { drawer, sale, two } = await twoShifts();
  const edited = await call("PUT", `/api/sellings/${sale._id}`, { price: 250 });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const stored = await Selling.findById(sale._id).lean();
  assert.deepEqual(stored.boxMoves.map((move) => [move.delta, String(move.boxId)]), [[-50, String(drawer._id)]]);
  const report = (await call("GET", `/api/shifts/${two._id}`)).json;
  assert.equal(Object.fromEntries(report.lines.map((row) => [row.key, row.amount])).sales, -50);
  assert.equal(report.expected, 250);
  const closed = await closeShift(two, 250);
  assert.equal(closed.json.difference, 0);
  assert.equal(await ledgerOf(drawer), 250);
  await assertHealthy();
  // A second edit is a second move.
  assert.equal((await openShift(drawer, 250)).status, 201);
  assert.equal((await call("PUT", `/api/sellings/${sale._id}`, { price: 260 })).status, 200);
  assert.deepEqual((await Selling.findById(sale._id).lean()).boxMoves.map((move) => move.delta), [-50, 10]);
  await assertHealthy();
});

it("review 2, can fail: an edit the shift did not know about (old behaviour) makes the honest close post a wrong difference; the shifts check sees it", async () => {
  const { drawer, sale, two } = await twoShifts();
  assert.equal((await call("PUT", `/api/sellings/${sale._id}`, { price: 250 })).status, 200);
  await Selling.collection.updateOne({ _id: ObjectId(sale._id) }, { $unset: { boxMoves: "" } });
  const closed = await closeShift(two, 250, { differenceNote: "عجز" });
  assert.equal(closed.json.difference, -50, "expected stayed 300: the -50 edit was missed");
  const health = await healthOf();
  assert.equal(await ledgerOf(drawer), 200);
  assert.equal(health.shifts.difference, 50);
  assert.deepEqual(health.shifts.byShift.filter((row) => row.difference).map((row) => [row.phase, row.expected, row.actual]), [["close", 250, 200]]);
});

// ---- 3. the refund box of a cash-sale cancel

const twoDrawers = async () => {
  const { main } = await shop();
  const d1 = await createBox({ name: "درج ١", type: "cash", deviceId: DEVICE_A });
  const d2 = await createBox({ name: "درج ٢", type: "cash", deviceId: DEVICE_B, openingAmount: 500 });
  const s1 = (await openShift(d1, 0, {}, asDevice(DEVICE_A))).json;
  const s2 = (await openShift(d2, 500, {}, asDevice(DEVICE_B))).json;
  const p = await product({ code: "REV-3" });
  const sale = await sold(p, 100, {}, asDevice(DEVICE_A));
  assert.equal(String(sale.boxId), String(d1._id));
  return { main, d1, d2, s1, s2, sale };
};

it("review 3: a cancel from PC 2 of a drawer-1 sale: drawer 1 keeps the +100, drawer 2 pays it, every shift closes honestly, health 0", async () => {
  const { d1, d2, s1, s2, sale } = await twoDrawers();
  const cancelled = await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "عميل غير رأيه" }, asDevice(DEVICE_B));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const stored = await Selling.findById(sale._id).lean();
  assert.equal(String(stored.cancelRefundBoxId), String(d2._id));
  const [original, reversal] = await entriesOf("sale", sale._id);
  assert.deepEqual(lineOf(original, "11102"), { key: "11102", debit: 100, credit: 0 });
  assert.equal(lineOf(reversal, "11102"), undefined, "the sale's box line is not reversed");
  assert.deepEqual(lineOf(reversal, "11103"), { key: "11103", debit: 0, credit: 100 }, "the refund box pays");
  assert.equal(await ledgerOf(d1), 100); assert.equal(await ledgerOf(d2), 400);
  assert.equal((await closeShift(s1, 100)).json.difference, 0);
  assert.equal((await closeShift(s2, 400)).json.difference, 0);
  await assertHealthy();
});

it("review 3, with a return: the return box keeps -r and the refund box pays total - r", async () => {
  const { main, wallet } = await shop();
  const p = await product({ code: "REV-3B", stock: 10 });
  const sale = await call("POST", "/api/sellings", { ...sellBody(p, 100), items: [{ productId: p._id, quantity: 3, price: 100 }], boxId: main._id });
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale.json._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }], boxId: wallet._id })).status, 201);
  assert.equal((await call("POST", `/api/sellings/${sale.json._id}/cancel`, { reason: "cancel after return", boxId: wallet._id })).status, 200);
  assert.equal(await balanceOf(main), 20000 + 300, "the sale's box keeps the +300 it took");
  assert.equal(await balanceOf(wallet), 5000 - 100 - 200, "the return and the cancel refund both came out of the wallet");
  await assertHealthy();
});

it("review 3, can fail: with the refund box forgotten (old fallback to the sale's box) the honest close of the paying drawer posts a wrong difference", async () => {
  const { s1, s2, sale } = await twoDrawers();
  assert.equal((await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "عميل غير رأيه" }, asDevice(DEVICE_B))).status, 200);
  await Selling.collection.updateOne({ _id: ObjectId(sale._id) }, { $unset: { cancelRefundBoxId: "" } });
  assert.equal((await closeShift(s1, 100, { differenceNote: "x" })).status, 200);
  assert.equal((await closeShift(s2, 400, { differenceNote: "x" })).json.difference, -100, "drawer 2 expected 500: the refund it paid was missed");
  const health = await healthOf();
  assert.ok(health.shifts.difference > 0, JSON.stringify(health.shifts));
  assert.ok(health.shifts.byShift.some((row) => row.number === s2.number && row.phase === "close" && row.difference === -100));
});

it("review 3: a cancel refund into an inactive box, or without an open shift, is refused (409); the cashier cannot pay it from the main box", async () => {
  const { main } = await shop();
  const p = await product({ code: "REV-3C" });
  const stopped = await createBox({ name: "قديمة", type: "wallet" });
  assert.equal((await call("PUT", `/api/cashbox/boxes/${stopped._id}`, { isActive: false })).status, 200);
  const sale = await sold(p, 100, { boxId: main._id });
  const inactive = await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "غلط في الفاتورة", boxId: stopped._id });
  assert.equal(inactive.status, 409); assert.equal(inactive.json.code, "BOX_INACTIVE");
  assert.equal((await Selling.findById(sale._id).lean()).status, "active", "all or nothing");
  const drawer = await createBox({ name: "درج", type: "cash" });
  const noShift = await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "غلط في الفاتورة", boxId: drawer._id });
  assert.equal(noShift.json.code, "NO_OPEN_SHIFT");
  const created = await call("POST", "/api/users", { name: "canceller", username: "cancel-rev3", password: "secret-pass-1", role: "custom", permissions: ["sales.delete"] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  token = await login("cancel-rev3", "secret-pass-1");
  const notAllowed = await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "غلط في الفاتورة" });
  assert.equal(notAllowed.status, 403); assert.equal(notAllowed.json.code, "BOX_NOT_ALLOWED");
  token = ownerToken;
  assert.equal((await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "غلط في الفاتورة" })).status, 200);
});

it("review 3: an edit that changes the cash is refused when the original box is inactive (BOX_INACTIVE) or has no open shift (NO_OPEN_SHIFT)", async () => {
  const { main, wallet } = await shop();
  const p = await product({ code: "REV-3D" });
  const walletSale = await sold(p, 100, { boxId: wallet._id });
  await transfer(wallet, main, 5100);
  assert.equal((await call("PUT", `/api/cashbox/boxes/${wallet._id}`, { isActive: false })).status, 200);
  const inactive = await call("PUT", `/api/sellings/${walletSale._id}`, { price: 120 });
  assert.equal(inactive.status, 409); assert.equal(inactive.json.code, "BOX_INACTIVE");
  // The same edit that changes no money is fine.
  assert.equal((await call("PUT", `/api/sellings/${walletSale._id}`, { customerName: "اسم جديد" })).status, 200);
  const drawer = await createBox({ name: "درج", type: "cash" });
  const shift = (await openShift(drawer, 0)).json;
  const drawerSale = await sold(p, 100, { boxId: drawer._id });
  assert.equal((await closeShift(shift, 100)).status, 200);
  const noShift = await call("PUT", `/api/sellings/${drawerSale._id}`, { price: 90 });
  assert.equal(noShift.status, 409); assert.equal(noShift.json.code, "NO_OPEN_SHIFT");
});

// ---- 4. the customer list shows the statement balance

it("review 4: opening -400, a payout of 150 and an apply of 100: the list shows -150 = the statement; a credit return shows on the list too", async () => {
  const { main } = await shop();
  const c = await customer("List Credit", "01010000199"); const d = await customer("Returned", "01010000198");
  const p = await product({ code: "REV-4" });
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, customers: [{ customerId: String(c._id), amount: -400 }] })).status, 200);
  assert.equal((await call("POST", `/api/customers/${c._id}/payouts`, { amount: 150, boxId: main._id })).status, 201);
  await creditSale(c, p, 100);
  assert.equal((await call("POST", `/api/customers/${c._id}/apply-credit`, { amount: 100 })).status, 200);
  const statement = (await call("GET", `/api/customers/${c._id}/statement`)).json;
  const row = (await call("GET", "/api/customers")).json.find((item) => item._id === String(c._id));
  assert.deepEqual([statement.totals.balance, row.balance, row.credit, row.outstanding], [-150, -150, 150, 0]);
  assert.equal(statement.aging.credit, 150);
  const detail = (await call("GET", `/api/customers/${c._id}`)).json;
  assert.equal(detail.credit, 150);
  // A credit return: 100 paid, 100 returned: we owe the customer 100.
  const paid = await creditSale(d, p, 100, { downPayment: 100, boxId: main._id });
  assert.equal((await call("POST", "/api/returns", { returnType: "credit", invoiceId: paid._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] })).status, 201);
  const second = (await call("GET", "/api/customers")).json.find((item) => item._id === String(d._id));
  assert.deepEqual([second.balance, second.credit], [-100, 100]);
  assert.equal((await call("GET", `/api/customers/${d._id}/statement?from=2026-11-01`)).json.aging.credit, 100, "a period filter does not change the credit");
  await assertHealthy();
});

// ---- 5. expense category codes

it("review 5: 12 new categories are 52001 to 52012 and none collides with 530; migration 8 renames old custom 526-529 and their journal lines", async () => {
  await shop();
  for (let index = 1; index <= 12; index += 1) {
    const made = await call("POST", "/api/expenses/categories", { nameAr: `بند ${index}` });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.code, `520${String(index).padStart(2, "0")}`);
  }
  assert.equal(await Account.countDocuments({ code: "530" }), 1);
  assert.equal((await Account.findOne({ code: "530" }).lean()).systemKey, "CASH_OVER_SHORT");
  assert.equal(await Account.countDocuments({ code: { $in: ["526", "527", "528", "529"] } }), 0);
  // Data from before the fix: custom categories 526 and 527, one with a journal line.
  const parent = await Account.findOne({ code: "520" }).lean();
  const old = await Account.create([{ code: "526", nameAr: "قديم ١", nameEn: "Old 1", type: "expense", normalSide: "debit", parentId: parent._id, isSystem: false }, { code: "527", nameAr: "قديم ٢", nameEn: "Old 2", type: "expense", normalSide: "debit", parentId: parent._id, isSystem: false }]);
  const oldId = old[0]._id;
  await withTransaction(async (session) => {
    const accounts = await accountMap(["CASH_MAIN"], session);
    await postEntry({ date: new Date(), source: { type: "expense", id: ObjectId(), number: "EX-OLD" }, session, lines: [line(old[0].toObject(), 10, "debit"), line(accounts.get("CASH_MAIN"), 10, "credit")] });
  });
  await Meta.updateOne({ _id: "schema" }, { $set: { version: 7 } });
  assert.equal(await runMigrations(), 8);
  assert.deepEqual((await Account.find({ _id: { $in: old.map((row) => row._id) } }).sort({ nameAr: 1 }).lean()).map((row) => row.code), ["52013", "52014"]);
  assert.equal(await Account.countDocuments({ code: { $in: ["526", "527"] } }), 0);
  const entry = await JournalEntry.findOne({ "lines.accountId": oldId }).lean();
  assert.equal(entry.lines.find((row) => String(row.accountId) === String(oldId)).accountCode, "52013");
  assert.equal((await call("GET", "/api/expenses/categories")).json.data.some((row) => row.code === "521"), true, "system categories keep their codes");
});

// ---- 6. money out of the main box needs cashbox.manage

it("review 6: the device header never unlocks the main box: expenses, payouts, refunds from it need cashbox.manage; drawings need owner.drawings", async () => {
  const { main, wallet } = await shop();
  const p = await product({ code: "REV-6" }); const c = await customer("Six", "01010000196");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, banks: [{ accountId: String(wallet.accountId), amount: 5000 }], customers: [{ customerId: String(c._id), amount: -300 }] })).status, 200);
  const sale = await sold(p, 100, { boxId: main._id });
  const cashier = await makeUser("cash-rev6", "cashier");
  const rent = await category("522");
  await createBox({ name: "درج", type: "cash", deviceId: DEVICE_A }); // an active drawer: the shop is no longer a one-box shop
  token = cashier;
  // A PC with no drawer: sales may land in the main box, nothing may leave it.
  const noDrawer = asDevice("device-nodrawer-0009");
  assert.equal((await sell(p, 100, {}, noDrawer)).status, 201, "money in is not restricted");
  for (const result of [
    await call("POST", "/api/expenses", { accountId: rent, amount: 5 }, noDrawer),
    await call("POST", "/api/expenses", { accountId: rent, amount: 5, boxId: main._id }, noDrawer),
    await call("POST", `/api/customers/${c._id}/payouts`, { amount: 5 }, noDrawer),
    await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] }, noDrawer),
    await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "لا يجوز" }, noDrawer),
    await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: wallet._id, amount: 1 }, noDrawer),
  ]) { assert.equal(result.status, 403, JSON.stringify(result.json)); }
  // Wallets and banks are not the main box.
  assert.equal((await call("POST", "/api/expenses", { accountId: rent, amount: 5, boxId: wallet._id }, noDrawer)).status, 201);
  token = ownerToken;
  const manager = await makeUser("mgr-rev6", "manager");
  token = manager;
  assert.equal((await call("POST", "/api/expenses", { accountId: rent, amount: 5, boxId: main._id })).status, 201);
  assert.equal((await call("POST", `/api/customers/${c._id}/payouts`, { amount: 5, boxId: main._id })).status, 201);
  token = ownerToken;
  assert.equal((await call("POST", "/api/cashbox/drawings", { amount: 5, boxId: main._id })).status, 201);
});

// ---- 7. a sale and a close conflict

it("review 7: a sale and a close at the same time: either the sale is in the expected cash, or it is refused NO_OPEN_SHIFT; the ledger always equals the count", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  const p = await product({ code: "REV-7", stock: 200 });
  await transfer(main, drawer, 500);
  for (let round = 0; round < 6; round += 1) {
    const counted = await ledgerOf(drawer);
    const shift = (await openShift(drawer, counted)).json;
    const [sale, close] = await Promise.all([sell(p, 100, { boxId: drawer._id }), closeShift(shift, counted, { differenceNote: "وردية متزامنة" })]);
    assert.equal(close.status, 200, JSON.stringify(close.json));
    if (sale.status === 201) assert.equal(close.json.difference, -100, "the close saw the sale: counted against expected + 100");
    else { assert.equal(sale.json.code, "NO_OPEN_SHIFT"); assert.equal(close.json.difference, 0); }
    const health = await healthOf();
    assert.equal(health.shifts.difference, 0, JSON.stringify(health.shifts));
    assert.equal(health.boxes.difference, 0, JSON.stringify(health.boxes));
  }
});

// ---- 8. the deposit of a shift cannot be cancelled alone; 9. reversals into an inactive box

it("review 8: a shift_deposit transfer cannot be cancelled (409 SHIFT_DEPOSIT)", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  const shift = (await openShift(drawer, 0)).json;
  const p = await product({ code: "REV-8" });
  await sold(p, 100, { boxId: drawer._id });
  assert.equal((await closeShift(shift, 100, { depositBoxId: main._id, depositAmount: 100 })).status, 200);
  const deposit = await Selling.db.collection("transfers").findOne({ kind: "shift_deposit" });
  const refused = await call("POST", `/api/cashbox/transfers/${deposit._id}/cancel`, { reason: "غلطة في التوريد" });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "SHIFT_DEPOSIT");
  assert.equal((await Selling.db.collection("transfers").findOne({ _id: deposit._id })).status, "posted");
  await assertHealthy();
});

it("review 9: cancelling an expense, a payout, a drawing or a transfer into a stopped box is refused (409 BOX_INACTIVE)", async () => {
  const { main } = await shop();
  const c = await customer("Nine", "01010000195");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, customers: [{ customerId: String(c._id), amount: -300 }] })).status, 200);
  const stopBox = async (box) => { assert.equal((await call("PUT", `/api/cashbox/boxes/${box._id}`, { isActive: false })).status, 200); };
  const rent = await category("522");
  const refusal = async (path, body) => { const response = await call("POST", path, body); assert.equal(response.status, 409, `${path} ${JSON.stringify(response.json)}`); assert.equal(response.json.code, "BOX_INACTIVE"); };
  const fresh = (name) => createBox({ name, type: "wallet", openingAmount: 100 });

  const w1 = await fresh("محفظة ١");
  const expense = (await call("POST", "/api/expenses", { accountId: rent, amount: 100, boxId: w1._id })).json;
  await stopBox(w1);
  await refusal(`/api/expenses/${expense._id}/cancel`, { reason: "اتسجل غلط" });

  const w2 = await fresh("محفظة ٢");
  const payout = (await call("POST", `/api/customers/${c._id}/payouts`, { amount: 100, boxId: w2._id })).json.payout;
  await stopBox(w2);
  await refusal(`/api/customers/${c._id}/payouts/${payout._id}/cancel`, { reason: "اتصرف غلط" });

  const w3 = await fresh("محفظة ٣");
  const drawing = (await call("POST", "/api/cashbox/drawings", { amount: 100, boxId: w3._id })).json;
  await stopBox(w3);
  await refusal(`/api/cashbox/drawings/${drawing._id}/cancel`, { reason: "اتسحب غلط" });

  const w4 = await fresh("محفظة ٤");
  const move = await transfer(w4, main, 100);
  await stopBox(w4);
  await refusal(`/api/cashbox/transfers/${move._id}/cancel`, { reason: "تحويل غلط" });
  assert.equal(await Expense.countDocuments({ status: "cancelled" }), 0, "nothing was reversed");
});

// ---- 10. boxes are synced by account, not by count

it("review 10: a 112xx leaf with no box gets its box even when other boxes (drawers) make the counts look complete", async () => {
  await shop();
  await createBox({ name: "درج", type: "cash" });
  const parent = await Account.findOne({ code: "112" }).lean();
  const stray = await Account.create({ code: "11299", nameAr: "حساب بدون خزنة", nameEn: "Stray", type: "asset", normalSide: "debit", parentId: parent._id, isGroup: false, isSystem: false, kind: "bank" });
  assert.equal(await CashBox.countDocuments({ accountId: stray._id }), 0);
  const list = (await call("GET", "/api/cashbox/boxes")).json.data;
  const found = list.find((row) => row.accountCode === "11299");
  assert.ok(found, "the stray account now has a box");
  assert.deepEqual([found.name, found.type], ["حساب بدون خزنة", "bank"]);
  assert.equal(await CashBox.countDocuments({ accountId: stray._id }), 1);
});

// ---- 11. an expense with no box line fails the boxes check

it("review 11, can fail: an expense posted as Dr 521 / Cr CAPITAL (no box line) fails the boxes check", async () => {
  const { main } = await shop();
  const salaries = await Account.findOne({ code: "521" }).lean();
  const expense = await Expense.create({ number: "EX-900002", date: new Date(), accountId: salaries._id, amount: 70, boxId: main._id });
  await withTransaction(async (session) => {
    const accounts = await accountMap(["CAPITAL"], session);
    await postEntry({ date: new Date(), source: { type: "expense", id: expense._id, number: "EX-900002" }, session, lines: [line(salaries, 70, "debit"), line(accounts.get("CAPITAL"), 70, "credit")] });
  });
  const health = await healthOf();
  assert.equal(health.boxes.difference, 70);
  assert.deepEqual(health.boxes.byBox.filter((row) => row.difference).map((row) => [row.name, row.expected, row.actual]), [["الخزنة الرئيسية", 19930, 20000]]);
  assert.equal(health.trialBalance.difference, 0, "the entry itself balances: only the boxes check can see it");
});

// ---- 12. the device registry without users, and its cap

it("review 12: with users off (no req.user) a PC still registers; with users on, an unsigned request does not; the throttle map is capped (LRU)", async () => {
  await shop();
  const { deviceContext, rememberedCount, resetDeviceThrottle: reset } = require("../src/middlewares/device.middleware");
  const requestFor = (id, extra = {}) => ({ get: (name) => ({ "x-nota-device-id": id, "x-nota-device-name": "PC" })[name.toLowerCase()], ...extra });
  reset();
  await deviceContext()(requestFor("device-authoff-0001", { authEnabled: false }), {}, () => {});
  assert.equal(await Device.countDocuments({ deviceId: "device-authoff-0001" }), 1, "NOTA_AUTH off: registered");
  await deviceContext()(requestFor("device-unsigned-0002", { authEnabled: true }), {}, () => {});
  assert.equal(await Device.countDocuments({ deviceId: "device-unsigned-0002" }), 0, "users on, nobody signed in: not registered");
  await deviceContext()(requestFor("device-signed-0003", { authEnabled: true, user: { _id: "u" } }), {}, () => {});
  assert.equal(await Device.countDocuments({ deviceId: "device-signed-0003" }), 1);
  reset();
  const capped = deviceContext({ maxEntries: 3 });
  for (let index = 1; index <= 8; index += 1) await capped(requestFor(`device-cap-${String(index).padStart(4, "0")}`, { authEnabled: false }), {}, () => {});
  assert.equal(rememberedCount(), 3, "only the 3 most recent ids are remembered");
  assert.equal(await Device.countDocuments({ deviceId: /^device-cap-/ }), 8, "every one was still registered");
  reset();
  assert.equal(rememberedCount(), 0);
});

// ---- round 2 A: a pre-ledger invoice edited by the old build and again now

it("round 2 A: a pre-ledger sale edited before boxMoves existed (+70 only in the trace) and edited again (-30): boxes 0", async () => {
  const { main } = await shop();
  const p = await product({ code: "R2-A" });
  const sale = await sold(p, 200);
  // Make it a pre-ledger invoice: older than the ledger start, with nothing posted for it.
  await JournalEntry.deleteMany({ "source.id": ObjectId(sale._id) });
  await Selling.collection.updateOne({ _id: ObjectId(sale._id) }, { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } });
  await Meta.updateOne({ _id: "schema" }, { $set: { ledgerStartAt: new Date(Date.now() - 86400000) } });
  assert.equal((await entriesOf("sale", sale._id)).length, 0);
  assert.equal((await call("PUT", `/api/sellings/${sale._id}`, { price: 270 })).status, 200);
  await Selling.collection.updateOne({ _id: ObjectId(sale._id) }, { $unset: { boxMoves: "" } }); // what a Stage 17/18 edit left behind
  assert.equal((await call("PUT", `/api/sellings/${sale._id}`, { price: 240 })).status, 200);
  const stored = await Selling.findById(sale._id).select("+ledgerTrace").lean();
  assert.equal(stored.ledgerTrace.editNetSales, 40);
  assert.deepEqual(stored.boxMoves.map((move) => move.delta), [-30]);
  const health = await healthOf(); // (inventory is skipped: the fixture deleted the sale's cost entries)
  assert.equal(health.boxes.difference, 0, JSON.stringify(health.boxes));
  assert.equal(health.shifts.difference, 0);
  assert.equal(await balanceOf(main), 20040);
});

// ---- round 2 B: a one-box shop

it("round 2 B: with no active drawer besides the main box, the main box is the drawer: a cashier refunds, spends, pays out and cancels a down payment with only the action's permission; an active drawer takes that away", async () => {
  const { main, wallet } = await shop();
  const p = await product({ code: "R2-B", stock: 100 }); const c = await customer("Round Two B", "01010000198"); const owed = await customer("Has credit", "01010000199");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, banks: [{ accountId: String(wallet.accountId), amount: 5000 }], customers: [{ customerId: String(owed._id), amount: -300 }] })).status, 200);
  const sale = await sold(p, 100, { boxId: main._id });
  const sale2 = await sold(p, 100, { boxId: main._id });
  const credit = await creditSale(c, p, 300, { downPayment: 100 });
  const credit2 = await creditSale(c, p, 300, { downPayment: 100 });
  const created = await call("POST", "/api/users", { name: "clerk", username: "clerk-r2b", password: "secret-pass-1", role: "custom", permissions: ["returns.create", "sales.delete", "credit.delete", "credit.collect", "expenses.create", "owner.drawings"] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const clerk = await login("clerk-r2b", "secret-pass-1");
  const rent = await category("522");
  token = clerk;
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] })).status, 201, "cash return");
  assert.equal((await call("POST", "/api/expenses", { accountId: rent, amount: 5 })).status, 201, "expense");
  assert.equal((await call("POST", `/api/customers/${owed._id}/payouts`, { amount: 5 })).status, 201, "payout");
  const cancelled = await call("POST", `/api/credit-sales/${credit._id}/cancel`, { reason: "رد المقدم" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  // Transfers always need cashbox.manage; owner drawings always run on owner.drawings.
  assert.equal((await call("POST", "/api/cashbox/transfers", { fromBoxId: main._id, toBoxId: main._id, amount: 1 })).status, 403, "transfers always need cashbox.manage");
  assert.equal((await call("POST", "/api/cashbox/drawings", { amount: 5, boxId: main._id })).status, 201, "a drawing is owner.drawings");
  // The shop adds a drawer: the same actions from the main box are the manager's again.
  token = ownerToken;
  await createBox({ name: "درج", type: "cash", deviceId: DEVICE_A });
  token = clerk;
  assert.equal((await call("POST", "/api/expenses", { accountId: rent, amount: 5 })).status, 403);
  assert.equal((await call("POST", "/api/returns", { returnType: "cash", invoiceId: sale2._id, items: [{ productId: p._id, quantity: 1, returnReason: "x" }] })).status, 403);
  assert.equal((await call("POST", `/api/sellings/${sale2._id}/cancel`, { reason: "لا يجوز الإلغاء" })).status, 403);
  assert.equal((await call("POST", `/api/credit-sales/${credit2._id}/cancel`, { reason: "رد المقدم" })).status, 403);
  assert.equal((await call("POST", `/api/customers/${owed._id}/payouts`, { amount: 5 })).status, 403);
});

// ---- round 2 C3: the shifts check is one pass per box account

it("round 2 C3: the shifts check reads 1,500 shifts (3,000 cut points) in one pass, with the same answers as a per-cut balance", async () => {
  const { main } = await shop();
  const drawer = await createBox({ name: "درج", type: "cash" });
  const amounts = [500, 250, 125, 60, 30];
  const base = Date.now() - 20 * 3600000;
  const timeline = [];
  for (const [index, amount] of amounts.entries()) {
    const created = await transfer(main, drawer, amount);
    const at = new Date(base + index * 3600000);
    await JournalEntry.collection.updateMany({ "source.id": ObjectId(created._id) }, { $set: { createdAt: at } });
    timeline.push([at.getTime(), amount]);
  }
  const balanceAt = (time) => timeline.filter(([at]) => at <= time).reduce((sum, [, amount]) => sum + amount, 0);
  const docs = [];
  for (let index = 0; index < 1500; index += 1) {
    const openCut = base - 3600000 + Math.floor(Math.random() * 7 * 3600000);
    const closeCut = openCut + 1 + Math.floor(Math.random() * 3600000);
    docs.push({ number: `SH-T${index}`, boxId: ObjectId(drawer._id), openedAt: new Date(openCut), openingFloat: balanceAt(openCut), counted: balanceAt(closeCut), expected: balanceAt(closeCut), difference: 0, status: "closed", closedAt: new Date(closeCut), openCutAt: new Date(openCut), closeCutAt: new Date(closeCut) });
  }
  await Shift.collection.insertMany(docs);
  const started = Date.now();
  const health = await healthOf();
  const elapsed = Date.now() - started;
  assert.equal(health.shifts.byShift.length, 3000);
  assert.equal(health.shifts.difference, 0, JSON.stringify(health.shifts.byShift.filter((row) => row.difference).slice(0, 3)));
  assert.ok(elapsed < 8000, `health took ${elapsed} ms`);
  console.log(`# shifts check over 1,500 shifts: health answered in ${elapsed} ms`);
  // A wrong count is still seen.
  await Shift.collection.updateOne({ number: "SH-T7" }, { $set: { counted: docs[7].counted + 40 } });
  assert.equal((await healthOf()).shifts.difference, 40);
});

// ---- round 2 C4: cancels lock the box and touch the open shift

it("round 2 C4: cancelling an expense, a transfer, a drawing and a payout touches the open shift of the box (a concurrent close conflicts)", async () => {
  const { main, wallet } = await shop();
  const owed = await customer("Credit C4", "01010000200");
  assert.equal((await call("POST", "/api/accounting/opening", { cash: 20000, banks: [{ accountId: String(wallet.accountId), amount: 5000 }], customers: [{ customerId: String(owed._id), amount: -300 }] })).status, 200);
  const drawer = await createBox({ name: "درج", type: "cash" });
  await transfer(main, drawer, 500);
  const shift = (await openShift(drawer, 500)).json;
  const rent = await category("522");
  const expense = (await call("POST", "/api/expenses", { accountId: rent, amount: 10, boxId: drawer._id })).json;
  const drawing = (await call("POST", "/api/cashbox/drawings", { amount: 10, boxId: drawer._id })).json;
  const payout = (await call("POST", `/api/customers/${owed._id}/payouts`, { amount: 10, boxId: drawer._id })).json;
  const moved = await transfer(main, drawer, 20);
  const touched = async () => (await Shift.collection.findOne({ _id: ObjectId(shift._id) })).lastActivityAt.getTime();
  for (const [label, path] of [
    ["expense", `/api/expenses/${expense._id}/cancel`],
    ["drawing", `/api/cashbox/drawings/${drawing._id}/cancel`],
    ["payout", `/api/customers/${owed._id}/payouts/${(payout.payout || payout)._id}/cancel`],
    ["transfer", `/api/cashbox/transfers/${moved._id}/cancel`],
  ]) {
    const before = await touched();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await call("POST", path, { reason: "تجربة" });
    assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.json)}`);
    assert.ok(await touched() > before, `${label} cancel touched the open shift`);
  }
  await assertHealthy();
});

// ---- round 2 C5: the invoice says which box paid the refund

it("round 2 C5: GET /api/sellings/:id and the list return cancelRefundBoxId and the box name; a sale that is not cancelled has none", async () => {
  const { d1, d2, sale } = await twoDrawers();
  const other = await sold(await product({ code: "R2-C5" }), 100, {}, asDevice(DEVICE_A));
  const cancelled = await call("POST", `/api/sellings/${sale._id}/cancel`, { reason: "ألغاها الكاشير", boxId: d2._id }, asDevice(DEVICE_B));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  const one = (await call("GET", `/api/sellings/${sale._id}`)).json;
  assert.equal(String(one.cancelRefundBoxId), String(d2._id));
  assert.equal(one.cancelRefundBoxName, "درج ٢");
  const list = (await call("GET", "/api/sellings?limit=50")).json.data;
  assert.equal(list.find((row) => row.id === sale._id || row._id === sale._id).cancelRefundBoxName, "درج ٢");
  const plain = (await call("GET", `/api/sellings/${other._id}`)).json;
  assert.equal(plain.cancelRefundBoxId, null);
  assert.equal(plain.cancelRefundBoxName, undefined);
  void d1;
});
