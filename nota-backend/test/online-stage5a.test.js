// Online Stage 5A tests: pickup, wallet transfers (InstaPay / Vodafone Cash), stock display rules, visibility modes + migration 13,
// public product data, related / bestselling, settings validation and permissions. Real throwaway mongod (port 27124, replica set).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage5a-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage5a-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const Category = require("../src/models/category.model");
const CreditSale = require("../src/models/creditSale.model");
const Counter = require("../src/models/counter.model");
const CashBox = require("../src/models/cashBox.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const Product = require("../src/models/product.model");
const Receipt = require("../src/models/receipt.model");
const ReturnLog = require("../src/models/returnLog.model");
const Selling = require("../src/models/selling.model");
const WebOrder = require("../src/models/webOrder.model");
const WebsiteSettings = require("../src/models/websiteSettings.model");
const { migrations, runMigrations } = require("../src/migrations");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHONE = "01012345678";
let categorySeq = 0; let phoneSeq = 0; let codeSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27124 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s5-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s5-owner", password: "owner-pass-123" } })).json.token;
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

async function seedProduct({ name = "منتج", code = `P${++codeSeq}`, stock = 50, retail = 100, discount = 0, cost = 50, visibility = "show", categoryId, categoryVisibility = "show", exempt = false } = {}) {
  let category = categoryId;
  if (!category) {
    const created = ok(await staff("POST", "/api/categories", { name: `فئة ${name} ${++categorySeq}`, image: PNG_URI }), 201);
    category = created._id || created.id || created.category?._id;
    if (categoryVisibility) ok(await staff("PUT", `/api/website/categories/${category}`, { visibility: categoryVisibility, sortOrder: 1 }));
  }
  const wholesale = Math.min(60, retail);
  const created = ok(await staff("POST", "/api/products", {
    name, code, categoryId: category, inventoryCount: stock, purchasePrice: Math.min(cost, wholesale), wholesalePrice: wholesale, retailPrice: retail,
    ...(discount ? { discountPercentage: discount } : {}), image: PNG_URI, ...(exempt ? { vatExempt: true } : {}),
  }), 201);
  const id = created._id || created.product?._id;
  if (visibility) ok(await staff("PUT", `/api/website/products/${id}`, { visibility, description: "وصف", images: [PNG_URI] }));
  return { id, category };
}
const putSettings = (body, token) => staff("PUT", "/api/website/settings", body, token);
const openSite = async (extra = {}) => ok(await putSettings({ enabled: true, orderingEnabled: true, title: "متجر", ...extra }));
const seedZone = async (extra = {}) => ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة", ...extra }), 201);
const deliveryBody = (items, zoneId, extra = {}) => ({ items, zoneId, idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" }, ...extra });
const pickupBody = (items, extra = {}) => ({ items, fulfillment: "pickup", idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE }, ...extra });
const placeRaw = (body) => store("POST", "/api/store/orders", body);
const place = async (body) => ok(await placeRaw(body), 201);
const act = (id, action, body, token = ownerToken) => staff("POST", `/api/orders/${id}/${action}`, body ?? {}, token);
const getOrder = async (id) => ok(await staff("GET", `/api/orders/${id}`));
const stockOf = async (id) => (await Product.findById(id).lean()).inventoryCount;
const boxes = async () => ok(await staff("GET", "/api/cashbox/boxes")).data;
const boxBalance = async (id) => (await boxes()).find((box) => String(box._id) === String(id)).balance;
const mainBoxId = async () => (await boxes()).find((box) => box.isMain)._id;
async function newCourier(name = "أحمد") {
  return ok(await staff("POST", "/api/couriers", { name, phone: `0100000${String(++phoneSeq).padStart(4, "0")}` }), 201);
}
async function newBox(name, type = "wallet") {
  const created = ok(await staff("POST", "/api/cashbox/boxes", { name, type, ...(type === "cash" ? { shiftsEnabled: false } : {}) }), 201);
  return created._id || created.box?._id || created.id;
}

/** Both transfer methods on, each into its own wallet box; pickup on. */
async function setupPayments() {
  const insta = await newBox("إنستا باي"); const voda = await newBox("فودافون كاش");
  await openSite({ fulfillment: { delivery: true, pickup: true }, payments: { instapay: { enabled: true, address: "shop@instapay", boxId: insta }, vodafoneCash: { enabled: true, number: PHONE, boxId: voda } } });
  return { insta, voda };
}
/** A shop with the ledger, the site open (pickup + wallets on), a zone (fee 30), one product (100, stock 20) and a courier. */
async function shop({ stock = 20, retail = 100 } = {}) {
  await startLedger();
  const wallets = await setupPayments();
  const product = await seedProduct({ stock, retail });
  const zone = await seedZone();
  const courier = await newCourier();
  return { ...wallets, product, zone, courier };
}
const sellingOf = async (order) => Selling.findById((await WebOrder.findById(order).lean()).cashSaleId).lean();
const postedEntries = (sourceType, id) => JournalEntry.countDocuments({ "source.type": sourceType, "source.id": id });

// ---------------------------------------------------------------------------------------------------------------------
// pickup

it("pickup + cash: new → confirmed → preparing → ready → picked up = a cash sale into the chosen box; stock and posting like any cash sale", async () => {
  const { product } = await shop();
  const drawer = await newBox("درج 2", "cash");
  const placed = await place(pickupBody([{ productId: product.id, qty: 3 }]));
  assert.equal(placed.fulfillment, "pickup"); assert.equal(placed.deliveryFee, 0); assert.equal(placed.total, 300); assert.equal(placed.paymentStatus, null);
  const order = await WebOrder.findById(placed.id).lean();
  assert.equal(order.zone, undefined, "no zone"); assert.ok(!order.contact.address, "address is optional");
  const mainBefore = await boxBalance(await mainBoxId());

  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare"));
  assert.equal((await act(placed.id, "pickup")).status, 409, "not ready yet");
  const ready = ok(await act(placed.id, "ready"));
  assert.equal(ready.status, "ready_for_pickup"); assert.equal(await stockOf(product.id), 20, "nothing deducted before pickup");
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 17, "ready orders still reserve their stock");

  const done = ok(await act(placed.id, "pickup", { boxId: drawer }));
  assert.equal(done.status, "picked_up"); assert.equal(done.invoice.kind, "cash"); assert.equal(done.invoice.totalPrice, 300);
  const sale = await sellingOf(placed.id);
  assert.equal(sale.totalPrice, 300); assert.equal(sale.shippingFees, 0); assert.equal(String(sale.boxId), String(drawer));
  assert.equal(sale.items.length, 1); assert.equal(sale.items[0].quantity, 3); assert.equal(sale.items[0].unitPrice, 100);
  assert.equal(await stockOf(product.id), 17, "stock deducted by the cash sale");
  assert.ok(await postedEntries("sale", sale._id) >= 1, "posted like a cash sale");
  assert.equal(await boxBalance(drawer), 300); assert.equal(await boxBalance(await mainBoxId()), mainBefore);
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 17, "the reservation is gone, the stock is really sold");
  assert.deepEqual((await getOrder(placed.id)).statusHistory.map((row) => row.status), ["new", "confirmed", "preparing", "ready_for_pickup", "picked_up"]);
  assert.equal((await act(placed.id, "pickup")).status, 409, "a second click creates nothing");
  assert.equal(await Selling.countDocuments({}), 1);
});

it("pickup + cash without a box uses the device's default box (resolveBox), and a second parallel pickup creates one sale only", async () => {
  const { product } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 1 }]));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare")); ok(await act(placed.id, "ready"));
  const results = await Promise.all([act(placed.id, "pickup"), act(placed.id, "pickup")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await Selling.countDocuments({}), 1);
  assert.equal(String((await sellingOf(placed.id)).boxId), String(await mainBoxId()));
  assert.equal(await stockOf(product.id), 19);
});

it("pickup never collected: ready_for_pickup → cancelled needs a reason, releases the reservation, posts nothing", async () => {
  const { product } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 5 }]));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare")); ok(await act(placed.id, "ready"));
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 15);
  assert.equal((await act(placed.id, "cancel", {})).status, 400, "reason required");
  const cancelled = ok(await act(placed.id, "cancel", { reason: "العميل مجاش" }));
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.reason, "العميل مجاش");
  assert.equal(ok(await store("GET", `/api/store/products/${product.id}`)).maxOrderQty, 20, "the reservation is released");
  assert.equal(await Selling.countDocuments({}), 0); assert.equal(await stockOf(product.id), 20);
  // a delivery order cannot use the pickup transitions, and cannot be cancelled from a pickup-only status
  const zone = await seedZone({ name: "الجيزة" });
  const delivery = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id));
  ok(await act(delivery.id, "confirm")); ok(await act(delivery.id, "prepare"));
  const wrong = await act(delivery.id, "ready"); assert.equal(wrong.status, 409); assert.equal(wrong.json.code, "WRONG_FULFILLMENT");
  assert.equal((await act(delivery.id, "pickup")).status, 409);
});

it("pickup orders cannot be edited with a zone or a fee; contact edits may clear the address; lines are repriced with no fee", async () => {
  const { product, zone } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 2 }]));
  assert.equal((await staff("PUT", `/api/orders/${placed.id}`, { zoneId: zone.id })).status, 400);
  assert.equal((await staff("PUT", `/api/orders/${placed.id}`, { deliveryFee: 5 })).status, 400);
  const edited = ok(await staff("PUT", `/api/orders/${placed.id}`, { items: [{ productId: product.id, qty: 4 }], contact: { address: "" } }));
  assert.equal(edited.total, 400); assert.equal(edited.deliveryFee, 0); assert.equal(edited.zone, null);
});

// ---------------------------------------------------------------------------------------------------------------------
// wallets

it("pickup + wallet: refused before the transfer is verified; verifying posts nothing; the sale goes into the wallet's box whatever box is sent", async () => {
  const { product, insta, voda } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 2 }], { paymentMethod: "instapay" }));
  assert.equal(placed.paymentMethod, "instapay"); assert.equal(placed.paymentStatus, "unpaid");
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare")); ok(await act(placed.id, "ready"));
  const early = await act(placed.id, "pickup");
  assert.equal(early.status, 409); assert.equal(early.json.code, "PAYMENT_NOT_VERIFIED");
  assert.equal((await WebOrder.findById(placed.id).lean()).status, "ready_for_pickup");

  const entriesBefore = await JournalEntry.countDocuments({});
  const verified = ok(await act(placed.id, "verify-payment", { reference: "TX-123" }));
  assert.equal(verified.payment.status, "verified"); assert.equal(verified.payment.reference, "TX-123"); assert.ok(verified.payment.verifiedAt);
  assert.equal(await JournalEntry.countDocuments({}), entriesBefore, "nothing is posted when the transfer is verified");
  assert.equal(await Selling.countDocuments({}), 0);
  assert.equal((await act(placed.id, "verify-payment", {})).json.code, "ALREADY_VERIFIED");
  assert.equal((await store("GET", `/api/store/orders/track/${placed.trackingToken}`)).json.paymentStatus, "verified");

  const done = ok(await act(placed.id, "pickup", { boxId: voda }));
  assert.equal(done.status, "picked_up");
  const sale = await sellingOf(placed.id);
  assert.equal(String(sale.boxId), String(insta), "the box configured for the method, not the one sent");
  assert.equal(sale.totalPrice, 200);
  assert.equal(await boxBalance(insta), 200); assert.equal(await boxBalance(voda), 0);
  assert.equal(await stockOf(product.id), 18);
});

it("the wallet box is the one configured when the transfer was verified, even if the setting changes afterwards", async () => {
  const { product, insta } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "instapay" }));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare")); ok(await act(placed.id, "ready"));
  ok(await act(placed.id, "verify-payment", {}));
  const other = await newBox("محفظة تانية");
  ok(await putSettings({ payments: { instapay: { boxId: other } } }));
  ok(await act(placed.id, "pickup"));
  assert.equal(String((await sellingOf(placed.id)).boxId), String(insta));
});

it("delivery + wallet: send out is refused until verified; then a CASH sale with shippingFees goes into the wallet box; the courier collects nothing", async () => {
  const { product, zone, courier, insta } = await shop();
  const placed = await place(deliveryBody([{ productId: product.id, qty: 2 }], zone.id, { paymentMethod: "instapay" }));
  assert.equal(placed.total, 230);
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare"));
  const early = await act(placed.id, "dispatch", { courierId: courier.id });
  assert.equal(early.status, 409); assert.equal(early.json.code, "PAYMENT_NOT_VERIFIED");
  assert.equal((await WebOrder.findById(placed.id).lean()).status, "preparing"); assert.equal(await Selling.countDocuments({}), 0); assert.equal(await CreditSale.countDocuments({}), 0);

  ok(await act(placed.id, "verify-payment", { reference: "IP-9" }));
  const dispatched = ok(await act(placed.id, "dispatch", { courierId: courier.id }));
  assert.equal(dispatched.status, "out_for_delivery"); assert.equal(dispatched.invoice.kind, "cash");
  const sale = await sellingOf(placed.id);
  assert.equal(sale.totalPrice, 230); assert.equal(sale.shippingFees, 30); assert.equal(String(sale.boxId), String(insta));
  assert.equal((await WebOrder.findById(placed.id).lean()).creditSaleId, undefined); assert.equal(await CreditSale.countDocuments({}), 0, "not a credit sale on the courier");
  assert.equal(await stockOf(product.id), 18);
  assert.equal(await boxBalance(insta), 230);
  assert.equal(ok(await staff("GET", `/api/customers/${courier.customerId}/credit`)).balance, 0, "the courier owes nothing");

  const delivered = ok(await act(placed.id, "deliver", {}));
  assert.equal(delivered.status, "delivered");
  assert.equal(await Receipt.countDocuments({}), 0, "delivered collects nothing");
  const after = ok(await staff("GET", `/api/couriers/${courier.id}`));
  assert.equal(after.boxBalance, 0); assert.equal(after.amountOwed, 0); assert.equal(after.openOrders, 0);
  assert.equal(await boxBalance(insta), 230);
});

it("delivery + wallet refusal is a full return of the cash sale, refunded from the wallet's box (delivery fee included)", async () => {
  const { product, zone, courier, voda } = await shop();
  const placed = await place(deliveryBody([{ productId: product.id, qty: 3 }], zone.id, { paymentMethod: "vodafone_cash" }));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "verify-payment", {}));
  ok(await act(placed.id, "dispatch", { courierId: courier.id }));
  assert.equal(await boxBalance(voda), 330); assert.equal(await stockOf(product.id), 17);
  const refused = ok(await act(placed.id, "refuse", { reason: "رفض" }));
  assert.equal(refused.status, "refused");
  assert.equal(await stockOf(product.id), 20);
  const sale = await sellingOf(placed.id);
  assert.equal(sale.refundStatus, "full");
  const log = await ReturnLog.findOne({ invoiceId: sale._id }).lean();
  assert.equal(log.finalReturnedAmount, 330); assert.equal(log.shippingFees, 30); assert.equal(String(log.boxId), String(voda));
  assert.equal(await boxBalance(voda), 0, "refunded from the wallet's box");
  assert.equal((await WebOrder.findById(placed.id).lean()).returnIds.length, 1);
  assert.equal(await Receipt.countDocuments({}), 0);
});

it("delivery + wallet: returned lines at delivery are a partial cash-sale return from the wallet's box", async () => {
  const { product, zone, courier, insta } = await shop();
  const placed = await place(deliveryBody([{ productId: product.id, qty: 4 }], zone.id, { paymentMethod: "instapay" }));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "verify-payment", {})); ok(await act(placed.id, "dispatch", { courierId: courier.id }));
  const delivered = ok(await act(placed.id, "deliver", { returns: [{ productId: product.id, qty: 1 }] }));
  assert.equal(delivered.status, "delivered");
  assert.equal(await stockOf(product.id), 17);
  const log = await ReturnLog.findOne({ invoiceId: (await sellingOf(placed.id))._id }).lean();
  assert.equal(log.finalReturnedAmount, 100); assert.equal(log.shippingFees, 0); assert.equal(String(log.boxId), String(insta));
  assert.equal(await boxBalance(insta), 330);
  assert.equal(await Receipt.countDocuments({}), 0);
  const all = await place(deliveryBody([{ productId: product.id, qty: 1 }], (await WebOrder.findById(placed.id).lean()).zone.id, { paymentMethod: "instapay" }));
  ok(await act(all.id, "confirm")); ok(await act(all.id, "verify-payment", {})); ok(await act(all.id, "dispatch", { courierId: courier.id }));
  assert.equal((await act(all.id, "deliver", { returns: [{ productId: product.id, qty: 1 }] })).json.code, "USE_REFUSE");
});

it("cancelling a verified order before any invoice posts and reverses nothing", async () => {
  const { product } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "vodafone_cash" }));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "verify-payment", {}));
  const entries = await JournalEntry.countDocuments({});
  const cancelled = ok(await act(placed.id, "cancel", { reason: "استرجاع التحويل برا نوتا" }));
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.payment.status, "verified");
  assert.equal(await JournalEntry.countDocuments({}), entries); assert.equal(await Selling.countDocuments({}), 0);
});

it("a verified order cannot be edited to a different total; a contact-only edit is fine; COD orders are unaffected", async () => {
  const { product } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "instapay" }));
  ok(await act(placed.id, "verify-payment", {}));
  const refused = await staff("PUT", `/api/orders/${placed.id}`, { items: [{ productId: product.id, qty: 2 }] });
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "PAYMENT_VERIFIED");
  ok(await staff("PUT", `/api/orders/${placed.id}`, { contact: { notes: "بعد الساعة 5" } }));
  const cod = await place(pickupBody([{ productId: product.id, qty: 1 }]));
  assert.equal((await act(cod.id, "verify-payment", {})).json.code, "NOT_WALLET_ORDER");
  ok(await staff("PUT", `/api/orders/${cod.id}`, { items: [{ productId: product.id, qty: 2 }] }));
});

// ---------------------------------------------------------------------------------------------------------------------
// order total = invoice total

for (const mode of ["inclusive", "exclusive", "none"]) {
  it(`the order total is the invoice total to the piastre in every fulfillment × payment combination (VAT ${mode})`, async () => {
    await startLedger();
    if (mode !== "none") await enableVat({ includes: mode === "inclusive" });
    await setupPayments();
    const a = await seedProduct({ name: "أ", retail: 100, discount: 10, stock: 500 });
    const b = await seedProduct({ name: "ب", retail: 33.33, stock: 500, categoryId: a.category });
    const c = await seedProduct({ name: "ج", retail: 65, stock: 500, categoryId: a.category, exempt: true });
    const paid = await seedZone({ fee: 25 }); const free = await seedZone({ name: "قريب", fee: 0 });
    const courier = await newCourier();
    const lines = [{ productId: a.id, qty: 4 }, { productId: b.id, qty: 3 }, { productId: c.id, qty: 2 }];

    const combos = [
      ["delivery", "cod", paid], ["delivery", "cod", free], ["delivery", "instapay", paid], ["delivery", "vodafone_cash", free],
      ["pickup", "cod"], ["pickup", "instapay"], ["pickup", "vodafone_cash"],
    ];
    for (const [fulfillment, paymentMethod, zone] of combos) {
      const label = `${fulfillment}/${paymentMethod}${zone ? `/fee ${zone.fee}` : ""}`;
      const placed = await place(fulfillment === "pickup" ? pickupBody(lines, { paymentMethod }) : deliveryBody(lines, zone.id, { paymentMethod }));
      ok(await act(placed.id, "confirm"));
      if (paymentMethod !== "cod") ok(await act(placed.id, "verify-payment", {}));
      let invoice;
      if (fulfillment === "pickup") { ok(await act(placed.id, "prepare")); ok(await act(placed.id, "ready")); ok(await act(placed.id, "pickup")); invoice = await sellingOf(placed.id); }
      else {
        ok(await act(placed.id, "dispatch", { courierId: courier.id }));
        const order = await WebOrder.findById(placed.id).lean();
        invoice = order.cashSaleId ? await Selling.findById(order.cashSaleId).lean() : await CreditSale.findById(order.creditSaleId).lean();
        assert.equal(Boolean(order.cashSaleId), paymentMethod !== "cod", `${label}: cash sale for wallets, credit sale for COD`);
      }
      const order = await WebOrder.findById(placed.id).lean();
      assert.equal(cents(order.total), cents(invoice.totalPrice), `${label}: total`);
      assert.equal(order.deliveryFee, invoice.shippingFees || 0, `${label}: fee`);
      assert.equal(cents(order.vat), cents(invoice.vatAmount || 0), `${label}: VAT`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// visibility modes, migration 13

it("visibility 'marked' (default): only show; 'all': everything except hide; archived products and hidden categories never show", async () => {
  await openSite();
  const shown = await seedProduct({ name: "ظاهر", visibility: "show" });
  const hidden = await seedProduct({ name: "مخفي", visibility: "hide", categoryId: shown.category });
  const unset = await seedProduct({ name: "غير محدد", visibility: null, categoryId: shown.category });
  const archived = await seedProduct({ name: "مؤرشف", visibility: "show", categoryId: shown.category });
  await Product.updateOne({ _id: archived.id }, { $set: { isArchived: true } });
  const hiddenCategory = await seedProduct({ name: "فئة مخفية", visibility: "show", categoryVisibility: "hide" });
  const unsetCategory = await seedProduct({ name: "فئة غير محددة", visibility: null, categoryVisibility: null });
  const names = async () => ok(await store("GET", "/api/store/products?limit=48&sort=name")).data.map((p) => p.name).sort();

  assert.deepEqual(await names(), ["ظاهر"], "marked: only products marked show, in categories marked show");
  assert.deepEqual((await Promise.all([shown, hidden, unset, archived, hiddenCategory].map((p) => store("GET", `/api/store/products/${p.id}`)))).map((r) => r.status), [200, 404, 404, 404, 404]);
  assert.deepEqual(ok(await store("GET", "/api/store/categories")).data.map((c) => c.id), [shown.category]);

  ok(await putSettings({ productVisibility: "all" }));
  assert.deepEqual(await names(), ["غير محدد", "ظاهر", "فئة غير محددة"].sort(), "all: unset shows, hide does not; hidden category and archived never");
  assert.deepEqual((await Promise.all([shown, hidden, unset, archived, hiddenCategory, unsetCategory].map((p) => store("GET", `/api/store/products/${p.id}`)))).map((r) => r.status), [200, 404, 200, 404, 404, 200]);
  assert.deepEqual(ok(await store("GET", "/api/store/categories")).data.map((c) => c.id).sort(), [shown.category, unsetCategory.category].sort());
  assert.equal((await store("GET", `/api/store/images/category/${hiddenCategory.category}`, undefined)).status, 404);
  assert.equal((await store("GET", `/api/store/images/category/${unsetCategory.category}`)).status, 200);
  assert.equal((await store("GET", `/api/store/images/product/${hidden.id}/0`)).status, 404);

  ok(await putSettings({ productVisibility: "marked" }));
  assert.deepEqual(await names(), ["ظاهر"]);
  assert.equal((await putSettings({ productVisibility: "everything" })).status, 400);
});

it("visibility API: show / hide / null (unset); the old `visible` boolean is refused", async () => {
  const { id, category } = await seedProduct({ visibility: null });
  ok(await staff("PUT", `/api/website/products/${id}`, { visibility: "hide" }));
  assert.equal(ok(await staff("GET", `/api/website/products/${id}`)).website.visibility, "hide");
  ok(await staff("PUT", `/api/website/products/${id}`, { visibility: null }));
  assert.equal(ok(await staff("GET", `/api/website/products/${id}`)).website.visibility, null);
  assert.equal((await Product.findById(id).lean()).website.visibility, undefined);
  assert.equal((await staff("PUT", `/api/website/products/${id}`, { visible: true })).status, 400);
  assert.equal((await staff("PUT", `/api/website/categories/${category}`, { visible: true })).status, 400);
  assert.equal((await staff("PUT", `/api/website/products/${id}`, { visibility: "maybe" })).status, 400);
  assert.equal(ok(await staff("PUT", `/api/website/categories/${category}`, { visibility: "hide" })).website.visibility, "hide");
});

it("migration 13: visible true → show; false and missing → unset; the old field is removed; running it twice changes nothing", async () => {
  const migration = migrations.find((entry) => entry.version === 13);
  assert.ok(migration);
  const categories = await Category.collection.insertMany([
    { name: "أ", website: { visible: true, sortOrder: 2 } }, { name: "ب", website: { visible: false, sortOrder: 0 } }, { name: "ج" },
  ]);
  const base = { inventoryCount: 1, retailPrice: 5, wholesalePrice: 4, purchasePrice: 3, createdAt: new Date(), updatedAt: new Date() };
  const products = await Product.collection.insertMany([
    { ...base, name: "منتج ١", code: "M1", website: { visible: true, description: "وصف", images: [] } },
    { ...base, name: "منتج ٢", code: "M2", website: { visible: false, images: [] } },
    { ...base, name: "منتج ٣", code: "M3" },
  ]);
  await migration.run();
  const [p1, p2, p3] = await Promise.all(Object.values(products.insertedIds).map((id) => Product.collection.findOne({ _id: id })));
  assert.equal(p1.website.visibility, "show"); assert.equal(p1.website.visible, undefined); assert.equal(p1.website.description, "وصف");
  assert.equal(p2.website.visibility, undefined); assert.equal(p2.website.visible, undefined); assert.deepEqual(p2.website.images, []);
  assert.equal(p3.website, undefined);
  const [c1, c2, c3] = await Promise.all(Object.values(categories.insertedIds).map((id) => Category.collection.findOne({ _id: id })));
  assert.equal(c1.website.visibility, "show"); assert.equal(c1.website.sortOrder, 2); assert.equal(c1.website.visible, undefined);
  assert.equal(c2.website.visibility, undefined); assert.equal(c2.website.visible, undefined); assert.equal(c3.website, undefined);
  const snapshot = JSON.stringify(await Product.collection.find({}).toArray());
  await migration.run();
  assert.equal(JSON.stringify(await Product.collection.find({}).toArray()), snapshot);
  assert.equal(await Product.collection.countDocuments({ "website.visible": { $exists: true } }), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// stock display

it("remaining: shown only between 1 and the threshold, counts reserved stock; showRemaining off removes it", async () => {
  await startLedger(); await openSite();
  const product = await seedProduct({ stock: 10 }); const zone = await seedZone();
  const remaining = async () => ok(await store("GET", `/api/store/products/${product.id}`)).remaining;
  assert.equal(await remaining(), undefined, "10 > 5");
  const order = await place(deliveryBody([{ productId: product.id, qty: 6 }], zone.id));
  assert.equal(await remaining(), undefined, "an unconfirmed order reserves nothing");
  ok(await act(order.id, "confirm"));
  assert.equal(await remaining(), 4, "10 - 6 reserved = 4, inside the default threshold 5");
  assert.equal(ok(await store("GET", "/api/store/products?limit=48")).data[0].remaining, 4);
  ok(await putSettings({ stock: { showRemaining: { threshold: 3 } } }));
  assert.equal(await remaining(), undefined, "4 > 3");
  ok(await putSettings({ stock: { showRemaining: { threshold: 10, enabled: false } } }));
  assert.equal(await remaining(), undefined, "switched off");
  ok(await putSettings({ stock: { showRemaining: { enabled: true } } }));
  assert.equal(await remaining(), 4);
  await Product.updateOne({ _id: product.id }, { $set: { inventoryCount: 0 } });
  assert.equal(await remaining(), undefined, "0 left: no number");
  assert.equal((await putSettings({ stock: { showRemaining: { threshold: 0 } } })).status, 400);
});

it("showOutOfStock: true shows 'out_of_stock' products that cannot be ordered; false hides them, including fully reserved ones, everywhere", async () => {
  await startLedger(); await openSite();
  const inStock = await seedProduct({ name: "موجود", stock: 10 });
  const empty = await seedProduct({ name: "خلصان", stock: 0, categoryId: inStock.category });
  const reserved = await seedProduct({ name: "محجوز", stock: 2, categoryId: inStock.category });
  const zone = await seedZone();
  const order = await place(deliveryBody([{ productId: reserved.id, qty: 2 }], zone.id));
  ok(await act(order.id, "confirm"));

  const shownNow = ok(await store("GET", "/api/store/products?limit=48")).data;
  assert.equal(shownNow.length, 3);
  const emptyRow = shownNow.find((p) => p.name === "خلصان");
  assert.equal(emptyRow.availability, "out_of_stock"); assert.ok(emptyRow.badges.includes("out_of_stock")); assert.equal(emptyRow.maxOrderQty, 0);
  assert.ok(shownNow.find((p) => p.name === "محجوز").badges.includes("out_of_stock"), "reserved stock counts");
  assert.equal((await placeRaw(deliveryBody([{ productId: empty.id, qty: 1 }], zone.id))).status, 409, "cannot be ordered");

  ok(await putSettings({ stock: { showOutOfStock: false } }));
  assert.deepEqual(ok(await store("GET", "/api/store/products?limit=48")).data.map((p) => p.name), ["موجود"]);
  assert.equal((await store("GET", `/api/store/products/${empty.id}`)).status, 404);
  assert.equal((await store("GET", `/api/store/products/${reserved.id}`)).status, 404);
  assert.equal(ok(await store("GET", "/api/store/categories")).data[0].productCount, 1);
  assert.equal(ok(await store("GET", `/api/store/products/${inStock.id}/related`)).data.length, 0);
  ok(await act(order.id, "cancel", { reason: "تجربة" }));
  assert.equal((await store("GET", `/api/store/products/${reserved.id}`)).status, 200, "back once the reservation is released");
});

// ---------------------------------------------------------------------------------------------------------------------
// public data

const FORBIDDEN_KEYS = new Set([
  "purchasePrice", "wholesalePrice", "profit", "inventoryCount", "soldItemCount", "lowStockThreshold", "createdBy", "updatedBy", "isArchived",
  "passwordHash", "tokenVersion", "isActive", "requestHash", "idempotencyKey", "trackingTokenHash", "storeCustomer", "__v", "vatExempt",
  "boxId", "payment", "cashSaleId", "creditSaleId", "verifiedBy",
]);
const walk = (value, visit, path = "$") => {
  if (Array.isArray(value)) return value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { visit(key, `${path}.${key}`); walk(item, visit, `${path}.${key}`); }
};
const assertClean = (response, label, allow = []) => {
  assert.ok(response.json !== null, `${label}: JSON body`);
  walk(response.json, (key, path) => assert.ok(allow.includes(key) || !FORBIDDEN_KEYS.has(key), `${label}: forbidden key ${path}`));
  assert.ok(!/base64|data:image/i.test(response.text || ""), `${label}: no base64`);
};

it("public product: code, specifications (strings only), badges; never the code of an archived product", async () => {
  await openSite();
  const { id, category } = await seedProduct({ name: "قميص", code: "SH-1", discount: 10 });
  await Product.updateOne({ _id: id }, { $set: { specifications: [{ label: "المقاس", value: "L" }, { label: 5, value: "x" }, { label: "فاضي", value: "" }, "نص", { label: "اللون", value: "أزرق", extra: "x" }] } });
  const row = ok(await store("GET", `/api/store/products/${id}`));
  assert.equal(row.code, "SH-1");
  assert.deepEqual(row.specifications, [{ label: "المقاس", value: "L" }, { label: "اللون", value: "أزرق" }]);
  assert.deepEqual(row.badges, ["discount", "new"]);
  assertClean({ json: row, text: JSON.stringify(row) }, "product");
  assert.equal(row.createdAt, undefined, "the creation date only feeds the badge");
  await Product.collection.updateOne({ _id: new (require("mongoose").Types.ObjectId)(id) }, { $set: { createdAt: new Date(Date.now() - 20 * 86400000), discountPercentage: 0 } });
  assert.deepEqual(ok(await store("GET", `/api/store/products/${id}`)).badges, [], "older than 14 days, no discount");
  assert.equal(ok(await store("GET", "/api/store/products")).data[0].code, "SH-1");
  await Product.updateOne({ _id: id }, { $set: { isArchived: true } });
  const gone = await store("GET", `/api/store/products/${id}`); assert.equal(gone.status, 404); assert.ok(!gone.text.includes("SH-1"));
  assert.ok(!(await store("GET", "/api/store/products")).text.includes("SH-1"));
  assert.ok(!(await store("GET", `/api/store/products/${(await seedProduct({ categoryId: category })).id}/related`)).text.includes("SH-1"));
});

it("related products: same category, never itself, hidden / archived excluded, in stock first, at most 8; category image URL", async () => {
  await openSite();
  const main = await seedProduct({ name: "الأساسي", stock: 5 });
  const empty = await seedProduct({ name: "خلصان", stock: 0, categoryId: main.category });
  const others = [];
  for (let i = 0; i < 9; i += 1) others.push(await seedProduct({ name: `م${i}`, stock: 5, categoryId: main.category }));
  const hidden = await seedProduct({ name: "مخفي", visibility: "hide", categoryId: main.category });
  const archived = await seedProduct({ name: "مؤرشف", categoryId: main.category }); await Product.updateOne({ _id: archived.id }, { $set: { isArchived: true } });
  const elsewhere = await seedProduct({ name: "فئة تانية" });
  const response = await store("GET", `/api/store/products/${main.id}/related`);
  const related = ok(response).data;
  assertClean(response, "related");
  assert.equal(related.length, 8);
  const ids = related.map((row) => row.id);
  assert.ok(!ids.includes(main.id)); assert.ok(!ids.includes(hidden.id)); assert.ok(!ids.includes(archived.id)); assert.ok(!ids.includes(elsewhere.id));
  assert.ok(!ids.includes(empty.id), "in-stock products fill the eight first");
  assert.ok(related.every((row) => row.availability !== "out_of_stock"));
  assert.equal((await store("GET", `/api/store/products/${hidden.id}/related`)).status, 404);
  assert.equal((await store("GET", `/api/store/products/${"a".repeat(24)}/related`)).status, 404);
  const categories = ok(await store("GET", "/api/store/categories")).data;
  const withImage = categories.find((row) => row.id === main.category);
  assert.match(withImage.image, /^\/api\/store\/images\/category\/[0-9a-f]{24}\?v=\d+$/); assert.equal(withImage.image, withImage.imageUrl);
  assert.equal((await store("GET", withImage.image)).status, 200);
  const plain = ok(await staff("POST", "/api/categories", { name: "من غير صورة" }), 201);
  ok(await staff("PUT", `/api/website/categories/${plain._id || plain.id}`, { visibility: "show" }));
  assert.equal(ok(await store("GET", "/api/store/categories")).data.find((row) => row.name === "من غير صورة").image, null);
});

it("sort=bestselling orders by sold count and never exposes it", async () => {
  await openSite();
  const a = await seedProduct({ name: "أ" }); const b = await seedProduct({ name: "ب", categoryId: a.category }); const c = await seedProduct({ name: "ج", categoryId: a.category });
  await Product.updateOne({ _id: a.id }, { $set: { soldItemCount: 3 } }); await Product.updateOne({ _id: b.id }, { $set: { soldItemCount: 50 } }); await Product.updateOne({ _id: c.id }, { $set: { soldItemCount: 10 } });
  const response = await store("GET", "/api/store/products?sort=bestselling");
  assert.deepEqual(ok(response).data.map((row) => row.name), ["ب", "ج", "أ"]);
  assertClean(response, "bestselling");
  assert.ok(!/soldItemCount|"sold/i.test(response.text));
  assert.equal((await store("GET", "/api/store/products?sort=popular")).status, 400);
});

it("public settings: brand, logo, announcement, highlights, hours, fulfillment, enabled payment methods with their details, never a box id", async () => {
  const { insta, voda } = await shop();
  await putSettings({ brandColor: WebsiteSettings.BRAND_COLORS[1].toLowerCase(), announcement: { enabled: true, text: "خصم 10%" }, openingHours: "10-10", seoDescription: "وصف", sameDayCutoff: "14:30", freeDeliveryFrom: 500 });
  let response = await store("GET", "/api/store/settings");
  let pub = ok(response);
  assertClean(response, "settings");
  assert.equal(pub.brandColor, WebsiteSettings.BRAND_COLORS[1]);
  assert.deepEqual(pub.announcement, { text: "خصم 10%" });
  assert.equal(pub.openingHours, "10-10"); assert.equal(pub.seoDescription, "وصف"); assert.equal(pub.sameDayCutoff, "14:30");
  assert.deepEqual(pub.fulfillment, { delivery: true, pickup: true });
  assert.deepEqual(pub.paymentMethods, ["cod", "instapay", "vodafone_cash"]);
  assert.deepEqual(pub.paymentDetails, { instapay: { address: "shop@instapay" }, vodafoneCash: { number: PHONE } });
  assert.equal(pub.highlights.length, 3, "three built from the settings when none are written");
  assert.deepEqual(pub.highlights.map((row) => row.icon), ["delivery", "cash", "exchange"]);
  assert.ok(pub.highlights[0].text.includes("500") && pub.highlights[1].text.includes("إنستا باي"));
  assert.ok(!response.text.includes(String(insta)) && !response.text.includes(String(voda)), "no box id anywhere");
  assert.equal(pub.logoUrl, null, "no logo yet");
  ok(await putSettings({ highlights: [{ icon: "star", title: "جودة", text: "أصلي" }], websiteLogo: PNG_URI }));
  response = await store("GET", "/api/store/settings"); pub = ok(response);
  assert.deepEqual(pub.highlights, [{ icon: "star", title: "جودة", text: "أصلي" }]);
  assert.match(pub.logoUrl, /^\/api\/store\/images\/website-logo\?v=\d+$/);
  assert.equal((await store("GET", pub.logoUrl)).status, 200);
  ok(await putSettings({ announcement: { enabled: false }, payments: { cod: { enabled: false } } }));
  pub = ok(await store("GET", "/api/store/settings"));
  assert.equal(pub.announcement, null); assert.deepEqual(pub.paymentMethods, ["instapay", "vodafone_cash"]);
  // the closed site still shows only the closed view
  ok(await putSettings({ enabled: false }));
  assert.ok(!JSON.stringify(ok(await store("GET", "/api/store/settings"))).includes("instapay"));
});

it("public order views carry fulfillment and the transfer status, never the verifier or the box", async () => {
  const { product } = await shop();
  const placed = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "instapay" }));
  ok(await act(placed.id, "verify-payment", { reference: "SECRET-REF" }));
  const tracking = await store("GET", `/api/store/orders/track/${placed.trackingToken}`);
  assertClean(tracking, "tracking");
  assert.equal(tracking.json.fulfillment, "pickup"); assert.equal(tracking.json.paymentStatus, "verified"); assert.equal(tracking.json.zone, null);
  assert.ok(!tracking.text.includes("SECRET-REF") && !tracking.text.includes("s5-owner"));
  assert.equal(tracking.json.statusHistory, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// placement checks and settings validation

it("a disabled fulfillment option or payment method is refused at placement", async () => {
  await startLedger(); await openSite();
  const product = await seedProduct({}); const zone = await seedZone();
  const items = [{ productId: product.id, qty: 1 }];
  const pickup = await placeRaw(pickupBody(items));
  assert.equal(pickup.status, 409); assert.equal(pickup.json.code, "FULFILLMENT_UNAVAILABLE", "pickup is off by default");
  const wallet = await placeRaw(deliveryBody(items, zone.id, { paymentMethod: "instapay" }));
  assert.equal(wallet.status, 409); assert.equal(wallet.json.code, "PAYMENT_UNAVAILABLE", "wallets are off by default");
  assert.equal((await placeRaw(deliveryBody(items, zone.id, { paymentMethod: "bitcoin" }))).json.code, "INVALID_PAYMENT_METHOD");
  assert.equal((await placeRaw(deliveryBody(items, zone.id, { fulfillment: "drone" }))).json.code, "INVALID_FULFILLMENT");
  assert.equal((await placeRaw(deliveryBody(items, null))).json.code, "INVALID_ZONE", "delivery needs a zone");
  assert.equal((await placeRaw(deliveryBody(items, zone.id, { contact: { name: "ع", phone: PHONE } }))).json.code, "INVALID_CONTACT", "delivery needs an address");
  ok(await placeRaw(deliveryBody(items, zone.id)), 201);
  const { insta } = await (async () => ({ insta: await newBox("إنستا") }))();
  await putSettings({ fulfillment: { delivery: false, pickup: true }, payments: { instapay: { enabled: true, address: "a@instapay", boxId: insta }, cod: { enabled: false } } });
  assert.equal((await placeRaw(deliveryBody(items, zone.id, { paymentMethod: "instapay" }))).json.code, "FULFILLMENT_UNAVAILABLE", "delivery switched off");
  assert.equal((await placeRaw(pickupBody(items))).json.code, "PAYMENT_UNAVAILABLE", "cash switched off");
  ok(await placeRaw(pickupBody(items, { paymentMethod: "instapay" })), 201);
  await CashBox.updateOne({ _id: insta }, { $set: { isActive: false } });
  assert.equal((await placeRaw(pickupBody(items, { paymentMethod: "instapay" }))).json.code, "PAYMENT_UNAVAILABLE", "the wallet box was closed");
});

it("the Stage 3 request (no fulfillment, no payment method) still hashes the same: a retry returns the same order", async () => {
  await startLedger(); await openSite();
  const product = await seedProduct({}); const zone = await seedZone();
  const body = deliveryBody([{ productId: product.id, qty: 1 }], zone.id);
  const first = ok(await placeRaw(body), 201);
  const again = ok(await placeRaw(body), 200);
  assert.equal(again.id, first.id); assert.equal(again.trackingToken, first.trackingToken);
  assert.equal((await placeRaw({ ...body, fulfillment: "pickup" })).status, 409);
  const order = await WebOrder.findById(first.id).lean();
  assert.equal(order.fulfillment, "delivery"); assert.equal(order.paymentMethod, "cod"); assert.equal(order.payment, undefined);
});

it("settings validation: boxes, required options, colors, lengths, icons, cut-off", async () => {
  await startLedger(); await openSite();
  const cash = await newBox("درج", "cash"); const wallet = await newBox("محفظة"); const bank = await newBox("بنك", "bank");
  const bad = async (body, code) => { const response = await putSettings(body); assert.equal(response.status, 400, JSON.stringify(body)); if (code) assert.equal(response.json.code, code); };
  await bad({ payments: { instapay: { enabled: true, address: "a@b", boxId: cash } } }, "INVALID_BOX");
  await bad({ payments: { instapay: { enabled: true, address: "a@b", boxId: "a".repeat(24) } } }, "INVALID_BOX");
  await bad({ payments: { instapay: { enabled: true, address: "a@b" } } }, "INVALID_BOX");
  await bad({ payments: { instapay: { enabled: true, boxId: wallet } } }, "INVALID_IPA");
  await bad({ payments: { instapay: { enabled: true, address: "a b@c", boxId: wallet } } }, "INVALID_IPA");
  await bad({ payments: { vodafoneCash: { enabled: true, number: "123", boxId: wallet } } }, "INVALID_NUMBER");
  await bad({ payments: { vodafoneCash: { enabled: true, boxId: wallet } } }, "INVALID_NUMBER");
  await CashBox.updateOne({ _id: bank }, { $set: { isActive: false } });
  await bad({ payments: { instapay: { enabled: true, address: "a@b", boxId: bank } } }, "INVALID_BOX");
  await bad({ fulfillment: { delivery: false } }, undefined); // pickup is off: nothing left
  await bad({ fulfillment: { delivery: false, pickup: false } }, "FULFILLMENT_REQUIRED");
  await bad({ payments: { cod: { enabled: false } } }, "PAYMENT_REQUIRED");
  await bad({ brandColor: "#123456" }, "INVALID_COLOR");
  await bad({ announcement: { enabled: true, text: "" } });
  await bad({ announcement: { text: "x".repeat(161) } });
  await bad({ seoDescription: "x".repeat(301) });
  await bad({ sameDayCutoff: "25:00" }); await bad({ sameDayCutoff: "9:5" });
  await bad({ highlights: [{ icon: "rocket", title: "x" }] });
  await bad({ highlights: [1, 2, 3, 4].map(() => ({ icon: "star", title: "x" })) });
  await bad({ highlights: [{ icon: "star", title: "" }] });
  await bad({ stock: { showOutOfStock: "yes" } });
  await bad({ websiteLogo: "not an image" });
  // valid ones
  ok(await putSettings({ payments: { instapay: { enabled: true, address: "shop@instapay", boxId: wallet }, vodafoneCash: { enabled: true, number: "+20 101 234 5678", boxId: bank === wallet ? bank : wallet } }, sameDayCutoff: "14:30", brandColor: WebsiteSettings.BRAND_COLORS[0], seoDescription: "x".repeat(300), announcement: { enabled: true, text: "x".repeat(160) } }));
  const saved = ok(await staff("GET", "/api/website/settings"));
  assert.equal(saved.payments.instapay.address, "shop@instapay"); assert.equal(String(saved.payments.instapay.boxId), String(wallet)); assert.equal(saved.payments.vodafoneCash.number, "01012345678");
  assert.deepEqual(saved.fulfillment, { delivery: true, pickup: false }); assert.equal(saved.productVisibility, "marked"); assert.equal(saved.stock.showRemaining.threshold, 5);
  ok(await putSettings({ sameDayCutoff: "" })); assert.equal(ok(await staff("GET", "/api/website/settings")).sameDayCutoff, "");
  // banners keep the maximum of 5 (the design recommends 3)
  assert.equal((await putSettings({ banners: Array.from({ length: 6 }, () => ({ image: PNG_URI })) })).status, 400);
  ok(await putSettings({ banners: Array.from({ length: 5 }, () => ({ image: PNG_URI })) }));
});

// ---------------------------------------------------------------------------------------------------------------------
// listing, detail, permissions

it("order list: fulfillment, payment method and transfer filters; detail shows fulfillment, payment, invoice and the WhatsApp template", async () => {
  const { product, zone } = await shop();
  const cod = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id));
  const wallet = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "instapay" }));
  const verified = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "vodafone_cash" }));
  ok(await act(verified.id, "verify-payment", {}));
  const ids = async (query) => ok(await staff("GET", `/api/orders?${query}`)).data.map((row) => row.id).sort();
  assert.deepEqual(await ids("fulfillment=pickup"), [wallet.id, verified.id].sort());
  assert.deepEqual(await ids("fulfillment=delivery"), [cod.id]);
  assert.deepEqual(await ids("paymentMethod=cod"), [cod.id]);
  assert.deepEqual(await ids("paymentMethod=instapay"), [wallet.id]);
  assert.deepEqual(await ids("needsTransfer=1"), [wallet.id]);
  assert.deepEqual(await ids("payment=verified"), [verified.id]);
  assert.deepEqual(await ids("payment=unpaid"), [wallet.id]);
  assert.equal((await staff("GET", "/api/orders?fulfillment=x")).status, 400);
  const row = ok(await staff("GET", "/api/orders?needsTransfer=1")).data[0];
  assert.equal(row.needsTransfer, true); assert.equal(row.fulfillment, "pickup"); assert.equal(row.paymentStatus, "unpaid"); assert.equal(row.zone, null);
  const detail = await getOrder(wallet.id);
  assert.equal(detail.fulfillment, "pickup"); assert.equal(detail.payment.status, "unpaid"); assert.equal(detail.invoice, null); assert.equal(detail.zone, null);
  assert.ok(detail.whatsappTemplate.includes("{الاسم}") && detail.whatsappTemplate.includes("{رقم الطلب}"));
  ok(await putSettings({ whatsappConfirmTemplate: "أهلا {الاسم} {رقم الطلب}" }));
  assert.equal((await getOrder(wallet.id)).whatsappTemplate, "أهلا {الاسم} {رقم الطلب}");
  assert.equal((await getOrder(cod.id)).deliveryTime, "خلال 24 ساعة");
  // an order placed before Stage 5A (no fulfillment / payment fields) reads as delivery, cash on delivery
  await WebOrder.collection.updateOne({ _id: new (require("mongoose").Types.ObjectId)(cod.id) }, { $unset: { fulfillment: "", paymentMethod: "" } });
  const old = await getOrder(cod.id); assert.equal(old.fulfillment, "delivery"); assert.equal(old.payment.status, null);
  assert.deepEqual(await ids("fulfillment=delivery"), [cod.id]);
});

it("permissions: verify / ready need orders.manage; picked up needs orders.dispatch + sales.create; wallet send-out needs sales.create, COD send-out credit.create", async () => {
  const { product, zone, courier } = await shop();
  const pickup = await place(pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: "instapay" }));
  const walletDelivery = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id, { paymentMethod: "instapay" }));
  const codDelivery = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id));
  const none = await makeStaff("nobody", "custom", ["dashboard.view"]);
  for (const [id, action] of [[pickup.id, "ready"], [pickup.id, "verify-payment"], [pickup.id, "pickup"], [walletDelivery.id, "dispatch"], [walletDelivery.id, "deliver"]]) {
    assert.equal((await act(id, action, {}, none)).status, 403, action);
  }
  const viewer = await makeStaff("viewer", "custom", ["orders.view"]);
  assert.equal((await act(pickup.id, "verify-payment", {}, viewer)).status, 403);
  const manager = await makeStaff("mgr", "custom", ["orders.view", "orders.manage"]);
  ok(await act(pickup.id, "confirm", {}, manager)); ok(await act(pickup.id, "prepare", {}, manager)); ok(await act(pickup.id, "ready", {}, manager)); ok(await act(pickup.id, "verify-payment", {}, manager));
  assert.equal((await act(pickup.id, "pickup", {}, manager)).status, 403, "orders.dispatch is missing");
  const noSales = await makeStaff("nosales", "custom", ["orders.view", "orders.dispatch"]);
  assert.equal((await act(pickup.id, "pickup", {}, noSales)).status, 403, "sales.create is missing");
  assert.equal(await Selling.countDocuments({}), 0);
  const cashier = await makeStaff("cash", "cashier");
  ok(await act(pickup.id, "pickup", {}, cashier));
  // wallet send-out
  ok(await act(walletDelivery.id, "confirm", {}, manager)); ok(await act(walletDelivery.id, "verify-payment", {}, manager));
  assert.equal((await act(walletDelivery.id, "dispatch", { courierId: courier.id }, noSales)).status, 403, "sales.create is missing for a wallet order");
  const creditOnly = await makeStaff("creditonly", "custom", ["orders.view", "orders.dispatch", "credit.create"]);
  assert.equal((await act(walletDelivery.id, "dispatch", { courierId: courier.id }, creditOnly)).status, 403, "credit.create does not allow a cash sale");
  const cashSales = await makeStaff("cashsales", "custom", ["orders.view", "orders.dispatch", "sales.create"]);
  ok(await act(walletDelivery.id, "dispatch", { courierId: courier.id }, cashSales));
  ok(await act(walletDelivery.id, "deliver", {}, cashSales)); // no credit.collect needed: nothing is collected
  // COD send-out still needs credit.create, not sales.create
  ok(await act(codDelivery.id, "confirm", {}, manager));
  assert.equal((await act(codDelivery.id, "dispatch", { courierId: courier.id }, cashSales)).status, 403, "sales.create does not allow a credit sale");
  ok(await act(codDelivery.id, "dispatch", { courierId: courier.id }, creditOnly));
  assert.equal((await act(codDelivery.id, "deliver", {}, cashSales)).status, 403, "credit.collect is missing for a COD order");
  // refusing a wallet order needs returns.create
  const second = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id, { paymentMethod: "vodafone_cash" }));
  ok(await act(second.id, "confirm")); ok(await act(second.id, "verify-payment", {})); ok(await act(second.id, "dispatch", { courierId: courier.id }));
  assert.equal((await act(second.id, "refuse", {}, cashSales)).status, 403, "returns.create is missing");
  const returner = await makeStaff("returner", "custom", ["orders.view", "orders.dispatch", "returns.create"]);
  ok(await act(second.id, "refuse", {}, returner));
});

it("a cash sale made for an order that cannot be invoiced (stock sold elsewhere) creates nothing and leaves the order where it was", async () => {
  const { product } = await shop({ stock: 3 });
  const placed = await place(pickupBody([{ productId: product.id, qty: 3 }]));
  ok(await act(placed.id, "confirm")); ok(await act(placed.id, "prepare")); ok(await act(placed.id, "ready"));
  const sold = await staff("POST", "/api/sellings", { customerName: "نقدي", customerPhone: "01017171718", sellingDate: new Date().toISOString().slice(0, 10), items: [{ productId: product.id, quantity: 2, price: 100 }] });
  assert.equal(sold.status, 201, sold.text);
  const before = await Selling.countDocuments({});
  const failed = await act(placed.id, "pickup");
  assert.equal(failed.status, 409);
  assert.equal(await Selling.countDocuments({}), before); assert.equal(await stockOf(product.id), 1);
  const order = await WebOrder.findById(placed.id).lean();
  assert.equal(order.status, "ready_for_pickup"); assert.equal(order.cashSaleId, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// review fixes

it("a website order never creates or renames a shop Customer: a sale for the phone of an existing customer or a courier keeps both names; the sale carries the order reference", async () => {
  const { product, zone, courier } = await shop();
  const Customer = require("../src/models/customer.model");
  const existing = await Customer.create({ name: "أحمد الأصلي", phone: "01055555555" });
  const courierCustomer = await Customer.findById(courier.customerId).lean();
  const before = await Customer.countDocuments({});
  const named = async (id) => (await Customer.findById(id).lean()).name;

  const contactOf = (phone) => ({ name: "اسم تاني خالص", phone, address: "شارع 1" });
  // pickup (cash) for the existing customer's phone
  const pickup = await place(pickupBody([{ productId: product.id, qty: 1 }], { contact: { name: "اسم تاني خالص", phone: "01055555555" } }));
  ok(await act(pickup.id, "confirm")); ok(await act(pickup.id, "prepare")); ok(await act(pickup.id, "ready")); ok(await act(pickup.id, "pickup"));
  let sale = await sellingOf(pickup.id);
  assert.equal(sale.sourceRef, `طلب موقع ${pickup.number}`); assert.equal(sale.customerPhone, undefined); assert.notEqual(sale.customerName, "اسم تاني خالص");
  assert.equal(ok(await staff("GET", `/api/sellings/${sale._id}`)).sourceRef, `طلب موقع ${pickup.number}`, "shown on the sale like the credit sale's note");
  // wallet delivery send-out for the courier's phone
  const wallet = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id, { paymentMethod: "instapay", contact: contactOf(courierCustomer.phone) }));
  ok(await act(wallet.id, "confirm")); ok(await act(wallet.id, "verify-payment", {})); ok(await act(wallet.id, "dispatch", { courierId: courier.id }));
  sale = await sellingOf(wallet.id);
  assert.equal(sale.sourceRef, `طلب موقع ${wallet.number}`);

  assert.equal(await named(existing._id), "أحمد الأصلي");
  assert.equal(await named(courier.customerId), courierCustomer.name);
  assert.equal(await Customer.countDocuments({}), before, "no customer was created");
  assert.equal(await Customer.countDocuments({ name: "اسم تاني خالص" }), 0);
  // the POS keeps its own behavior: a request body cannot ask for a walk-in sale
  const pos = await staff("POST", "/api/sellings", { customerName: "عميل جديد", customerPhone: "01066666666", sellingDate: new Date().toISOString().slice(0, 10), items: [{ productId: product.id, quantity: 1, price: 100 }], walkIn: true, sourceRef: "x" });
  assert.equal(pos.status, 201, pos.text);
  assert.equal(pos.json.customerName, "عميل جديد"); assert.equal(pos.json.sourceRef, null);
  assert.equal(await Customer.countDocuments({ phone: "01066666666" }), 1);
  // a return of the walk-in sale still works (the refund path never needed a customer)
  const refused = await place(deliveryBody([{ productId: product.id, qty: 1 }], zone.id, { paymentMethod: "vodafone_cash" }));
  ok(await act(refused.id, "confirm")); ok(await act(refused.id, "verify-payment", {})); ok(await act(refused.id, "dispatch", { courierId: courier.id }));
  ok(await act(refused.id, "refuse", { reason: "رفض" }));
});

it("a customer cannot cancel their own order once the transfer is verified (409 PAYMENT_VERIFIED); before it, they can", async () => {
  const { product } = await shop();
  const alice = ok(await store("POST", "/api/store/auth/register", { name: "علياء", phone: "01011112222", password: "customer-pass-1" }), 201);
  const mine = async (method = "wallet") => ok(await store("POST", "/api/store/orders", pickupBody([{ productId: product.id, qty: 1 }], { paymentMethod: method, contact: { name: "علياء", phone: "01011112222" } }), alice.token), 201);
  const verifiedOrder = await mine("instapay");
  ok(await act(verifiedOrder.id, "verify-payment", { reference: "R1" }));
  const refused = await store("POST", `/api/store/me/orders/${verifiedOrder.id}/cancel`, {}, alice.token);
  assert.equal(refused.status, 409); assert.equal(refused.json.code, "PAYMENT_VERIFIED"); assert.ok(refused.json.message.includes("المحل"));
  assert.equal((await WebOrder.findById(verifiedOrder.id).lean()).status, "new");
  // not verified yet: still allowed; cash orders too
  const unverified = await mine("instapay");
  assert.equal(ok(await store("POST", `/api/store/me/orders/${unverified.id}/cancel`, {}, alice.token)).status, "cancelled");
  const cash = await mine("cod");
  assert.equal(ok(await store("POST", `/api/store/me/orders/${cash.id}/cancel`, {}, alice.token)).status, "cancelled");
});

it("brand colors: the design's six presets in order; the default is the first; others are refused", async () => {
  await openSite();
  assert.deepEqual(WebsiteSettings.BRAND_COLORS, ["#0E4D45", "#7C2D12", "#3F3F46", "#14532D", "#831843", "#4C1D95"]);
  assert.equal(ok(await staff("GET", "/api/website/settings")).brandColor, "#0E4D45");
  assert.equal(ok(await store("GET", "/api/store/settings")).brandColor, "#0E4D45", "unset = the default");
  ok(await putSettings({ brandColor: "#4c1d95" }));
  assert.equal(ok(await store("GET", "/api/store/settings")).brandColor, "#4C1D95");
  assert.equal((await putSettings({ brandColor: "#1F6FEB" })).status, 400);
});
