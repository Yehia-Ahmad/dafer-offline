// Online Stage 7A tests: campaigns, attribution on website orders, visits and clicks, results (every number checked by hand AND
// against the ledger), ad spend through the expense path, leads (normalization, duplicates, computed purchases, import), marketing
// settings, permissions. Real throwaway mongod (port 27175, replica set: transactions are required).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage7a-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage7a-store-secret-0123456789abcdef-0123456789";

const assert = require("node:assert/strict");
const test = require("node:test");
const { today, atLocal } = require("./helpers/shopDay");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const Counter = require("../src/models/counter.model");
const Campaign = require("../src/models/campaign.model");
const { CampaignClick, CampaignVisit } = require("../src/models/campaignStat.model");
const Expense = require("../src/models/expense.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Lead = require("../src/models/lead.model");
const Meta = require("../src/models/meta.model");
const WebOrder = require("../src/models/webOrder.model");
const CreditSale = require("../src/models/creditSale.model");
const Selling = require("../src/models/selling.model");
const { runMigrations } = require("../src/migrations");
const { setClock } = require("../src/utils/clock");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHONE = "01012345678";
let categorySeq = 0; let phoneSeq = 0; let codeSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27175 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s7-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s7-owner", password: "owner-pass-123" } })).json.token;
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

async function seedProduct({ name = "منتج", code = "P1", stock = 50, retail = 100, cost = 50, categoryId } = {}) {
  let category = categoryId;
  if (!category) {
    const created = ok(await staff("POST", "/api/categories", { name: `فئة ${name} ${++categorySeq}`, image: PNG_URI }), 201);
    category = created._id || created.id || created.category?._id;
    ok(await staff("PUT", `/api/website/categories/${category}`, { visibility: "show", sortOrder: 1 }));
  }
  const wholesale = Math.min(60, retail);
  const created = ok(await staff("POST", "/api/products", {
    name, code, categoryId: category, inventoryCount: stock, purchasePrice: Math.min(cost, wholesale), wholesalePrice: wholesale, retailPrice: retail, image: PNG_URI,
  }), 201);
  const id = created._id || created.product?._id;
  ok(await staff("PUT", `/api/website/products/${id}`, { visibility: "show", description: "وصف", images: [PNG_URI] }));
  return { id, category };
}
const putSettings = (body) => staff("PUT", "/api/website/settings", body);
const openSite = async (extra = {}) => ok(await putSettings({ enabled: true, orderingEnabled: true, title: "متجر", ...extra }));
const seedZone = async (extra = {}) => ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "خلال 24 ساعة", ...extra }), 201);
const deliveryBody = (items, zoneId, extra = {}) => ({ items, zoneId, idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" }, ...extra });
const pickupBody = (items, extra = {}) => ({ items, fulfillment: "pickup", idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE }, ...extra });
const place = async (body) => ok(await store("POST", "/api/store/orders", body), 201);
const act = (id, action, body, token = ownerToken) => staff("POST", `/api/orders/${id}/${action}`, body ?? {}, token);
async function newCourier(name = "أحمد") {
  return ok(await staff("POST", "/api/couriers", { name, phone: `0100000${String(++phoneSeq).padStart(4, "0")}` }), 201);
}
async function newBox(name, type = "wallet") {
  const created = ok(await staff("POST", "/api/cashbox/boxes", { name, type, ...(type === "cash" ? { shiftsEnabled: false } : {}) }), 201);
  return created._id || created.box?._id || created.id;
}
const newCampaign = async (extra = {}) => ok(await staff("POST", "/api/campaigns", { name: `حملة ${++codeSeq}`, platform: "facebook", type: "paid", landing: { kind: "home" }, ...extra }), 201);
const attrib = (campaign, landedAt = new Date()) => ({ code: campaign.code, landedAt: new Date(landedAt).toISOString() });

/** The ledger's net revenue (sales, discount, returns, delivery income), the VAT payable and COGS: what the results must equal. */
async function ledger() {
  const keys = ["SALES", "SALES_DISCOUNT", "SALES_RETURNS", "SHIPPING_INCOME", "COGS", "VAT_PAYABLE"];
  const accounts = await Account.find({ systemKey: { $in: keys } }).lean();
  const byKey = Object.fromEntries(accounts.map((account) => [account.systemKey, String(account._id)]));
  const entries = await JournalEntry.find({}).lean();
  const net = (key, side) => entries.flatMap((entry) => entry.lines).filter((line) => String(line.accountId) === byKey[key])
    .reduce((sum, line) => sum + (side === "credit" ? line.credit - line.debit : line.debit - line.credit), 0);
  const revenue = net("SALES", "credit") + net("SALES_DISCOUNT", "credit") + net("SALES_RETURNS", "credit") + net("SHIPPING_INCOME", "credit");
  return { revenue: cents(revenue) / 100, shipping: cents(net("SHIPPING_INCOME", "credit")) / 100, vat: cents(byKey.VAT_PAYABLE ? net("VAT_PAYABLE", "credit") : 0) / 100, cogs: cents(net("COGS", "debit")) / 100 };
}

/** The shop: ledger, site open (pickup + wallet on), one zone (fee 30), one product (100, cost 50), a courier. */
async function shop({ vat } = {}) {
  await startLedger();
  if (vat) await enableVat(vat);
  const insta = await newBox("إنستا باي");
  await openSite({ fulfillment: { delivery: true, pickup: true }, payments: { instapay: { enabled: true, address: "shop@instapay", boxId: insta } } });
  const product = await seedProduct({ stock: 200 });
  const zone = await seedZone();
  const courier = await newCourier();
  return { product, zone, courier, insta };
}
const line = (product, qty) => [{ productId: product.id, qty }];

// ---------------------------------------------------------------------------------------------------------------------
// campaigns

it("campaign: generated URL-safe unique code, two links, landing validated, code editable only before first use", async () => {
  await openSite();
  const product = await seedProduct();
  const campaign = await newCampaign({ landing: { kind: "product", ref: product.id } });
  assert.match(campaign.code, /^[a-z0-9][a-z0-9_-]{2,31}$/);
  assert.equal(campaign.status, "active");
  assert.match(campaign.fullLink, new RegExp(`/p/${product.id}\\?utm_source=facebook&utm_medium=paid&utm_campaign=${campaign.code}$`));
  assert.match(campaign.shortLink, new RegExp(`/go/${campaign.code}$`));
  assert.equal(campaign.codeEditable, true);

  const other = await newCampaign({ code: "ramadan-1", platform: "tiktok", type: "organic", landing: { kind: "path", path: "/search?q=عروض" } });
  assert.equal(other.code, "ramadan-1");
  assert.match(other.fullLink, /\/search\?q=.*&utm_source=tiktok&utm_medium=organic&utm_campaign=ramadan-1$/);
  assert.equal((await staff("POST", "/api/campaigns", { name: "x", platform: "facebook", type: "paid", code: "ramadan-1" })).json.code, "CODE_TAKEN");
  for (const path of ["//evil.com", "https://evil.com", "/\\evil", "evil", "/x://y"]) {
    assert.equal((await staff("POST", "/api/campaigns", { name: "x", platform: "facebook", type: "paid", landing: { kind: "path", path } })).status, 400, path);
  }
  assert.equal((await staff("POST", "/api/campaigns", { name: "x", platform: "snapchat", type: "paid" })).status, 400);
  assert.equal((await staff("POST", "/api/campaigns", { name: "x", platform: "facebook", type: "paid", startDate: "2026-11-10", endDate: "2026-11-01" })).status, 400);

  const renamed = ok(await staff("PUT", `/api/campaigns/${campaign._id}`, { code: "my-code" }));
  assert.equal(renamed.code, "my-code");
  ok(await store("POST", "/api/store/visits", { code: "my-code", sessionId: "session-aaaa-1111" }));
  const locked = await staff("PUT", `/api/campaigns/${campaign._id}`, { code: "another" });
  assert.equal(locked.status, 409); assert.equal(locked.json.code, "CODE_LOCKED");
  assert.equal(ok(await staff("GET", `/api/campaigns/${campaign._id}`)).codeEditable, false);
  assert.equal(ok(await staff("PUT", `/api/campaigns/${campaign._id}`, { status: "ended", name: "اتغير" })).status, "ended");
  assert.equal(ok(await staff("GET", "/api/campaigns?platform=tiktok")).data.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// attribution on orders

it("attribution: valid code is stored from the Campaign; unknown, archived, expired and future codes make a direct order; pricing never changes", async () => {
  const { product, zone } = await shop();
  const campaign = await newCampaign();
  const day = 24 * 60 * 60 * 1000;

  const withAttribution = await place(deliveryBody(line(product, 2), zone.id, { attribution: { ...attrib(campaign, Date.now() - 2 * day), source: "evil", medium: "evil" }, heardFrom: "فيسبوك" }));
  const stored = await WebOrder.findById(withAttribution.id).lean();
  assert.equal(stored.attribution.code, campaign.code); assert.equal(String(stored.attribution.campaignId), campaign._id);
  assert.equal(stored.attribution.source, "facebook", "source/medium come from the campaign, not the browser");
  assert.equal(stored.attribution.medium, "paid");
  assert.equal(stored.heardFrom, "فيسبوك");

  const plain = await place(deliveryBody(line(product, 2), zone.id));
  assert.equal(withAttribution.total, plain.total, "attribution never changes the price");
  assert.equal((await WebOrder.findById(plain.id).lean()).attribution, undefined, "no attribution = direct");

  for (const [label, attribution] of [
    ["unknown code", { code: "nope123", landedAt: new Date().toISOString() }],
    ["expired (window 7 days)", attrib(campaign, Date.now() - 8 * day)],
    ["future", attrib(campaign, Date.now() + 2 * day)],
    ["bad date", { code: campaign.code, landedAt: "yesterday" }],
    ["not an object", "x"],
  ]) {
    const placed = await place(deliveryBody(line(product, 1), zone.id, { attribution }));
    assert.equal((await WebOrder.findById(placed.id).lean()).attribution, undefined, label);
  }
  const badHeard = await place(deliveryBody(line(product, 1), zone.id, { heardFrom: "غير موجود" }));
  assert.equal((await WebOrder.findById(badHeard.id).lean()).heardFrom, undefined, "an answer outside the options is dropped");

  ok(await staff("PUT", `/api/campaigns/${campaign._id}`, { status: "archived" }));
  const archived = await place(deliveryBody(line(product, 1), zone.id, { attribution: attrib(campaign) }));
  assert.equal((await WebOrder.findById(archived.id).lean()).attribution, undefined, "archived campaign");

  // The attribution window is a setting.
  ok(await staff("PUT", "/api/website/marketing-settings", { attributionDays: 14 }));
  ok(await staff("PUT", `/api/campaigns/${campaign._id}`, { status: "active" }));
  const wide = await place(deliveryBody(line(product, 1), zone.id, { attribution: attrib(campaign, Date.now() - 10 * day) }));
  assert.ok((await WebOrder.findById(wide.id).lean()).attribution, "10 days is inside a 14-day window");
});

it("attribution is not part of the idempotency hash: a retry with a different or expired attribution returns the same order", async () => {
  const { product, zone } = await shop();
  const campaign = await newCampaign();
  const body = deliveryBody(line(product, 1), zone.id, { attribution: attrib(campaign) });
  const first = await store("POST", "/api/store/orders", body);
  assert.equal(first.status, 201);
  const retry = await store("POST", "/api/store/orders", { ...body, attribution: { code: campaign.code, landedAt: new Date(Date.now() - 30 * 86400000).toISOString() } });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.id, first.json.id);
  assert.equal(await WebOrder.countDocuments({}), 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// visits and clicks

it("visits: once per campaign, day and session; no IP or user agent stored; an unknown code answers the same", async () => {
  await openSite();
  const campaign = await newCampaign();
  const visit = (code, sessionId) => store("POST", "/api/store/visits", { code, sessionId });
  ok(await visit(campaign.code, "session-aaaa-0001")); ok(await visit(campaign.code, "session-aaaa-0001"));
  assert.equal(await CampaignVisit.countDocuments({}), 1, "the same session twice on the same day counts once");
  ok(await visit(campaign.code, "session-aaaa-0002"));
  assert.equal(await CampaignVisit.countDocuments({}), 2);
  assert.deepEqual(ok(await visit("unknown1", "session-aaaa-0003")), { ok: true });
  ok(await visit(campaign.code, "x")); // too short: ignored
  assert.equal(await CampaignVisit.countDocuments({}), 2);
  const doc = await CampaignVisit.findOne({}).lean();
  assert.deepEqual(Object.keys(doc).sort(), ["__v", "_id", "campaignId", "day", "sessionId"].sort(), "no IP / user agent / personal field");

  // the same session on the next local day counts again
  setClock(() => new Date(Date.now() + 36 * 3600 * 1000));
  ok(await visit(campaign.code, "session-aaaa-0001"));
  assert.equal(await CampaignVisit.countDocuments({}), 3);
});

it("go: counts a click per local day and device, answers the landing path with the utm parameters; unknown or archived = home", async () => {
  await openSite();
  const campaign = await newCampaign({ platform: "instagram", type: "organic" });
  const go = (code, body) => store("POST", `/api/store/go/${code}`, body);
  const first = ok(await go(campaign.code, { device: "mobile" }));
  assert.equal(first.path, `/?utm_source=instagram&utm_medium=organic&utm_campaign=${campaign.code}`);
  ok(await go(campaign.code, { device: "mobile" })); ok(await go(campaign.code, { device: "weird" }));
  const clicks = await CampaignClick.find({}).lean();
  assert.equal(clicks.find((row) => row.device === "mobile").count, 2); assert.equal(clicks.find((row) => row.device === "other").count, 1);
  assert.deepEqual(Object.keys(clicks[0]).sort(), ["__v", "_id", "campaignId", "count", "day", "device"].sort());
  // count:false (the storefront throttle is over its limit): the landing path is still answered, nothing is counted
  const before = (await CampaignClick.find({}).lean()).reduce((sum, row) => sum + row.count, 0);
  assert.equal(ok(await go(campaign.code, { device: "mobile", count: false })).path, first.path);
  assert.equal((await CampaignClick.find({}).lean()).reduce((sum, row) => sum + row.count, 0), before);
  assert.deepEqual(ok(await go("nothere", {})), { path: "/" });
  ok(await staff("PUT", `/api/campaigns/${campaign._id}`, { status: "archived" }));
  assert.deepEqual(ok(await go(campaign.code, {})), { path: "/" });
  assert.equal((await CampaignClick.find({}).lean()).reduce((sum, row) => sum + row.count, 0), 3, "archived and unknown codes count nothing");
});

// ---------------------------------------------------------------------------------------------------------------------
// results

/**
 * Builds, through the real flows, orders of every kind (delivered, refused, partly returned, wallet, pickup, cancelled, rejected,
 * direct). Product 100 (cost 50), delivery fee 30.
 */
async function buildOrders({ product, zone, courier, insta }, campaign) {
  const attributed = { attribution: attrib(campaign), heardFrom: "فيسبوك" };
  const out = {};
  // a) delivered, cash on delivery, 2 units: 230
  out.a = await place(deliveryBody(line(product, 2), zone.id, attributed));
  ok(await act(out.a.id, "confirm")); ok(await act(out.a.id, "dispatch", { courierId: courier.id })); ok(await act(out.a.id, "deliver", {}));
  // b) refused: the invoice is fully returned
  out.b = await place(deliveryBody(line(product, 1), zone.id, attributed));
  ok(await act(out.b.id, "confirm")); ok(await act(out.b.id, "dispatch", { courierId: courier.id })); ok(await act(out.b.id, "refuse", { reason: "رفض" }));
  // c) partly returned: 4 units (430), 1 returned
  out.c = await place(deliveryBody(line(product, 4), zone.id, attributed));
  ok(await act(out.c.id, "confirm")); ok(await act(out.c.id, "dispatch", { courierId: courier.id })); ok(await act(out.c.id, "deliver", { returns: [{ productId: product.id, qty: 1 }] }));
  // d) wallet delivery: a cash sale, 130
  out.d = await place(deliveryBody(line(product, 1), zone.id, { ...attributed, paymentMethod: "instapay" }));
  ok(await act(out.d.id, "confirm")); ok(await act(out.d.id, "verify-payment", {})); ok(await act(out.d.id, "dispatch", { courierId: courier.id })); ok(await act(out.d.id, "deliver", {}));
  // e) pickup, cash: 100
  out.e = await place(pickupBody(line(product, 1), attributed));
  ok(await act(out.e.id, "confirm")); ok(await act(out.e.id, "prepare")); ok(await act(out.e.id, "ready")); ok(await act(out.e.id, "pickup"));
  // f) cancelled by the shop, h) rejected
  out.f = await place(deliveryBody(line(product, 1), zone.id, attributed));
  ok(await act(out.f.id, "confirm")); ok(await act(out.f.id, "cancel", { reason: "العميل لغى" }));
  out.h = await place(deliveryBody(line(product, 1), zone.id, attributed));
  ok(await act(out.h.id, "reject", { reason: "غير متاح" }));
  // g) direct, delivered: 130
  out.g = await place(deliveryBody(line(product, 1), zone.id));
  ok(await act(out.g.id, "confirm")); ok(await act(out.g.id, "dispatch", { courierId: courier.id })); ok(await act(out.g.id, "deliver", {}));
  return out;
}

const week = () => ({ from: today(), to: today() });
const resultsQuery = (extra = {}) => { const range = week(); return `from=${extra.from || range.from}&to=${extra.to || range.to}`; };

it("results: every number of a campaign, by hand (delivered, refused, partly returned, wallet, pickup, cancelled, rejected, direct)", async () => {
  const context = await shop();
  const campaign = await newCampaign();
  const other = await newCampaign({ platform: "tiktok", type: "organic" });
  await buildOrders(context, campaign);
  for (const session of ["session-aaaa-0001", "session-aaaa-0002", "session-aaaa-0003", "session-aaaa-0004", "session-aaaa-0005"]) ok(await store("POST", "/api/store/visits", { code: campaign.code, sessionId: session }));
  for (let index = 0; index < 3; index += 1) ok(await store("POST", `/api/store/go/${campaign.code}`, { device: "mobile" }));

  // ad spend through the expense path: 40 now, another 10 that is cancelled (cash from the pickup sale sits in the main box)
  const category = ok(await staff("GET", "/api/campaigns/ad-category"));
  const spend = async (amount) => ok(await staff("POST", "/api/expenses", { accountId: category.accountId, amount, date: today(), note: "إعلان", campaignId: campaign._id }), 201);
  await spend(40);
  const cancelled = await spend(10);
  ok(await staff("POST", `/api/expenses/${cancelled._id}/cancel`, { reason: "غلط في الرقم" }));

  const results = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`));
  const row = results.campaigns.find((item) => item.code === campaign.code);
  assert.equal(row.clicks, 3); assert.equal(row.visits, 5);
  assert.equal(row.ordersPlaced, 7, "a b c d e f h");
  assert.equal(row.ordersCompleted, 4, "a c d e");
  assert.equal(row.ordersCancelled, 1); assert.equal(row.ordersRejected, 1); assert.equal(row.ordersRefused, 1);
  assert.equal(row.sales, 790, "230 + (430-100) + 130 + 100");
  assert.equal(row.grossProfit, 350, "100 + 150 + 50 + 50: product revenue - cost of the units kept; the delivery fee is not in it");
  assert.equal(row.deliveryRevenue, 90, "30 + 30 + 30 (a, c, d); the pickup order has none; the refused order's fee came back");
  assert.equal(row.conversionRate, 0.8); assert.equal(row.averageOrderValue, 197.5);
  assert.equal(row.spend, 40, "the cancelled expense drops out");
  assert.equal(row.costPerOrder, 10); assert.equal(row.returnOnSpend, 19.75); assert.equal(row.profitAfterAds, 310, "350 - 40");

  const idle = results.campaigns.find((item) => item.code === other.code);
  assert.equal(idle.ordersPlaced, 0); assert.equal(idle.sales, 0); assert.equal(idle.conversionRate, null); assert.equal(idle.returnOnSpend, null);

  assert.equal(results.direct.ordersPlaced, 1); assert.equal(results.direct.ordersCompleted, 1); assert.equal(results.direct.sales, 130); assert.equal(results.direct.grossProfit, 50); assert.equal(results.direct.deliveryRevenue, 30);
  assert.equal(results.direct.visits, null);
  const facebook = results.platforms.find((item) => item.platform === "facebook");
  assert.equal(facebook.sales, 790); assert.equal(facebook.spend, 40); assert.equal(facebook.grossProfit, 350); assert.equal(facebook.deliveryRevenue, 90);
  const heard = results.heardFrom.find((item) => item.answer === "فيسبوك");
  assert.equal(heard.ordersPlaced, 7); assert.equal(heard.sales, 790);
  assert.equal(results.heardFrom.find((item) => item.answer === "").ordersPlaced, 1, "no answer");
  assert.equal(results.totals.sales, 920); assert.equal(results.totals.ordersPlaced, 8); assert.equal(results.totals.grossProfit, 400); assert.equal(results.totals.deliveryRevenue, 120);
  assert.deepEqual(results.daily, [{ day: today(), visits: 5, orders: 8, sales: 920 }]);

  const single = ok(await staff("GET", `/api/campaigns/${campaign._id}/results?${resultsQuery()}`));
  assert.equal(single.campaign.sales, 790); assert.equal(single.daily[0].orders, 7);
  const list = ok(await staff("GET", `/api/campaigns?${resultsQuery()}`));
  assert.equal(list.data.find((item) => item._id === campaign._id).kpis.sales, 790);
  const spendRows = ok(await staff("GET", `/api/campaigns/${campaign._id}/spend?${resultsQuery()}`));
  assert.equal(spendRows.total, 40); assert.deepEqual(spendRows.data.map((item) => item.status).sort(), ["cancelled", "posted"]);

  // the expense list shows the campaign
  const expenses = ok(await staff("GET", "/api/expenses"));
  assert.ok(expenses.data.every((item) => item.campaignName === campaign.name));
  assert.equal(ok(await staff("GET", `/api/expenses?campaign=${other._id}`)).data.length, 0);
});

for (const mode of ["none", "inclusive", "exclusive"]) {
  it(`results match the ledger to the piastre: sales = revenue + VAT, profit = revenue - COGS (VAT ${mode})`, async () => {
    const context = await shop(mode === "none" ? {} : { vat: { includes: mode === "inclusive" } });
    const campaign = await newCampaign();
    await buildOrders(context, campaign);
    const books = await ledger();
    const results = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`));
    assert.equal(cents(results.totals.sales), cents(books.revenue + books.vat), "sales = invoice totals minus returns = revenue + VAT in the ledger");
    assert.equal(cents(results.totals.deliveryRevenue), cents(books.shipping), "delivery revenue = SHIPPING_INCOME in the ledger");
    assert.equal(cents(results.totals.grossProfit), cents(books.revenue - books.shipping - books.cogs), "profit = product revenue - COGS in the ledger (no delivery fee)");
    if (mode === "none") { assert.equal(results.totals.sales, 920); assert.equal(books.cogs, 400); assert.equal(books.shipping, 120); }
  });
}

it("an invoice the staff cancelled (cash sale of a pickup order) no longer counts as completed", async () => {
  const context = await shop();
  const campaign = await newCampaign();
  const keep = await place(pickupBody(line(context.product, 1), { attribution: attrib(campaign) }));
  const drop = await place(pickupBody(line(context.product, 1), { attribution: attrib(campaign) }));
  for (const order of [keep, drop]) { ok(await act(order.id, "confirm")); ok(await act(order.id, "prepare")); ok(await act(order.id, "ready")); ok(await act(order.id, "pickup")); }
  const before = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`)).campaigns[0];
  assert.equal(before.ordersCompleted, 2); assert.equal(before.sales, 200);
  const sale = await Selling.findById((await WebOrder.findById(drop.id).lean()).cashSaleId).lean();
  ok(await staff("POST", `/api/sellings/${sale._id}/cancel`, { reason: "غلط في الفاتورة" }));
  const after = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`)).campaigns[0];
  assert.equal(after.ordersPlaced, 2); assert.equal(after.ordersCompleted, 1); assert.equal(after.sales, 100); assert.equal(after.grossProfit, 50);
});

it("local day: an order at 00:30 shop time belongs to that day, a visit at 00:30 too (never the UTC day)", async () => {
  const context = await shop();
  const campaign = await newCampaign();
  const placed = await place(pickupBody(line(context.product, 1), { attribution: attrib(campaign) }));
  const night = atLocal(2026, 11, 16, 0, 30);
  await WebOrder.collection.updateOne({ _id: new (require("mongoose").Types.ObjectId)(placed.id) }, { $set: { createdAt: night } });
  setClock(() => night);
  ok(await store("POST", "/api/store/visits", { code: campaign.code, sessionId: "session-night-001" }));
  ok(await store("POST", `/api/store/go/${campaign.code}`, { device: "mobile" }));
  assert.equal((await CampaignVisit.findOne({}).lean()).day, "2026-11-16");
  assert.equal((await CampaignClick.findOne({}).lean()).day, "2026-11-16");

  const on = ok(await staff("GET", "/api/campaigns/results?from=2026-11-16&to=2026-11-16")).campaigns[0];
  assert.equal(on.ordersPlaced, 1); assert.equal(on.visits, 1); assert.equal(on.clicks, 1);
  const before = ok(await staff("GET", "/api/campaigns/results?from=2026-11-15&to=2026-11-15")).campaigns[0];
  assert.equal(before.ordersPlaced, 0); assert.equal(before.visits, 0);
  const after = ok(await staff("GET", "/api/campaigns/results?from=2026-11-17&to=2026-11-17")).campaigns[0];
  assert.equal(after.ordersPlaced, 0);
  assert.equal((await staff("GET", "/api/campaigns/results?from=2026-11-17&to=2026-11-16")).status, 400);
  assert.equal(ok(await staff("GET", "/api/campaigns/results?from=2026-11-15&to=2026-11-17")).daily.length, 1);
});

it("profit numbers need the cost/profit permission (they are not even in the response without it)", async () => {
  const context = await shop();
  const campaign = await newCampaign();
  await buildOrders(context, campaign);
  const viewer = await makeStaff("viewer", "custom", ["marketing.view"]);
  const full = await makeStaff("fullviewer", "custom", ["marketing.view", "products.viewCost"]);
  const hidden = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`, undefined, viewer));
  assert.equal(JSON.stringify(hidden).includes("grossProfit"), false); assert.equal(JSON.stringify(hidden).includes("profitAfterAds"), false);
  assert.equal(hidden.totals.sales, 920, "sales are still shown");
  const shown = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`, undefined, full));
  assert.equal(shown.totals.grossProfit, 400);
  assert.equal(hidden.totals.deliveryRevenue, 120, "delivery revenue is revenue, not profit: shown without the profit permission");
  assert.equal(JSON.stringify(ok(await staff("GET", `/api/campaigns?${resultsQuery()}`, undefined, viewer))).includes("grossProfit"), false);
  assert.doesNotMatch(JSON.stringify(ok(await staff("GET", `/api/campaigns/${campaign._id}/results?${resultsQuery()}`, undefined, viewer))), /grossProfit|profitAfterAds/);
});

// ---------------------------------------------------------------------------------------------------------------------
// ad spend

it("ad spend: «دعاية وإعلان» is created once as a normal category under operating expenses; the expense posts like any expense", async () => {
  await startLedger();
  const campaign = await newCampaign();
  const cashier = await makeStaff("spender", "custom", ["expenses.create", "marketing.view"]);
  const category = ok(await staff("GET", "/api/campaigns/ad-category", undefined, cashier));
  assert.equal(category.nameAr, "دعاية وإعلان");
  assert.equal(ok(await staff("GET", "/api/campaigns/ad-category")).accountId, category.accountId, "found, not created twice");
  const listed = ok(await staff("GET", "/api/expenses/categories")).data.filter((item) => item.nameAr === "دعاية وإعلان");
  assert.equal(listed.length, 1);
  const account = await Account.findById(category.accountId).lean();
  assert.equal(account.type, "expense"); assert.equal(account.isGroup, false); assert.equal(account.isSystem, false);
  assert.equal((await Account.findById(account.parentId).lean()).code, "520");

  // funds for the box: an owner deposit through the normal cash-in path is not needed, the opening balance covers a small spend
  const main = ok(await staff("GET", "/api/cashbox/boxes")).data.find((box) => box.isMain);
  assert.ok(main);
  const bad = await staff("POST", "/api/expenses", { accountId: category.accountId, amount: 1, date: today(), campaignId: "nope" }, cashier);
  assert.equal(bad.status, 400); assert.equal(bad.json.code, "INVALID_CAMPAIGN");
  const unknown = await staff("POST", "/api/expenses", { accountId: category.accountId, amount: 1, date: today(), campaignId: "0123456789abcdef01234567" }, cashier);
  assert.equal(unknown.json.code, "INVALID_CAMPAIGN");
  assert.equal(await Expense.countDocuments({}), 0);
  // someone with only marketing.view cannot reach the category
  const viewer = await makeStaff("onlyview", "custom", ["marketing.view"]);
  assert.equal((await staff("GET", "/api/campaigns/ad-category", undefined, viewer)).status, 403);
  assert.ok(campaign);
});

// ---------------------------------------------------------------------------------------------------------------------
// leads

it("leads: phones normalized, duplicates refused with the existing lead, profile links restricted, phone optional with a link", async () => {
  const create = (body) => staff("POST", "/api/leads", body);
  const a = ok(await create({ name: "منى", phone: "+20 100 123 4567", source: "facebook" }), 201);
  assert.equal(a.phone, "01001234567");
  const dup = await create({ name: "منى 2", phone: "٠١٠٠١٢٣٤٥٦٧", source: "instagram" });
  assert.equal(dup.status, 409); assert.equal(dup.json.code, "DUPLICATE_PHONE"); assert.equal(dup.json.existingLeadId, a._id);
  assert.equal((await create({ name: "x", phone: "123", source: "facebook" })).json.code, "INVALID_PHONE");
  assert.equal((await create({ name: "x", source: "facebook" })).json.code, "CONTACT_REQUIRED");
  assert.equal((await create({ name: "x", profileLink: "https://evil.com/me", source: "facebook" })).json.code, "INVALID_PROFILE_LINK");
  assert.equal((await create({ name: "x", profileLink: "https://facebook.com.evil.com/me", source: "facebook" })).json.code, "INVALID_PROFILE_LINK");
  for (const link of ["https://www.facebook.com/mona", "https://instagram.com/mona", "https://www.tiktok.com/@mona", "https://wa.me/201001234567", "https://m.me/mona"]) {
    ok(await create({ name: "بلا رقم", profileLink: link, source: "facebook" }), 201);
  }
  assert.equal((await create({ name: "x", phone: "01001234567", source: "other" })).status, 409);
  assert.equal((await create({ name: "x", phone: "01111111111", source: "nowhere" })).json.code, "INVALID_SOURCE");

  const edit = ok(await staff("PUT", `/api/leads/${a._id}`, { status: "contacted", lastContactDate: "2026-11-10", notes: "اتصلت" }));
  assert.equal(edit.status, "contacted");
  const other = ok(await create({ name: "أحمد", phone: "01222222222", source: "tiktok" }), 201);
  assert.equal((await staff("PUT", `/api/leads/${other._id}`, { phone: "01001234567" })).json.code, "DUPLICATE_PHONE");
  ok(await staff("POST", `/api/leads/${a._id}/notes`, { text: "رد على الواتساب" }), 201);
  const page = ok(await staff("GET", `/api/leads/${a._id}`));
  assert.equal(page.noteLog.length, 1); assert.equal(page.whatsappLink, "https://wa.me/201001234567"); assert.equal(page.callLink, "tel:01001234567");

  const search = async (query) => ok(await staff("GET", `/api/leads?${query}`)).data.map((row) => row.name);
  assert.deepEqual(await search("search=%D9%85%D9%86%D9%89"), ["منى"]);
  assert.deepEqual(await search("search=01222222222"), ["أحمد"]);
  assert.deepEqual(await search("status=contacted"), ["منى"]);
  assert.deepEqual(await search("source=tiktok"), ["أحمد"]);
});

it("leads: «اشترى» is computed from the lead's creation on: website order, cash sale and credit customer; earlier or cancelled documents do not count", async () => {
  const context = await shop();
  const lead = ok(await staff("POST", "/api/leads", { name: "منى", phone: "01012345678", source: "facebook" }), 201);
  const none = ok(await staff("GET", `/api/leads/${lead._id}`));
  assert.equal(none.purchases.bought, false); assert.equal(none.purchases.count, 0);

  // an older sale with the same phone (dated before the lead) does not count
  ok(await staff("POST", "/api/sellings", { customerName: "قديم", customerPhone: "01012345678", sellingDate: "2020-01-01", items: [{ productId: context.product.id, quantity: 1, price: 100 }] }), 201);
  // a website order after the lead, a cash sale in a different spelling, and a cancelled sale
  const order = await place(pickupBody(line(context.product, 2)));
  const cash = ok(await staff("POST", "/api/sellings", { customerName: "منى", customerPhone: "+201012345678", sellingDate: today(), items: [{ productId: context.product.id, quantity: 1, price: 100 }] }), 201);
  const cancelled = ok(await staff("POST", "/api/sellings", { customerName: "منى", customerPhone: "01012345678", sellingDate: today(), items: [{ productId: context.product.id, quantity: 1, price: 100 }] }), 201);
  ok(await staff("POST", `/api/sellings/${cancelled._id}/cancel`, { reason: "غلط في الفاتورة" }));
  const rejected = await place(pickupBody(line(context.product, 1)));
  ok(await act(rejected.id, "reject", { reason: "غير متاح" }));

  const bought = ok(await staff("GET", `/api/leads/${lead._id}`)).purchases;
  assert.equal(bought.bought, true);
  assert.equal(bought.count, 2, "the website order and the cash sale");
  assert.deepEqual(bought.documents.map((doc) => doc.type).sort(), ["cash_sale", "web_order"]);
  assert.equal(bought.total, 200 + 100);
  assert.ok(bought.documents.find((doc) => doc.type === "web_order" && doc.number === order.number));
  assert.ok(cash);
});

it("leads import: header mapping, preview, skip or update existing phones, a Nota campaign, invalid rows, the 5,000 row limit", async () => {
  const campaign = await newCampaign();
  const headers = ["created_time", "ad_name", "campaign_name", "platform", "full_name", "phone_number"];
  const mapping = ok(await staff("POST", "/api/leads/import/mapping", { headers })).mapping;
  assert.deepEqual(mapping, { name: "full_name", phone: "phone_number", createdTime: "created_time", campaignName: "campaign_name", adName: "ad_name", platform: "platform", profileLink: null });
  ok(await staff("POST", "/api/leads", { name: "قديم", phone: "01000000001", source: "walk_in" }), 201);
  const rows = [
    { created_time: "2026-11-01T10:00:00+02:00", ad_name: "إعلان 1", campaign_name: "رمضان", platform: "fb", full_name: "سلمى", phone_number: "p:+201000000002" },
    { created_time: "2026-11-01T11:00:00+02:00", ad_name: "إعلان 1", campaign_name: "رمضان", platform: "ig", full_name: "ليلى", phone_number: "p:+201000000003" },
    { full_name: "قديم محدّث", phone_number: "01000000001" },
    { full_name: "تكرار", phone_number: "p:+201000000002" },
    { full_name: "رقم غلط", phone_number: "123" },
    { full_name: "", phone_number: "01000000009" },
  ];
  const preview = ok(await staff("POST", "/api/leads/import/preview", { rows, mapping, mode: "skip", source: "facebook" }));
  assert.deepEqual(preview.summary, { total: 6, imported: 2, updated: 0, skipped: 2, invalid: 2 });
  assert.equal(await Lead.countDocuments({}), 1, "preview writes nothing");
  const skipped = ok(await staff("POST", "/api/leads/import", { rows, mapping, mode: "skip", source: "facebook", campaignId: campaign._id }));
  assert.deepEqual({ imported: skipped.imported, updated: skipped.updated, skipped: skipped.skipped, invalid: skipped.invalid }, { imported: 2, updated: 0, skipped: 2, invalid: 2 });
  assert.equal(skipped.invalidRows.length, 2);
  const saved = await Lead.find({}).sort({ phone: 1 }).lean();
  assert.equal(saved.length, 3);
  const salma = saved.find((lead) => lead.phone === "01000000002");
  assert.equal(salma.source, "facebook"); assert.equal(String(salma.campaignId), campaign._id);
  assert.equal(saved.find((lead) => lead.phone === "01000000003").source, "instagram");
  assert.equal(saved.find((lead) => lead.phone === "01000000001").name, "قديم", "skip leaves the existing lead alone");
  assert.equal(new Date(salma.createdAt).toISOString(), "2026-11-01T08:00:00.000Z", "created_time becomes the lead's creation time");

  const updated = ok(await staff("POST", "/api/leads/import", { rows: [rows[2]], mapping, mode: "update", source: "facebook", campaignId: campaign._id }));
  assert.equal(updated.updated, 1);
  const now = await Lead.findOne({ phone: "01000000001" }).lean();
  assert.equal(now.name, "قديم محدّث"); assert.equal(String(now.campaignId), campaign._id);

  assert.equal((await staff("POST", "/api/leads/import", { rows: [], mapping, mode: "skip" })).json.code, "NO_ROWS");
  assert.equal((await staff("POST", "/api/leads/import", { rows: [rows[0]], mapping: { name: "full_name" }, mode: "skip" })).json.code, "MAPPING_REQUIRED");
  const many = Array.from({ length: 5001 }, (_, index) => ({ full_name: `n${index}`, phone_number: `010${String(index).padStart(8, "0")}` }));
  assert.equal((await staff("POST", "/api/leads/import/preview", { rows: many, mapping, mode: "skip" })).json.code, "TOO_MANY_ROWS");
  const limit = ok(await staff("POST", "/api/leads/import/preview", { rows: many.slice(0, 5000), mapping, mode: "skip" }));
  assert.equal(limit.summary.total, 5000); assert.equal(limit.rows.length, 200, "the preview lists the first 200 rows");
});

// ---------------------------------------------------------------------------------------------------------------------
// settings, public settings, permissions

it("marketing settings: pixel ids validated, defaults, public settings carry only what the page needs", async () => {
  await openSite();
  const defaults = ok(await staff("GET", "/api/website/marketing-settings"));
  assert.equal(defaults.requireConsent, true); assert.equal(defaults.attributionDays, 7); assert.equal(defaults.askHeardFrom, true);
  assert.equal(defaults.metaPixelId, ""); assert.ok(defaults.heardFromOptions.length >= 5);
  assert.match(defaults.feeds.meta, /\/feeds\/catalog\.csv$/); assert.match(defaults.feeds.tiktok, /\/feeds\/tiktok\.csv$/);
  for (const body of [{ metaPixelId: "123" }, { metaPixelId: "12345678901234x" }, { tiktokPixelId: "bad id!" }, { attributionDays: 0 }, { attributionDays: 91 }, { requireConsent: "yes" }, { heardFromOptions: "x" }]) {
    assert.equal((await staff("PUT", "/api/website/marketing-settings", body)).status, 400, JSON.stringify(body));
  }
  ok(await staff("PUT", "/api/website/marketing-settings", { metaPixelId: "123456789012345", tiktokPixelId: "CABCDEF123456", requireConsent: false, attributionDays: 30, heardFromOptions: ["فيسبوك", " ", "صديق", "صديق"] }));
  const publicMarketing = ok(await store("GET", "/api/store/settings")).marketing;
  assert.deepEqual(publicMarketing, { metaPixelId: "123456789012345", tiktokPixelId: "CABCDEF123456", requireConsent: false, attributionDays: 30, heardFromOptions: ["فيسبوك", "صديق"] });
  ok(await staff("PUT", "/api/website/marketing-settings", { askHeardFrom: false, metaPixelId: "" }));
  const off = ok(await store("GET", "/api/store/settings")).marketing;
  assert.deepEqual(off.heardFromOptions, []); assert.equal(off.metaPixelId, "");
  // the closed site shares nothing
  await putSettings({ enabled: false });
  assert.equal(ok(await store("GET", "/api/store/settings")).marketing, undefined);
});

it("permissions: cashier only manages leads; marketing.view reads but cannot write; settings need marketing.manage", async () => {
  await openSite();
  const campaign = await newCampaign();
  const cashier = await makeStaff("cash1", "cashier");
  assert.equal((await staff("GET", "/api/campaigns", undefined, cashier)).status, 403);
  assert.equal((await staff("GET", "/api/campaigns/results", undefined, cashier)).status, 403);
  assert.equal((await staff("GET", "/api/website/marketing-settings", undefined, cashier)).status, 403);
  assert.equal(ok(await staff("POST", "/api/leads", { name: "منى", phone: "01099999999", source: "walk_in" }, cashier), 201).name, "منى");
  assert.equal((await staff("GET", "/api/leads", undefined, cashier)).status, 200);
  const manager = await makeStaff("mgr1", "manager");
  assert.equal(ok(await staff("GET", "/api/campaigns", undefined, manager)).data.length, 1);
  assert.equal((await staff("POST", "/api/campaigns", { name: "م", platform: "other", type: "organic" }, manager)).status, 201);
  const viewer = await makeStaff("view1", "custom", ["marketing.view"]);
  assert.equal((await staff("GET", `/api/campaigns/${campaign._id}`, undefined, viewer)).status, 200);
  assert.equal((await staff("POST", "/api/campaigns", { name: "م", platform: "other", type: "organic" }, viewer)).status, 403);
  assert.equal((await staff("PUT", `/api/campaigns/${campaign._id}`, { name: "x" }, viewer)).status, 403);
  assert.equal((await staff("PUT", "/api/website/marketing-settings", { requireConsent: false }, viewer)).status, 403);
  assert.equal((await staff("POST", "/api/leads", { name: "x", phone: "01011111111", source: "other" }, viewer)).status, 403);
  assert.equal((await staff("GET", "/api/leads", undefined, viewer)).status, 200);
  // the public endpoints need no sign-in at all
  assert.equal((await store("POST", "/api/store/visits", { code: campaign.code, sessionId: "session-public-1" })).status, 200);
});

it("nothing a result reads is changed by reading it: the same results twice, and no invoice or order is touched", async () => {
  const context = await shop();
  const campaign = await newCampaign();
  await buildOrders(context, campaign);
  const snapshot = async () => JSON.stringify([await WebOrder.find({}).sort({ number: 1 }).lean(), await CreditSale.find({}).sort({ number: 1 }).lean(), await Selling.find({}).sort({ number: 1 }).lean(), await JournalEntry.countDocuments({})]);
  const before = await snapshot();
  const one = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`));
  const two = ok(await staff("GET", `/api/campaigns/results?${resultsQuery()}`));
  assert.deepEqual(one, two);
  assert.equal(await snapshot(), before);
  assert.ok(await Campaign.countDocuments({}));
});
