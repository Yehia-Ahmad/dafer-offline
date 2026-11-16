// Online Stage 4 tests: website orders in the admin app (confirm, edit, reserve, dispatch on a courier, deliver, refuse), couriers,
// website customers. Real throwaway mongod (port 27120, replica set: transactions are required).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage4-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage4-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const CreditSale = require("../src/models/creditSale.model");
const Counter = require("../src/models/counter.model");
const Courier = require("../src/models/courier.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const Receipt = require("../src/models/receipt.model");
const ReturnLog = require("../src/models/returnLog.model");
const Selling = require("../src/models/selling.model");
const WebOrder = require("../src/models/webOrder.model");
const StoreCustomer = require("../src/models/storeCustomer.model");
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
  stop = await startMongod({ port: 27120 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s4-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s4-owner", password: "owner-pass-123" } })).json.token;
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
const cents = (value) => Math.round(value * 100);

async function makeStaff(username, role, permissions) {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
}

async function startLedger() {
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
}
const enableVat = async ({ rate = 14, includes = true } = {}) => ok(await staff("PUT", "/api/shop-profile", { name: "متجر", taxNumber: "123-456-789", vat: { enabled: true, rate, pricesIncludeVat: includes } }));

async function seedProduct({ name = "منتج", code = "P1", stock = 50, retail = 100, discount = 0, cost = 50, visible = true, categoryId, exempt = false } = {}) {
  let category = categoryId;
  if (!category) {
    const created = ok(await staff("POST", "/api/categories", { name: `فئة ${name} ${++categorySeq}`, image: PNG_URI }), 201);
    category = created._id || created.id || created.category?._id;
    ok(await staff("PUT", `/api/website/categories/${category}`, { visible: true, sortOrder: 1 }));
  }
  const wholesale = Math.min(60, retail);
  const created = ok(await staff("POST", "/api/products", {
    name, code, categoryId: category, inventoryCount: stock, purchasePrice: Math.min(cost, wholesale), wholesalePrice: wholesale, retailPrice: retail,
    ...(discount ? { discountPercentage: discount } : {}), image: PNG_URI, ...(exempt ? { vatExempt: true } : {}),
  }), 201);
  const id = created._id || created.product?._id;
  if (visible) ok(await staff("PUT", `/api/website/products/${id}`, { visible: true, description: "وصف", images: [PNG_URI] }));
  return { id, category };
}
const openSite = async (extra = {}) => ok(await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر", ...extra }));
const seedZone = async (extra = {}) => ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة", ...extra }), 201);
const orderBody = (items, zoneId, extra = {}) => ({ items, zoneId, idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" }, ...extra });
const place = async (items, zoneId, extra) => ok(await store("POST", "/api/store/orders", orderBody(items, zoneId, extra)), 201);
async function newCourier(name = "أحمد", token = ownerToken) {
  return ok(await staff("POST", "/api/couriers", { name, phone: `0100000${String(++phoneSeq).padStart(4, "0")}` }, token), 201);
}
const act = (id, action, body, token = ownerToken) => staff("POST", `/api/orders/${id}/${action}`, body ?? {}, token);
const getOrder = async (id) => ok(await staff("GET", `/api/orders/${id}`));
const stockOf = async (id) => (await Product.findById(id).lean()).inventoryCount;
const mainBoxId = async () => ok(await staff("GET", "/api/cashbox/boxes")).data.find((box) => box.isMain)._id;
const boxBalance = async (id) => ok(await staff("GET", "/api/cashbox/boxes")).data.find((box) => String(box._id) === String(id)).balance;
const sumLines = async (sourceType, sourceId, key) => {
  const accountId = (await Account.findOne({ systemKey: key }).lean())?._id;
  const entries = await JournalEntry.find({ "source.type": sourceType, "source.id": sourceId }).lean();
  return entries.flatMap((entry) => entry.lines).filter((line) => String(line.accountId) === String(accountId)).reduce((sum, line) => sum + (line.credit - line.debit), 0);
};

/** A shop with the site open, one zone (fee 30), one product (100, stock 20) and a courier; the order for `qty` of it. */
async function shop({ qty = 2, stock = 20, retail = 100, discount = 0 } = {}) {
  await startLedger();
  await openSite();
  const product = await seedProduct({ code: "A1", stock, retail, discount });
  const zone = await seedZone();
  const courier = await newCourier();
  const placed = await place([{ productId: product.id, qty }], zone.id);
  return { product, zone, courier, placed, id: placed.id };
}

// ---------------------------------------------------------------------------------------------------------------------

it("happy path: new → confirmed → preparing → out_for_delivery → delivered, then the courier hands the cash to the main box", async () => {
  const { product, courier, id, placed } = await shop();
  assert.equal(placed.total, 230);
  assert.equal((await getOrder(id)).status, "new");

  ok(await act(id, "confirm"));
  ok(await act(id, "prepare"));
  assert.equal(await stockOf(product.id), 20, "confirming deducts nothing");

  const dispatched = ok(await act(id, "dispatch", { courierId: courier.id }));
  assert.equal(dispatched.status, "out_for_delivery");
  assert.equal(await stockOf(product.id), 18, "the credit sale deducted the stock");
  const sale = await CreditSale.findById(dispatched.creditSale.id).lean();
  assert.equal(String(sale.customer), courier.customerId);
  assert.equal(sale.items.length, 1); assert.equal(sale.items[0].quantity, 2); assert.equal(sale.items[0].unitPrice, 100);
  assert.equal(sale.shippingFees, 30); assert.equal(sale.totalPrice, 230); assert.equal(sale.remainingAmount, 230);
  assert.match(sale.notes, new RegExp(placed.number));
  assert.equal(await sumLines("credit_sale", sale._id, "SHIPPING_INCOME"), 30, "shipping is posted to SHIPPING_INCOME");
  assert.equal(ok(await staff("GET", `/api/customers/${courier.customerId}/credit`)).balance, 230, "the courier owes the order total");
  assert.equal(String((await WebOrder.findById(id).lean()).creditSaleId), String(sale._id));

  const delivered = ok(await act(id, "deliver", {}));
  assert.equal(delivered.status, "delivered"); assert.equal(delivered.collectedAmount, 230);
  const receipt = await Receipt.findOne({ customer: courier.customerId }).lean();
  assert.equal(receipt.amount, 230); assert.equal(String(receipt.boxId), courier.boxId);
  const afterDelivery = ok(await staff("GET", `/api/couriers/${courier.id}`));
  assert.equal(afterDelivery.boxBalance, 230); assert.equal(afterDelivery.amountOwed, 0); assert.equal(afterDelivery.openOrders, 0);
  assert.equal((await WebOrder.findById(id).lean()).paymentIds.length, 1);

  const main = await mainBoxId(); const mainBefore = await boxBalance(main);
  ok(await staff("POST", "/api/cashbox/transfers", { fromBoxId: courier.boxId, toBoxId: main, amount: 230 }), 201);
  assert.equal(await boxBalance(courier.boxId), 0); assert.equal(await boxBalance(main), mainBefore + 230);
  assert.deepEqual((await getOrder(id)).statusHistory.map((row) => row.status), ["new", "confirmed", "preparing", "out_for_delivery", "delivered"]);
});

for (const mode of ["inclusive", "exclusive", "none"]) {
  it(`the order total is the credit-sale total to the piastre (VAT ${mode})`, async () => {
    await startLedger();
    if (mode !== "none") await enableVat({ includes: mode === "inclusive" });
    await openSite();
    const a = await seedProduct({ code: "V1", name: "أ", retail: 100, discount: 10, stock: 100 });
    const b = await seedProduct({ code: "V2", name: "ب", retail: 33.33, stock: 100, categoryId: a.category });
    const c = await seedProduct({ code: "V3", name: "ج", retail: 65, stock: 100, categoryId: a.category, exempt: true });
    const zone = await seedZone({ fee: 25 });
    const courier = await newCourier();
    const placed = await place([{ productId: a.id, qty: 4 }, { productId: b.id, qty: 3 }, { productId: c.id, qty: 2 }], zone.id);
    ok(await act(placed.id, "confirm"));
    const dispatched = ok(await act(placed.id, "dispatch", { courierId: courier.id }));
    const order = await WebOrder.findById(placed.id).lean();
    const sale = await CreditSale.findById(dispatched.creditSale.id).lean();
    assert.equal(cents(order.total), cents(sale.totalPrice), "total");
    assert.equal(order.deliveryFee, sale.shippingFees);
    assert.equal(cents(order.vat), cents(sale.vatAmount || 0), "VAT incl. shipping VAT");
    if (mode !== "none") assert.ok(sale.shippingVat > 0, "the delivery fee carries VAT like any credit sale");
  });
}

it("partial refusal: returns the refused lines, collects the rest; the delivery fee stays on the invoice", async () => {
  const { product, courier, id } = await shop({ qty: 4 }); // 400 + 30
  ok(await act(id, "confirm")); ok(await act(id, "dispatch", { courierId: courier.id }));
  assert.equal(await stockOf(product.id), 16);
  const delivered = ok(await act(id, "deliver", { returns: [{ productId: product.id, qty: 1 }] }));
  assert.equal(delivered.status, "delivered");
  assert.equal(await stockOf(product.id), 17, "the refused unit is back in stock");
  const sale = await CreditSale.findById(delivered.creditSale.id).lean();
  assert.equal(sale.shippingFees, 30); assert.equal(sale.refundedAmount, 100); assert.equal(sale.paidAmount, 330); assert.equal(sale.remainingAmount, 0);
  const log = await ReturnLog.findOne({ invoiceId: sale._id }).lean();
  assert.equal(log.shippingFees, 0, "partial return: the fee stays"); assert.equal(log.finalReturnedAmount, 100);
  assert.equal(delivered.collectedAmount, 330);
  assert.equal(ok(await staff("GET", `/api/couriers/${courier.id}`)).boxBalance, 330);
  assert.equal(ok(await staff("GET", `/api/customers/${courier.customerId}/credit`)).balance, 0);
  assert.equal((await WebOrder.findById(id).lean()).returnIds.length, 1);
});

it("full refusal: a full return (delivery fee comes back by the existing full-return rule), nothing collected, courier at 0", async () => {
  const { product, courier, id } = await shop({ qty: 3 });
  ok(await act(id, "confirm")); ok(await act(id, "dispatch", { courierId: courier.id }));
  const refused = ok(await act(id, "refuse", { reason: "العميل رفض" }));
  assert.equal(refused.status, "refused");
  assert.equal(await stockOf(product.id), 20);
  const sale = await CreditSale.findById(refused.creditSale.id).lean();
  assert.equal(sale.status, "returned");
  const log = await ReturnLog.findOne({ invoiceId: sale._id }).lean();
  assert.equal(log.shippingFees, 30, "full return gives the fee back"); assert.equal(log.finalReturnedAmount, 330);
  assert.ok(await sumLines("return", log._id, "SHIPPING_INCOME") < 0 || (await JournalEntry.countDocuments({ "source.type": "return", "source.id": log._id })) === 1);
  assert.equal(await Receipt.countDocuments({}), 0);
  assert.equal(ok(await staff("GET", `/api/customers/${courier.customerId}/credit`)).balance, 0);
  assert.equal((await WebOrder.findById(refused.id).lean()).returnIds.length, 1);
  // returning every line while "delivered" is a refusal: use the refuse button
  const second = await place([{ productId: product.id, qty: 1 }], (await WebOrder.findById(refused.id).lean()).zone.id);
  ok(await act(second.id, "confirm")); ok(await act(second.id, "dispatch", { courierId: courier.id }));
  const all = await act(second.id, "deliver", { returns: [{ productId: product.id, qty: 1 }] });
  assert.equal(all.status, 400); assert.equal(all.json.code, "USE_REFUSE");
});

it("the courier can collect less than the amount due: the difference stays as his debt", async () => {
  const { courier, id } = await shop({ qty: 1 });
  ok(await act(id, "confirm")); ok(await act(id, "dispatch", { courierId: courier.id }));
  ok(await act(id, "deliver", { collectedAmount: 100 }));
  assert.equal(ok(await staff("GET", `/api/customers/${courier.customerId}/credit`)).balance, 30);
  const tooMuch = await shop({ qty: 1 });
  ok(await act(tooMuch.id, "confirm")); ok(await act(tooMuch.id, "dispatch", { courierId: tooMuch.courier.id }));
  assert.equal((await act(tooMuch.id, "deliver", { collectedAmount: 500 })).status, 400);
});

it("reservation: confirmed/preparing quantities leave the website and limit confirm/edit; reject, cancel and dispatch release; the POS is not blocked", async () => {
  await startLedger(); await openSite();
  const product = await seedProduct({ code: "R1", stock: 10 }); const zone = await seedZone(); const courier = await newCourier();
  const one = await place([{ productId: product.id, qty: 6 }], zone.id);
  const two = await place([{ productId: product.id, qty: 5 }], zone.id);
  ok(await act(one.id, "confirm"));
  const visible = ok(await store("GET", `/api/store/products/${product.id}`));
  assert.equal(visible.maxOrderQty, 4, "10 - 6 reserved"); assert.equal(visible.availability, "low");
  assert.equal(ok(await staff("GET", `/api/products/${product.id}`)).reservedForWebOrders, 6);
  assert.equal(ok(await staff("GET", "/api/products")).data.find((row) => row._id === product.id).reservedForWebOrders, 6);
  // placing: 5 > 4 available
  const blocked = await store("POST", "/api/store/orders", orderBody([{ productId: product.id, qty: 5 }], zone.id));
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, "ORDER_ITEMS_INVALID");
  // confirming the second one (5) does not fit
  const refusedConfirm = await act(two.id, "confirm");
  assert.equal(refusedConfirm.status, 409); assert.equal(refusedConfirm.json.code, "ORDER_ITEMS_INVALID"); assert.equal(refusedConfirm.json.lines[0].available, 4);
  assert.equal((await getOrder(two.id)).status, "new");
  // editing the first one up to 10 fits (its own lines do not count against itself), 11 does not
  ok(await staff("PUT", `/api/orders/${one.id}`, { items: [{ productId: product.id, qty: 10 }] }));
  assert.equal((await staff("PUT", `/api/orders/${one.id}`, { items: [{ productId: product.id, qty: 11 }] })).status, 409);
  ok(await staff("PUT", `/api/orders/${one.id}`, { items: [{ productId: product.id, qty: 6 }] }));
  // the POS can still sell reserved stock
  const cash = await staff("POST", "/api/sellings", { customerName: "نقدي", customerPhone: "01017171718", sellingDate: new Date().toISOString().slice(0, 10), items: [{ productId: product.id, quantity: 8, price: 100 }] });
  assert.equal(cash.status, 201, cash.text);
  assert.equal(await stockOf(product.id), 2);
  // dispatch now fails for lack of stock: per-line problem, nothing created, the order stays as it was
  const before = await Selling.countDocuments({}) + await CreditSale.countDocuments({});
  const failed = await act(one.id, "dispatch", { courierId: courier.id });
  assert.equal(failed.status, 409); assert.equal(failed.json.code, "ORDER_ITEMS_INVALID"); assert.equal(failed.json.lines[0].requested, 6);
  assert.equal(await Selling.countDocuments({}) + await CreditSale.countDocuments({}), before);
  const unchanged = await WebOrder.findById(one.id).lean();
  assert.equal(unchanged.status, "confirmed"); assert.equal(unchanged.creditSaleId, undefined); assert.equal(unchanged.courierId, undefined);
  assert.equal(unchanged.statusHistory.length, 4, "new, confirmed and the two edits only: the failed dispatch left nothing");
  assert.equal(await stockOf(product.id), 2);
  // release by cancel / reject
  ok(await act(one.id, "cancel", { reason: "نفد المخزون" }));
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 2);
  ok(await act(two.id, "reject", { reason: "غير متاح" }));
  assert.equal((await act(two.id, "reject", { reason: "مرة تانية" })).status, 409);
  assert.equal((await act(two.id, "reject", {})).status, 400, "a reason is required");
});

it("reservation ends at dispatch (the stock is deducted by the credit sale instead)", async () => {
  const { product, courier, id } = await shop({ qty: 5, stock: 10 });
  ok(await act(id, "confirm"));
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 5);
  ok(await act(id, "dispatch", { courierId: courier.id }));
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 5, "10 - 5 sold, 0 reserved");
  assert.equal((await staff("GET", `/api/products/${product.id}`)).json.reservedForWebOrders, undefined);
});

it("two parallel 'send out' calls create one credit sale; a wrong-status action answers 409", async () => {
  const { courier, id } = await shop({ qty: 1 });
  ok(await act(id, "confirm"));
  const results = await Promise.all([act(id, "dispatch", { courierId: courier.id }), act(id, "dispatch", { courierId: courier.id })]);
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
  assert.equal(await CreditSale.countDocuments({}), 1);
  assert.equal(results.find((row) => row.status === 409).json.code, "INVALID_STATUS");
  // confirm on a dispatched order, deliver on a new one, edit after dispatch
  assert.equal((await act(id, "confirm")).status, 409);
  const fresh = await place([{ productId: (await Product.findOne({}).lean())._id, qty: 1 }], (await WebOrder.findById(id).lean()).zone.id);
  assert.equal((await act(fresh.id, "deliver", {})).status, 409);
  assert.equal((await act(fresh.id, "dispatch", { courierId: courier.id })).status, 409, "a new order cannot go out before it is confirmed");
  const edit = await staff("PUT", `/api/orders/${id}`, { contact: { name: "اسم تاني" } });
  assert.equal(edit.status, 409); assert.equal(edit.json.code, "NOT_EDITABLE");
  const twice = await Promise.all([act(id, "deliver", {}), act(id, "deliver", {})]);
  assert.deepEqual(twice.map((row) => row.status).sort(), [200, 409]);
  assert.equal(await Receipt.countDocuments({}), 1);
});

it("edits recompute totals on the server, keep snapshot prices of old lines, add lines at the current price, and are in the history", async () => {
  await startLedger(); await openSite();
  const a = await seedProduct({ code: "E1", name: "أ", retail: 100, stock: 50 });
  const b = await seedProduct({ code: "E2", name: "ب", retail: 40, stock: 50, categoryId: a.category, visible: false }); // not on the website: staff can still add it
  const zone = await seedZone({ fee: 30 }); const far = await seedZone({ name: "الجيزة", fee: 55 });
  const placed = await place([{ productId: a.id, qty: 2 }], zone.id);
  await Product.updateOne({ _id: a.id }, { $set: { retailPrice: 150 } }); // the shop raises the price after the order
  const edited = ok(await staff("PUT", `/api/orders/${placed.id}`, { items: [{ productId: a.id, qty: 3 }, { productId: b.id, qty: 2 }], zoneId: far.id, contact: { address: "عنوان جديد", phone: "01099999999" } }));
  const lineA = edited.items.find((line) => line.productId === a.id); const lineB = edited.items.find((line) => line.productId === b.id);
  assert.equal(lineA.unitPrice, 100, "old line keeps its snapshot price"); assert.equal(lineA.lineTotal, 300);
  assert.equal(lineB.unitPrice, 40, "added line takes the current price"); assert.equal(lineB.lineTotal, 80);
  assert.equal(edited.subtotal, 380); assert.equal(edited.deliveryFee, 55); assert.equal(edited.total, 435); assert.equal(edited.zone.name, "الجيزة");
  assert.equal(edited.contact.address, "عنوان جديد"); assert.equal(edited.contact.phone, "01099999999"); assert.equal(edited.contact.name, "عميل");
  const entry = edited.statusHistory.find((row) => row.type === "edit");
  assert.ok(entry && entry.byName === "Owner"); assert.equal(entry.details.total.from, 230); assert.equal(entry.details.total.to, 435);
  assert.ok(entry.details.lines.some((row) => row.change === "added")); assert.ok(entry.details.lines.some((row) => row.change === "qty" && row.from === 2 && row.to === 3));
  // a manual fee, and removing a line
  const manual = ok(await staff("PUT", `/api/orders/${placed.id}`, { items: [{ productId: a.id, qty: 3 }], deliveryFee: 10 }));
  assert.equal(manual.deliveryFee, 10); assert.equal(manual.total, 310);
  assert.equal((await staff("PUT", `/api/orders/${placed.id}`, { items: [] })).status, 400);
  assert.equal((await staff("PUT", `/api/orders/${placed.id}`, { items: [{ productId: a.id, qty: 3 }], deliveryFee: 10 })).json.code, "NO_CHANGES");
  // the customer's view never shows edits or staff names
  const tracked = ok(await store("GET", `/api/store/orders/track/${placed.trackingToken}`));
  assert.equal(tracked.total, 310); assert.ok(!JSON.stringify(tracked).includes("Owner"));
  // the invoice made at dispatch carries the edited lines and the snapshot price
  ok(await act(placed.id, "confirm"));
  const courier = await newCourier();
  const sent = ok(await act(placed.id, "dispatch", { courierId: courier.id }));
  assert.equal(sent.creditSale.totalPrice, 310);
});

it("refused shows like cancelled to the customer; new statuses appear on the customer's pages", async () => {
  const { courier, id, placed } = await shop({ qty: 1 });
  ok(await act(id, "confirm"));
  assert.equal(ok(await store("GET", `/api/store/orders/track/${placed.trackingToken}`)).status, "confirmed");
  ok(await act(id, "dispatch", { courierId: courier.id }));
  assert.equal(ok(await store("GET", `/api/store/orders/track/${placed.trackingToken}`)).status, "out_for_delivery");
  ok(await act(id, "refuse", {}));
  assert.equal(ok(await store("GET", `/api/store/orders/track/${placed.trackingToken}`)).status, "cancelled");
});

it("permissions: every route needs its key, and the document routes need the document's permission too", async () => {
  const { courier, id } = await shop({ qty: 1 });
  const none = await makeStaff("nobody", "custom", ["dashboard.view"]);
  for (const [method, path] of [["GET", "/api/orders"], ["GET", "/api/orders/summary"], ["GET", "/api/orders/delivery-zones"], ["GET", `/api/orders/${id}`], ["PUT", `/api/orders/${id}`], ["POST", `/api/orders/${id}/confirm`],
    ["POST", `/api/orders/${id}/prepare`], ["POST", `/api/orders/${id}/reject`], ["POST", `/api/orders/${id}/cancel`], ["POST", `/api/orders/${id}/dispatch`], ["POST", `/api/orders/${id}/deliver`],
    ["POST", `/api/orders/${id}/refuse`], ["GET", "/api/couriers"], ["POST", "/api/couriers"], ["GET", `/api/couriers/${courier.id}`], ["PUT", `/api/couriers/${courier.id}`],
    ["GET", "/api/website/customers"], ["PUT", "/api/website/customers/000000000000000000000000"], ["POST", "/api/website/customers/000000000000000000000000/reset-password"]]) {
    assert.equal((await staff(method, path, method === "GET" ? undefined : {}, none)).status, 403, `${method} ${path}`);
  }
  const viewer = await makeStaff("viewer", "custom", ["orders.view"]);
  ok(await staff("GET", "/api/orders", undefined, viewer)); ok(await staff("GET", "/api/orders/summary", undefined, viewer)); ok(await staff("GET", `/api/couriers/${courier.id}`, undefined, viewer));
  assert.equal((await act(id, "confirm", {}, viewer)).status, 403);
  const manager = await makeStaff("mgr", "custom", ["orders.view", "orders.manage"]);
  ok(await act(id, "confirm", {}, manager));
  assert.equal((await act(id, "dispatch", { courierId: courier.id }, manager)).status, 403, "orders.dispatch is missing");
  const noCredit = await makeStaff("nocredit", "custom", ["orders.view", "orders.dispatch"]);
  assert.equal((await act(id, "dispatch", { courierId: courier.id }, noCredit)).status, 403, "credit.create is missing");
  const dispatcher = await makeStaff("disp", "custom", ["orders.view", "orders.dispatch", "credit.create"]);
  ok(await act(id, "dispatch", { courierId: courier.id }, dispatcher));
  assert.equal((await act(id, "deliver", {}, dispatcher)).status, 403, "credit.collect is missing");
  assert.equal((await act(id, "refuse", {}, dispatcher)).status, 403, "returns.create is missing");
  const collector = await makeStaff("coll", "custom", ["orders.view", "orders.dispatch", "credit.collect"]);
  const partial = await act(id, "deliver", { returns: [{ productId: (await Product.findOne({}).lean())._id.toString(), qty: 1 }] }, collector);
  assert.equal(partial.status, 403, "returned lines need returns.create");
  // the cashier template can run the whole flow (it holds credit.create, credit.collect, returns.create) although it has no cashbox.manage
  const cashier = await makeStaff("cash", "cashier");
  ok(await act(id, "deliver", {}, cashier));
  assert.equal(ok(await staff("GET", `/api/couriers/${courier.id}`)).boxBalance, 130);
  // couriers: website.manage + customers.manage
  const onlySite = await makeStaff("site", "custom", ["website.manage"]);
  assert.equal((await staff("POST", "/api/couriers", { name: "س", phone: "01000000001" }, onlySite)).status, 403);
  const both = await makeStaff("both", "custom", ["website.manage", "customers.manage"]);
  ok(await staff("POST", "/api/couriers", { name: "س", phone: "01000000001" }, both), 201);
});

it("courier: created with a cash box (not main, no shifts) and a labeled customer in one transaction; the phone must be free", async () => {
  await startLedger();
  const courier = await newCourier("محمود");
  const box = await require("../src/models/cashBox.model").findById(courier.boxId).lean();
  assert.equal(box.type, "cash"); assert.equal(Boolean(box.isMain), false); assert.equal(box.shiftsEnabled, false); assert.equal(box.isActive, true);
  assert.ok((await Account.findById(box.accountId).lean()), "its ledger account exists");
  const customer = await require("../src/models/customer.model").findById(courier.customerId).lean();
  assert.equal(customer.isCourier, true); assert.equal(String(customer.courierId), courier.id);
  const list = ok(await staff("GET", "/api/customers")); assert.equal(list.find((row) => row._id === courier.customerId).isCourier, true);
  const clash = await staff("POST", "/api/couriers", { name: "تاني", phone: courier.phone });
  assert.equal(clash.status, 409); assert.equal(clash.json.code, "PHONE_IN_USE");
  assert.equal(await Courier.countDocuments({}), 1, "nothing half-created");
  assert.equal(await require("../src/models/cashBox.model").countDocuments({ isMain: false }), 1);
  const renamed = ok(await staff("PUT", `/api/couriers/${courier.id}`, { name: "محمود علي" }));
  assert.equal(renamed.name, "محمود علي");
  assert.equal((await require("../src/models/cashBox.model").findById(courier.boxId).lean()).name, "مندوب – محمود علي");
});

it("courier deactivation is blocked with open orders, cash in his box or a customer balance", async () => {
  const { courier, id } = await shop({ qty: 1 });
  ok(await act(id, "confirm")); ok(await act(id, "dispatch", { courierId: courier.id }));
  const open = await staff("PUT", `/api/couriers/${courier.id}`, { isActive: false });
  assert.equal(open.status, 409); assert.equal(open.json.code, "COURIER_HAS_OPEN_ORDERS");
  ok(await act(id, "deliver", { collectedAmount: 100 }));
  const cash = await staff("PUT", `/api/couriers/${courier.id}`, { isActive: false });
  assert.equal(cash.status, 409); assert.equal(cash.json.code, "COURIER_BOX_NOT_EMPTY");
  ok(await staff("POST", "/api/cashbox/transfers", { fromBoxId: courier.boxId, toBoxId: await mainBoxId(), amount: 100 }), 201);
  const debt = await staff("PUT", `/api/couriers/${courier.id}`, { isActive: false });
  assert.equal(debt.status, 409); assert.equal(debt.json.code, "COURIER_HAS_BALANCE", "he still owes 30");
  // the courier pays the rest through the ordinary customer payment: now he can be deactivated
  ok(await staff("POST", `/api/credit-sales/${(await getOrder(id)).creditSale.id}/payments`, { amount: 30, boxId: await mainBoxId() }), 201);
  assert.equal(ok(await staff("PUT", `/api/couriers/${courier.id}`, { isActive: false })).isActive, false);
});

it("a courier who is deactivated cannot take orders; a dispatched order needs an active courier", async () => {
  const { courier, id } = await shop({ qty: 1 });
  ok(await staff("PUT", `/api/couriers/${courier.id}`, { isActive: false }));
  ok(await act(id, "confirm"));
  const refused = await act(id, "dispatch", { courierId: courier.id });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "COURIER_INACTIVE");
  assert.equal((await act(id, "dispatch", {})).status, 400);
});

it("website customers: search, order count, deactivate; reset password shows a temporary password once and ends their sessions", async () => {
  await openSite();
  const registered = ok(await store("POST", "/api/store/auth/register", { name: "منى", phone: PHONE, password: "customer-pass-1" }), 201);
  ok(await store("POST", "/api/store/auth/register", { name: "علي", phone: "01111111111", password: "customer-pass-1" }), 201);
  const product = await seedProduct({ code: "W1" }); const zone = await seedZone();
  ok(await store("POST", "/api/store/orders", orderBody([{ productId: product.id, qty: 1 }], zone.id), registered.token), 201);
  const found = ok(await staff("GET", "/api/website/customers?q=منى"));
  assert.equal(found.data.length, 1); assert.equal(found.data[0].ordersCount, 1); assert.equal(found.data[0].passwordHash, undefined);
  assert.equal(ok(await staff("GET", `/api/website/customers?q=0111`)).data[0].name, "علي");
  ok(await store("GET", "/api/store/me", undefined, registered.token));
  const reset = ok(await staff("POST", `/api/website/customers/${found.data[0].id}/reset-password`));
  assert.ok(typeof reset.temporaryPassword === "string" && reset.temporaryPassword.length >= 10);
  assert.equal((await store("GET", "/api/store/me", undefined, registered.token)).status, 401, "the old session ended");
  const login = ok(await store("POST", "/api/store/auth/login", { phone: PHONE, password: reset.temporaryPassword }));
  assert.ok(login.token);
  assert.equal((await StoreCustomer.findById(found.data[0].id).lean()).tokenVersion, 1);
  ok(await staff("PUT", `/api/website/customers/${found.data[0].id}`, { isActive: false }));
  assert.equal((await store("GET", "/api/store/me", undefined, login.token)).status, 401);
  assert.equal((await store("POST", "/api/store/auth/login", { phone: PHONE, password: reset.temporaryPassword })).status, 401);
});

it("a locked accounting period refuses dispatch and delivery with the existing message, and nothing changes", async () => {
  const { courier, id } = await shop({ qty: 1 });
  ok(await act(id, "confirm"));
  const tomorrow = new Date(Date.now() + 2 * 86400000);
  await Meta.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": tomorrow } });
  const locked = await act(id, "dispatch", { courierId: courier.id });
  assert.equal(locked.status, 409); assert.equal(locked.json.code, "PERIOD_LOCKED");
  assert.equal((await WebOrder.findById(id).lean()).status, "confirmed"); assert.equal(await CreditSale.countDocuments({}), 0);
  await Meta.updateOne({ _id: "schema" }, { $unset: { "closing.lockedThrough": "" } });
  ok(await act(id, "dispatch", { courierId: courier.id }));
  await Meta.updateOne({ _id: "schema" }, { $set: { "closing.lockedThrough": tomorrow } });
  const deliver = await act(id, "deliver", {});
  assert.equal(deliver.status, 409); assert.equal(deliver.json.code, "PERIOD_LOCKED");
  assert.equal((await WebOrder.findById(id).lean()).status, "out_for_delivery"); assert.equal(await Receipt.countDocuments({}), 0);
});

it("the summary counts new orders only; the list filters by status, search, courier and dates and counts per status", async () => {
  const { courier, id, zone, product } = await shop({ qty: 1 });
  const second = await place([{ productId: product.id, qty: 1 }], zone.id, { contact: { name: "سعيد", phone: "01555555555", address: "ش", notes: "" } });
  assert.equal(ok(await staff("GET", "/api/orders/summary")).newCount, 2);
  ok(await act(id, "confirm")); ok(await act(id, "dispatch", { courierId: courier.id }));
  assert.equal(ok(await staff("GET", "/api/orders/summary")).newCount, 1);
  const all = ok(await staff("GET", "/api/orders"));
  assert.equal(all.counts.new, 1); assert.equal(all.counts.out_for_delivery, 1); assert.equal(all.pagination.totalItems, 2);
  assert.deepEqual(ok(await staff("GET", "/api/orders?status=new")).data.map((row) => row.id), [second.id]);
  assert.equal(ok(await staff("GET", `/api/orders?courierId=${courier.id}`)).data[0].courierName, "أحمد");
  assert.equal(ok(await staff("GET", "/api/orders?q=سعيد")).data.length, 1);
  assert.equal(ok(await staff("GET", "/api/orders?q=0155")).data.length, 1);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(ok(await staff("GET", `/api/orders?from=${day}&to=${day}`)).data.length, 2);
  assert.equal(ok(await staff("GET", "/api/orders?from=2001-01-01&to=2001-01-02")).data.length, 0);
  assert.deepEqual(ok(await staff("GET", "/api/orders/delivery-zones")).data.map((zone) => zone.name), ["القاهرة"], "the edit form's zones need orders.manage only");
  const detail = await getOrder(id);
  assert.equal(detail.items[0].inventoryCount, 19); assert.equal(detail.creditSale.shippingFees, 30);
  assert.ok(!("idempotencyKey" in detail) && !("trackingTokenHash" in detail) && !("requestHash" in detail));
});
