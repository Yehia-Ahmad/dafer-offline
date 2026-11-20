// Online Fixes 1 tests: a sale never renames a customer that owns the phone (unless asked and allowed), the customer-by-phone lookup,
// and "تغيير المندوب" on an order that is out for delivery. Real throwaway mongod (port 27132, replica set: transactions are required).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-fixes1-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-fixes1-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const { dayString } = require("./helpers/shopDay");
const test = require("node:test");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const CreditSale = require("../src/models/creditSale.model");
const Counter = require("../src/models/counter.model");
const Customer = require("../src/models/customer.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const ReturnLog = require("../src/models/returnLog.model");
const Selling = require("../src/models/selling.model");
const WebOrder = require("../src/models/webOrder.model");
const { runMigrations } = require("../src/migrations");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHONE = "01012345678";
let categorySeq = 0; let phoneSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27132 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "fx-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "fx-owner", password: "owner-pass-123" } })).json.token;
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
const staff = (method, path, body, token = ownerToken) => call(method, path, { token, body });
const store = (method, path, body, token) => call(method, path, { token, body });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };
const uuid = () => require("node:crypto").randomUUID();

async function makeStaff(username, role, permissions) {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
}
async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
async function seedProduct({ name = "منتج", code = "P1", stock = 50, retail = 100, cost = 50, visible = true } = {}) {
  const created = ok(await staff("POST", "/api/categories", { name: `فئة ${name} ${++categorySeq}`, image: PNG_URI }), 201);
  const category = created._id || created.id || created.category?._id;
  ok(await staff("PUT", `/api/website/categories/${category}`, { visibility: "show", sortOrder: 1 }));
  const wholesale = Math.min(60, retail);
  const product = ok(await staff("POST", "/api/products", { name, code, categoryId: category, inventoryCount: stock, purchasePrice: Math.min(cost, wholesale), wholesalePrice: wholesale, retailPrice: retail, image: PNG_URI }), 201);
  const id = product._id || product.product?._id;
  if (visible) ok(await staff("PUT", `/api/website/products/${id}`, { visibility: "show", description: "وصف", images: [PNG_URI] }));
  return { id, category };
}
const openSite = async (extra = {}) => ok(await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر", ...extra }));
const seedZone = async () => ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة" }), 201);
const orderBody = (items, zoneId, extra = {}) => ({ items, zoneId, idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" }, ...extra });
const place = async (items, zoneId, extra) => ok(await store("POST", "/api/store/orders", orderBody(items, zoneId, extra)), 201);
async function newCourier(name = "أحمد") {
  return ok(await staff("POST", "/api/couriers", { name, phone: `0100000${String(++phoneSeq).padStart(4, "0")}` }), 201);
}
const act = (id, action, body, token = ownerToken) => staff("POST", `/api/orders/${id}/${action}`, body ?? {}, token);
const getOrder = async (id) => ok(await staff("GET", `/api/orders/${id}`));
const stockOf = async (id) => (await Product.findById(id).lean()).inventoryCount;
async function newBox(name, type = "wallet") {
  const created = ok(await staff("POST", "/api/cashbox/boxes", { name, type, ...(type === "cash" ? { shiftsEnabled: false } : {}) }), 201);
  return created._id || created.box?._id || created.id;
}
/** What a customer owes (the closing balance of the statement). */
const owed = async (customerId) => {
  const statement = ok(await staff("GET", `/api/customers/${customerId}/statement`));
  return statement.lines.length ? statement.lines[statement.lines.length - 1].balance : 0;
};

// ---------------------------------------------------------------------------------------------------------------------
// Item 2: a phone that already belongs to a customer

const cashSale = (productId, extra = {}) => ({ customerName: "اسم جديد", customerPhone: PHONE, sellingDate: dayString(), items: [{ productId, price: 100, quantity: 1 }], ...extra });
const creditSale = (productId, extra = {}) => ({ customerName: "اسم جديد", customerPhone: PHONE, sellingDate: dayString(), items: [{ productId, price: 100, quantity: 1 }], ...extra });
const customerOf = async (phone = PHONE) => Customer.findOne({ phone }).lean();

it("a cash sale never renames the customer that owns the phone: the stored name is used and printed on the invoice", async () => {
  await startLedger();
  const product = await seedProduct();
  ok(await staff("POST", "/api/customers", { name: "أحمد القديم", phone: PHONE }), 201);
  const sale = ok(await staff("POST", "/api/sellings", cashSale(product.id)), 201);
  assert.equal((await customerOf()).name, "أحمد القديم", "the customer keeps its name");
  assert.equal((await Selling.findById(sale._id || sale.id).lean()).customerName, "أحمد القديم", "the invoice carries the stored name");
  assert.equal(await Customer.countDocuments({ phone: PHONE }), 1);
});

it("a cash sale for an unknown phone creates the customer with the typed name", async () => {
  await startLedger();
  const product = await seedProduct();
  ok(await staff("POST", "/api/sellings", cashSale(product.id, { customerName: "عميل جديد", customerPhone: "01099990000" })), 201);
  assert.equal((await customerOf("01099990000")).name, "عميل جديد");
});

it("rename happens only with renameCustomer: true AND customers.manage; without the permission the flag is refused (403) and nothing is written", async () => {
  await startLedger();
  const product = await seedProduct();
  ok(await staff("POST", "/api/customers", { name: "أحمد القديم", phone: PHONE }), 201);
  const cashier = await makeStaff("fx-cashier", "cashier");

  const refused = await staff("POST", "/api/sellings", cashSale(product.id, { renameCustomer: true }), cashier);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(await Selling.countDocuments({}), 0, "no invoice");
  assert.equal(await stockOf(product.id), 50, "no stock moved");
  assert.equal((await customerOf()).name, "أحمد القديم");

  // The cashier without the flag still sells (and nothing is renamed).
  ok(await staff("POST", "/api/sellings", cashSale(product.id), cashier), 201);
  assert.equal((await customerOf()).name, "أحمد القديم");

  const renamed = ok(await staff("POST", "/api/sellings", cashSale(product.id, { renameCustomer: true })), 201);
  assert.equal((await customerOf()).name, "اسم جديد", "the owner may rename");
  assert.equal((await Selling.findById(renamed._id || renamed.id).lean()).customerName, "اسم جديد");
});

it("a credit sale (typed customer) follows the same rule: no rename by default, rename with flag + permission, 403 without it", async () => {
  await startLedger();
  const product = await seedProduct();
  ok(await staff("POST", "/api/customers", { name: "أحمد القديم", phone: PHONE }), 201);
  const cashier = await makeStaff("fx-cashier2", "cashier");

  const first = ok(await staff("POST", "/api/credit-sales", creditSale(product.id), cashier), 201);
  assert.equal((await customerOf()).name, "أحمد القديم");
  assert.equal((await CreditSale.findById(first._id || first.id).lean()).customerName, "أحمد القديم");

  const refused = await staff("POST", "/api/credit-sales", creditSale(product.id, { renameCustomer: true }), cashier);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(await CreditSale.countDocuments({}), 1);
  assert.equal((await customerOf()).name, "أحمد القديم");

  ok(await staff("POST", "/api/credit-sales", creditSale(product.id, { renameCustomer: true })), 201);
  assert.equal((await customerOf()).name, "اسم جديد");
});

it("customer-by-phone answers only { exists, name } for an exact phone, 400 without a phone, and needs sales.create or credit.create", async () => {
  await startLedger();
  ok(await staff("POST", "/api/customers", { name: "أحمد القديم", phone: PHONE, taxNumber: "999" }), 201);
  const found = ok(await staff("GET", `/api/sellings/customer-by-phone?phone=${PHONE}`));
  assert.deepEqual(found, { exists: true, name: "أحمد القديم" }, "nothing else about the customer");
  assert.deepEqual(ok(await staff("GET", "/api/sellings/customer-by-phone?phone=01000000000")), { exists: false });
  assert.deepEqual(ok(await staff("GET", `/api/sellings/customer-by-phone?phone=%20${PHONE}%20`)), { exists: true, name: "أحمد القديم" }, "trimmed");
  assert.equal((await staff("GET", "/api/sellings/customer-by-phone")).status, 400);
  assert.equal((await staff("GET", "/api/sellings/customer-by-phone?phone=")).status, 400);
  const cashier = await makeStaff("fx-cashier3", "cashier");
  assert.equal((await staff("GET", `/api/sellings/customer-by-phone?phone=${PHONE}`, undefined, cashier)).status, 200);
  const storekeeper = await makeStaff("fx-keeper", "storekeeper");
  assert.equal((await staff("GET", `/api/sellings/customer-by-phone?phone=${PHONE}`, undefined, storekeeper)).status, 403);
  assert.equal((await call("GET", `/api/sellings/customer-by-phone?phone=${PHONE}`)).status, 401);
});

// ---------------------------------------------------------------------------------------------------------------------
// Item 3: تغيير المندوب

/** A shop with the ledger, the site open, a zone (fee 30), one product (100, stock 20) and two couriers; an order for `qty`. */
async function shop({ qty = 2, stock = 20, wallet = false } = {}) {
  await startLedger();
  let insta = null;
  if (wallet) {
    insta = await newBox("إنستا باي");
    await openSite({ payments: { instapay: { enabled: true, address: "shop@instapay", boxId: insta } } });
  } else {
    await openSite();
  }
  const product = await seedProduct({ code: "A1", stock, retail: 100 });
  const zone = await seedZone();
  const first = await newCourier("أحمد");
  const second = await newCourier("محمود");
  const placed = await place([{ productId: product.id, qty }], zone.id, wallet ? { paymentMethod: "instapay" } : {});
  return { product, zone, first, second, placed, id: placed.id, insta };
}
async function outForDelivery(ctx) {
  ok(await act(ctx.id, "confirm"));
  if (ctx.insta) ok(await act(ctx.id, "verify-payment", {}));
  return ok(await act(ctx.id, "dispatch", { courierId: ctx.first.id }));
}

it("COD: the old courier's balance goes back, the new courier owes the order total, stock ends where it was, and the documents are the existing ones", async () => {
  const ctx = await shop();
  const dispatched = await outForDelivery(ctx);
  assert.equal(await stockOf(ctx.product.id), 18);
  assert.equal(await owed(ctx.first.customerId), 230);
  const oldSaleId = dispatched.creditSale.id;

  const changed = ok(await act(ctx.id, "change-courier", { courierId: ctx.second.id }));
  assert.equal(changed.status, "out_for_delivery");
  assert.equal(changed.courier.id, ctx.second.id);
  assert.notEqual(changed.creditSale.id, oldSaleId, "a new credit sale");
  assert.equal(changed.creditSale.totalPrice, 230, "the new invoice total IS the order total");
  assert.equal(await stockOf(ctx.product.id), 18, "stock ends where it was");
  assert.equal(await owed(ctx.first.customerId), 0, "the old courier owes what he owed before the order");
  assert.equal(await owed(ctx.second.customerId), 230, "the new courier owes the order total");

  const oldSale = await CreditSale.findById(oldSaleId).lean();
  assert.equal(oldSale.status, "returned");
  assert.equal(await ReturnLog.countDocuments({}), 1, "one full return");
  const fresh = await CreditSale.findById(changed.creditSale.id).lean();
  assert.equal(String(fresh.customer), ctx.second.customerId);
  assert.equal(fresh.shippingFees, 30); assert.equal(fresh.items[0].unitPrice, 100); assert.equal(fresh.items[0].quantity, 2);
  assert.match(fresh.notes, new RegExp(ctx.placed.number));

  const stored = await WebOrder.findById(ctx.id).lean();
  assert.equal(stored.courierChanges.length, 1);
  assert.equal(String(stored.courierChanges[0].previousCreditSaleId), oldSaleId);
  assert.equal(String(stored.courierChanges[0].creditSaleId), changed.creditSale.id);
  assert.equal(stored.courierChanges[0].previousReturnIds.length, 1);
  const history = changed.statusHistory[changed.statusHistory.length - 1];
  assert.equal(history.type, "courier_change"); assert.equal(history.note, "غيّر المندوب من أحمد لـ محمود"); assert.ok(history.byName);

  // It can be delivered by the new courier like any other order.
  const delivered = ok(await act(ctx.id, "deliver", {}));
  assert.equal(delivered.status, "delivered"); assert.equal(delivered.collectedAmount, 230);
  assert.equal(await owed(ctx.second.customerId), 0);
  assert.equal(await owed(ctx.first.customerId), 0);
});

it("COD: a customer never sees the courier change on the tracking page", async () => {
  const ctx = await shop();
  await outForDelivery(ctx);
  ok(await act(ctx.id, "change-courier", { courierId: ctx.second.id }));
  const tracked = ok(await store("GET", `/api/store/orders/track/${ctx.placed.trackingToken}`));
  assert.equal(tracked.status, "out_for_delivery");
  assert.ok(!JSON.stringify(tracked).includes("غيّر المندوب"), "the courier change text never reaches the customer");
  assert.ok(!JSON.stringify(tracked).includes("محمود"), "nor the courier's name");
  // A signed-in customer's own order view filters the history to real status rows (type "status" or none).
  const stored = await WebOrder.findById(ctx.id).lean();
  assert.ok(stored.statusHistory.some((row) => row.type === "courier_change"), "the change is in the staff history");
});

it("wallet: only the courier and the history change; no document is created", async () => {
  const ctx = await shop({ wallet: true });
  await outForDelivery(ctx);
  const sellingsBefore = await Selling.countDocuments({});
  const stockBefore = await stockOf(ctx.product.id);
  const entriesBefore = await JournalEntry.countDocuments({});
  const changed = ok(await act(ctx.id, "change-courier", { courierId: ctx.second.id }));
  assert.equal(changed.courier.id, ctx.second.id);
  assert.equal(await Selling.countDocuments({}), sellingsBefore);
  assert.equal(await CreditSale.countDocuments({}), 0);
  assert.equal(await ReturnLog.countDocuments({}), 0);
  assert.equal(await JournalEntry.countDocuments({}), entriesBefore, "no accounting");
  assert.equal(await stockOf(ctx.product.id), stockBefore);
  const stored = await WebOrder.findById(ctx.id).lean();
  assert.equal(stored.courierChanges.length, 1);
  assert.equal(stored.courierChanges[0].previousCreditSaleId, undefined);
  assert.equal(changed.statusHistory[changed.statusHistory.length - 1].type, "courier_change");
  // A wallet order needs only orders.dispatch.
  const dispatcher = await makeStaff("fx-dispatch", "custom", ["orders.view", "orders.dispatch"]);
  ok(await act(ctx.id, "change-courier", { courierId: ctx.first.id }, dispatcher));
});

it("a locked accounting period refuses it (409 PERIOD_LOCKED) and nothing changes", async () => {
  const ctx = await shop();
  await outForDelivery(ctx);
  await Meta.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": new Date(Date.now() + 2 * 86400000) } });
  const refused = await act(ctx.id, "change-courier", { courierId: ctx.second.id });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "PERIOD_LOCKED");
  const stored = await WebOrder.findById(ctx.id).lean();
  assert.equal(String(stored.courierId), ctx.first.id);
  assert.equal(stored.courierChanges.length, 0);
  assert.equal(await CreditSale.countDocuments({}), 1); assert.equal(await ReturnLog.countDocuments({}), 0);
  assert.equal(await stockOf(ctx.product.id), 18);
});

it("two parallel calls change it once", async () => {
  const ctx = await shop();
  await outForDelivery(ctx);
  const results = await Promise.all([act(ctx.id, "change-courier", { courierId: ctx.second.id }), act(ctx.id, "change-courier", { courierId: ctx.second.id })]);
  const statuses = results.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map((r) => r.text)));
  const stored = await WebOrder.findById(ctx.id).lean();
  assert.equal(String(stored.courierId), ctx.second.id);
  assert.equal(stored.courierChanges.length, 1);
  assert.equal(await CreditSale.countDocuments({}), 2, "the old credit sale and ONE new one");
  assert.equal(await ReturnLog.countDocuments({}), 1);
  assert.equal(await stockOf(ctx.product.id), 18);
  assert.equal(await owed(ctx.second.customerId), 230);
});

it("permissions: cash on delivery needs orders.dispatch + credit.create + returns.create; each missing key is a 403 and nothing changes", async () => {
  const ctx = await shop();
  await outForDelivery(ctx);
  const noCredit = await makeStaff("fx-nocredit", "custom", ["orders.view", "orders.dispatch", "returns.create"]);
  const noReturn = await makeStaff("fx-noreturn", "custom", ["orders.view", "orders.dispatch", "credit.create"]);
  const noDispatch = await makeStaff("fx-nodispatch", "custom", ["orders.view", "credit.create", "returns.create"]);
  for (const token of [noCredit, noReturn, noDispatch]) {
    const refused = await act(ctx.id, "change-courier", { courierId: ctx.second.id }, token);
    assert.equal(refused.status, 403, refused.text);
  }
  const stored = await WebOrder.findById(ctx.id).lean();
  assert.equal(String(stored.courierId), ctx.first.id); assert.equal(await CreditSale.countDocuments({}), 1); assert.equal(await ReturnLog.countDocuments({}), 0);
  const allowed = await makeStaff("fx-allowed", "custom", ["orders.view", "orders.dispatch", "credit.create", "returns.create"]);
  ok(await act(ctx.id, "change-courier", { courierId: ctx.second.id }, allowed));
});

it("only an order that is out for delivery, to a different active courier, and with nothing collected or returned on its invoice", async () => {
  const ctx = await shop();
  ok(await act(ctx.id, "confirm"));
  const early = await act(ctx.id, "change-courier", { courierId: ctx.second.id });
  assert.equal(early.status, 409); assert.equal(early.json.code, "INVALID_STATUS");
  ok(await act(ctx.id, "dispatch", { courierId: ctx.first.id }));
  const same = await act(ctx.id, "change-courier", { courierId: ctx.first.id });
  assert.equal(same.status, 409); assert.equal(same.json.code, "SAME_COURIER");
  assert.equal((await act(ctx.id, "change-courier", {})).status, 400, "a courier is required");
  const third = await newCourier("سيد");
  ok(await staff("PUT", `/api/couriers/${third.id}`, { isActive: false }));
  const inactive = await act(ctx.id, "change-courier", { courierId: third.id });
  assert.equal(inactive.status, 409); assert.equal(inactive.json.code, "COURIER_INACTIVE");

  // Someone collected on the courier's invoice from the customer page: the balance could not go back, so it is refused.
  ok(await staff("POST", `/api/customers/${ctx.first.customerId}/payments`, { amount: 10, paymentDate: dayString(), firstInvoice: true }), 201);
  const paid = await act(ctx.id, "change-courier", { courierId: ctx.second.id });
  assert.equal(paid.status, 409); assert.equal(paid.json.code, "HAS_PAYMENTS");
  assert.equal(String((await WebOrder.findById(ctx.id).lean()).courierId), ctx.first.id);
});

it("a delivered order cannot change courier", async () => {
  const ctx = await shop();
  await outForDelivery(ctx);
  ok(await act(ctx.id, "deliver", {}));
  const refused = await act(ctx.id, "change-courier", { courierId: ctx.second.id });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "INVALID_STATUS");
});
