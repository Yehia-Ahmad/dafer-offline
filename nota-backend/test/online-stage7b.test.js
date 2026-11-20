// Online Stage 7B tests: the read-only Meta (Facebook/Instagram) ad account connection. Meta is mocked at the HTTP transport (no network):
// secret encryption and that no secret ever leaves, connect/test/disconnect, the owner-only permission, backfill and the 7-day re-sync,
// paging, every error case, the lock, the exchange-rate history, linking rules, results with Meta spend (no double counting) and money
// parsing. Real throwaway mongod (port 27177, replica set).
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage7b-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage7b-store-secret-0123456789abcdef-0123456789";
process.env.NOTA_SECRETS_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { today } = require("./helpers/shopDay");

const app = require("../src/app");
const Account = require("../src/models/account.model");
const Counter = require("../src/models/counter.model");
const AuditLog = require("../src/models/auditLog.model");
const Expense = require("../src/models/expense.model");
const JournalEntry = require("../src/models/journalEntry.model");
const Meta = require("../src/models/meta.model");
const MetaConnection = require("../src/models/metaConnection.model");
const MetaCampaign = require("../src/models/metaCampaign.model");
const MetaInsightDay = require("../src/models/metaInsightDay.model");
const secretBox = require("../src/utils/secretBox");
const metaMoney = require("../src/services/meta/metaMoney");
const metaClient = require("../src/services/meta/metaClient");
const metaSync = require("../src/services/meta/metaSync.service");
const { foldDays } = require("../src/services/meta/metaResults.service");
const { runMigrations } = require("../src/migrations");
const { setClock } = require("../src/utils/clock");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { forgetBoxes } = require("./helpers/oldData");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PHONE = "01012345678";
const TOKEN = "EAAB-SECRET-token-0123456789abcdefghijklmnop";
const APP_SECRET = "APP-SECRET-should-never-leak-9876543210";
const ACCOUNT = "act_1234567890";
let categorySeq = 0; let codeSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27177 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { setClock(null); metaClient.setTransport(null); metaSync.setSleep(null); if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });

// Everything printed during a test, to prove no secret reaches the logs.
const logged = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };
const capture = (...args) => { logged.push(args.map(String).join(" ")); };

let world;
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  setClock(null);
  logged.length = 0;
  console.log = capture; console.error = capture; console.warn = capture;
  metaSync.setSleep(async () => {});
  world = freshWorld();
  metaClient.setTransport(fakeMeta);
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s7b-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s7b-owner", password: "owner-pass-123" } })).json.token;
});
test.afterEach(() => { console.log = realConsole.log; console.error = realConsole.error; console.warn = realConsole.warn; });
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
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };
const uuid = () => crypto.randomUUID();
const day = (offset = 0) => metaSync.addDays(today(), offset);

// ---------------------------------------------------------------------------------------------------------------------
// the fake Meta (Graph API at the transport)

function freshWorld() {
  return {
    calls: [],
    account: { id: ACCOUNT, name: "حساب المتجر", currency: "EGP", timezone_name: "Africa/Cairo", account_status: 1, disable_reason: 0 },
    scopes: ["ads_read", "public_profile"],
    campaigns: [],
    insights: [], // { campaign_id, campaign_name, date_start, spend, impressions, reach, clicks, inline_link_clicks }
    failures: [], // { match, status, body, headers, times }
    pageSize: 500,
    token: TOKEN,
    debugTokenFails: false,
    stall: null,
  };
}

const fail = (match, body, { status = 400, headers = {}, times = 1 } = {}) => world.failures.push({ match, status, body, headers, times });
const metaError = (code, message = "Meta says: token EAAB-SECRET-token-0123456789abcdefghijklmnop is bad", subcode) => ({ error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: "x" } });

async function fakeMeta(url, { method, headers }) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/v\d+\.\d+\//, "");
  world.calls.push({ method, url, path, headers: { ...headers }, params: Object.fromEntries(parsed.searchParams) });
  if (world.stall) await world.stall();
  if (method !== "GET") return { status: 405, headers: {}, body: metaError(1) };
  const failure = world.failures.find((item) => path.includes(item.match) && item.times > 0);
  if (failure) { failure.times -= 1; return { status: failure.status, headers: failure.headers, body: failure.body }; }
  if (headers.Authorization !== `Bearer ${world.token}`) return { status: 400, headers: {}, body: metaError(190) };
  const params = Object.fromEntries(parsed.searchParams);
  const page = (rows) => {
    const start = Number(params.after || 0);
    const size = Math.min(Number(params.limit) || 25, world.pageSize);
    const slice = rows.slice(start, start + size);
    const more = start + size < rows.length;
    return { status: 200, headers: {}, body: { data: slice, paging: { cursors: { before: "0", after: String(start + size) }, ...(more ? { next: `https://graph.facebook.com/leak?access_token=${world.token}` } : {}) } } };
  };
  if (path === ACCOUNT) return { status: 200, headers: {}, body: world.account };
  if (path === "debug_token") {
    if (world.debugTokenFails) return { status: 400, headers: {}, body: metaError(100) };
    return { status: 200, headers: {}, body: { data: { is_valid: true, scopes: world.scopes, expires_at: 0, app_id: "1" } } };
  }
  if (path === "me/permissions") return { status: 200, headers: {}, body: { data: world.scopes.map((permission) => ({ permission, status: "granted" })) } };
  if (path === `${ACCOUNT}/campaigns`) return page(world.campaigns);
  if (path === `${ACCOUNT}/insights`) {
    const range = JSON.parse(params.time_range);
    return page(world.insights.filter((row) => row.date_start >= range.since && row.date_start <= range.until).map((row) => ({ date_stop: row.date_start, ...row })));
  }
  return { status: 404, headers: {}, body: metaError(803) };
}

const metaCampaign = (id, name, extra = {}) => ({ id: String(id), name, status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_SALES", created_time: "2026-10-01T10:00:00+0300", ...extra });
const insight = (campaignId, dayString, spend, extra = {}) => ({ campaign_id: String(campaignId), campaign_name: `c${campaignId}`, date_start: dayString, spend, impressions: "1000", reach: "800", clicks: "50", inline_link_clicks: "40", ...extra });

const connectBody = (extra = {}) => ({ adAccountId: ACCOUNT, token: TOKEN, ...extra });
async function connect(extra) {
  const view = ok(await staff("PUT", "/api/website/meta-connection", connectBody(extra)));
  await metaSync.idle();
  return view;
}
const connection = () => MetaConnection.findById("default").lean();

// ---------------------------------------------------------------------------------------------------------------------
// encryption, money

it("secretBox: AES-256-GCM round trip, random IV, tamper and wrong context are refused, the key is read lazily", () => {
  const a = secretBox.seal(TOKEN, "meta-token");
  const b = secretBox.seal(TOKEN, "meta-token");
  assert.notEqual(a, b, "random IV");
  assert.ok(!a.includes(TOKEN));
  assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(secretBox.open(a, "meta-token"), TOKEN);
  assert.throws(() => secretBox.open(a, "other-context"));
  const parts = a.split(".");
  parts[3] = Buffer.from("x".repeat(Buffer.from(parts[3], "base64url").length)).toString("base64url");
  assert.throws(() => secretBox.open(parts.join("."), "meta-token"));
  assert.equal(secretBox.last4(TOKEN), TOKEN.slice(-4));
  const key = process.env.NOTA_SECRETS_KEY;
  process.env.NOTA_SECRETS_KEY = "short";
  try { assert.throws(() => secretBox.seal("x"), (error) => error.code === "SECRETS_KEY_MISSING"); } finally { process.env.NOTA_SECRETS_KEY = key; }
  const other = "ff".repeat(32);
  process.env.NOTA_SECRETS_KEY = other;
  try { assert.throws(() => secretBox.open(a, "meta-token"), "another key cannot read it"); } finally { process.env.NOTA_SECRETS_KEY = key; }
});

it("money from Meta is parsed from the string into integer minor units with no float drift", () => {
  const { parseMinor, parseCount, convertMinor, toMoney, rateOn } = metaMoney;
  assert.equal(parseMinor("0.1") + parseMinor("0.2"), 30, "0.1 + 0.2 is exactly 30 piastres");
  assert.equal(parseMinor("1234.565"), 123457, "half up on the string, not on a float (1234.565 * 100 is 123456.49999 in floats)");
  assert.equal(parseMinor("19.999"), 2000);
  assert.equal(parseMinor("5339.5"), 533950);
  assert.equal(parseMinor("0"), 0);
  assert.equal(parseMinor("12"), 1200);
  for (const bad of ["-1", "1e3", "abc", "", null, undefined, "1,5", "٣"]) assert.equal(parseMinor(bad), null, String(bad));
  assert.equal(parseCount("361324"), 361324); assert.equal(parseCount(undefined), 0); assert.equal(parseCount("x"), 0);
  assert.equal(convertMinor(10000, 48.55), 485500, "100.00 USD at 48.55");
  assert.equal(convertMinor(1, 48.55), 49, "1 cent rounds to 49 piastres");
  assert.equal(toMoney(485500), 4855);
  let sum = 0; for (let i = 0; i < 1000; i += 1) sum += parseMinor("0.10");
  assert.equal(toMoney(sum), 100, "a thousand 0.10 add to exactly 100");
  const rates = [{ rate: 48, effectiveFrom: "2026-11-01" }, { rate: 50, effectiveFrom: "2026-11-10" }];
  assert.equal(rateOn(rates, "2026-10-31"), null);
  assert.equal(rateOn(rates, "2026-11-09").rate, 48);
  assert.equal(rateOn(rates, "2026-11-10").rate, 50);
  const folded = foldDays([{ day: "2026-11-09", spendMinor: 1000, impressions: 1, reach: 1, clicks: 1, linkClicks: 1 }, { day: "2026-11-10", spendMinor: 1000, impressions: 1, reach: 1, clicks: 1, linkClicks: 1 }, { day: "2026-10-01", spendMinor: 500, impressions: 0, reach: 0, clicks: 0, linkClicks: 0 }], rates, false);
  assert.equal(folded.egpMinor, 48000 + 50000, "each day converted with the rate of that day");
  assert.equal(folded.missingRateMinor, 500, "the day before any rate is not converted");
  assert.equal(folded.originalMinor, 2500);
});

// ---------------------------------------------------------------------------------------------------------------------
// permission

it("the connection is owner only: managers and cashiers are refused, even to read it; rates can be read with marketing.view", async () => {
  const manager = await makeStaff("mgr", "manager");
  const cashier = await makeStaff("cash", "cashier");
  for (const [method, path, body] of [["GET", "/api/website/meta-connection"], ["POST", "/api/website/meta-connection/test", connectBody()], ["PUT", "/api/website/meta-connection", connectBody()], ["DELETE", "/api/website/meta-connection"], ["POST", "/api/website/meta-connection/sync", {}], ["POST", "/api/website/exchange-rates", { rate: 50, effectiveFrom: today() }]]) {
    assert.equal((await staff(method, path, body, manager)).status, 403, `manager ${method} ${path}`);
    assert.equal((await staff(method, path, body, cashier)).status, 403, `cashier ${method} ${path}`);
  }
  assert.equal(world.calls.length, 0, "a refused request never reaches Meta");
  assert.equal((await staff("GET", "/api/website/meta-connection")).status, 200);
  assert.equal((await staff("GET", "/api/website/exchange-rates", undefined, manager)).status, 200);
});

async function makeStaff(username, role, permissions) {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
}

// ---------------------------------------------------------------------------------------------------------------------
// connect / test / disconnect

it("test shows the account and the token's permissions and saves nothing; saving needs a successful test", async () => {
  const result = ok(await staff("POST", "/api/website/meta-connection/test", connectBody()));
  assert.equal(result.ok, true); assert.equal(result.account.name, "حساب المتجر"); assert.equal(result.account.currency, "EGP");
  assert.equal(result.account.timezoneName, "Africa/Cairo"); assert.equal(result.account.accountStatus, 1);
  assert.deepEqual(result.scopes, ["ads_read", "public_profile"]); assert.equal(result.hasAdsRead, true);
  assert.equal(await MetaConnection.countDocuments({}), 0, "testing saves nothing");
  assert.ok(world.calls.some((c) => c.path === ACCOUNT && c.params.fields === "name,currency,timezone_name,account_status,disable_reason"));

  // a token without ads_read cannot be saved
  world.scopes = ["public_profile"];
  assert.equal(ok(await staff("POST", "/api/website/meta-connection/test", connectBody())).ok, false);
  const refused = await staff("PUT", "/api/website/meta-connection", connectBody());
  assert.equal(refused.status, 400); assert.equal(refused.json.code, "PERMISSION_MISSING");
  assert.equal(await MetaConnection.countDocuments({}), 0, "nothing saved after a failed test");

  // a wrong token cannot be saved either
  world.scopes = ["ads_read"];
  const wrong = await staff("PUT", "/api/website/meta-connection", connectBody({ token: "x".repeat(60) }));
  assert.equal(wrong.status, 400); assert.equal(wrong.json.code, "TOKEN_INVALID");
  assert.equal(await MetaConnection.countDocuments({}), 0);

  // input rules
  assert.equal((await staff("POST", "/api/website/meta-connection/test", { adAccountId: "nope", token: TOKEN })).json.code, "INVALID_ACCOUNT_ID");
  assert.equal((await staff("POST", "/api/website/meta-connection/test", { adAccountId: "123", token: TOKEN })).json.code, "INVALID_ACCOUNT_ID", "too short to be an account id");
  assert.equal((await staff("POST", "/api/website/meta-connection/test", { adAccountId: ACCOUNT, token: "short" })).json.code, "INVALID_TOKEN");
  // digits alone are normalized to act_<digits>
  const digits = ok(await staff("PUT", "/api/website/meta-connection", { adAccountId: "1234567890", token: TOKEN }));
  await metaSync.idle();
  assert.equal(digits.adAccountId, ACCOUNT);
});

it("fallback: when /debug_token is refused for this kind of token, /me/permissions gives the scopes", async () => {
  world.debugTokenFails = true;
  const result = ok(await staff("POST", "/api/website/meta-connection/test", connectBody()));
  assert.equal(result.hasAdsRead, true);
  assert.ok(world.calls.some((c) => c.path === "me/permissions"));
});

it("connect saves it encrypted, shows only the last 4, starts the 90-day backfill; disconnect removes the token and keeps the data", async () => {
  world.campaigns = [metaCampaign(11, "حملة رمضان")];
  world.insights = [insight(11, day(-1), "12.50"), insight(11, day(-60), "7.25")];
  const view = await connect({ appSecret: APP_SECRET });
  assert.equal(view.connected, true); assert.equal(view.adAccountId, ACCOUNT);
  assert.equal(view.tokenLast4, TOKEN.slice(-4)); assert.equal(view.hasAppSecret, true); assert.equal(view.appSecretLast4, APP_SECRET.slice(-4));
  assert.equal(view.account.name, "حساب المتجر");
  assert.ok(!("tokenSealed" in view) && !("token" in view) && !("appSecret" in view));

  const stored = await connection();
  assert.ok(stored.tokenSealed.startsWith("v1.")); assert.ok(!JSON.stringify(stored).includes(TOKEN)); assert.ok(!JSON.stringify(stored).includes(APP_SECRET));
  assert.equal(secretBox.open(stored.tokenSealed, "meta-token"), TOKEN);
  assert.equal(secretBox.open(stored.appSecretSealed, "meta-app-secret"), APP_SECRET);

  // the backfill ran: the 90 days in three 30-day windows, newest data and old data stored
  const insightCalls = world.calls.filter((c) => c.path === `${ACCOUNT}/insights`);
  assert.equal(insightCalls.length, 3, "90 days = 3 windows of 30");
  assert.equal(await MetaInsightDay.countDocuments({}), 2);
  assert.equal((await connection()).lastError, null); assert.ok((await connection()).lastBackfillAt);
  assert.equal(await MetaCampaign.countDocuments({}), 1);

  const again = ok(await staff("GET", "/api/website/meta-connection"));
  assert.equal(again.tokenLast4, TOKEN.slice(-4)); assert.ok(!JSON.stringify(again).includes(TOKEN));

  const gone = ok(await staff("DELETE", "/api/website/meta-connection"));
  assert.equal(gone.connected, false); assert.equal(gone.tokenLast4, null); assert.equal(gone.adAccountId, null);
  const after = await connection();
  assert.equal(after.connected, false); assert.equal(after.tokenSealed, undefined); assert.equal(after.appSecretSealed, undefined);
  assert.equal(await MetaInsightDay.countDocuments({}), 2, "synced data stays");
  const before = world.calls.length;
  assert.deepEqual(await metaSync.runSync({ mode: "daily" }), { status: "skipped", reason: "NOT_CONNECTED" });
  assert.equal(world.calls.length, before, "a disconnected account is never read");
});

it("only GET ever goes to Meta; the token travels in a header (never in a URL, except Meta's own debug_token input); appsecret_proof is the HMAC", async () => {
  world.campaigns = [metaCampaign(11, "حملة")]; world.insights = [insight(11, day(-1), "5")];
  await connect({ appSecret: APP_SECRET });
  await staff("POST", "/api/website/meta-connection/test", connectBody({ appSecret: APP_SECRET }));
  assert.ok(world.calls.length >= 6);
  for (const call of world.calls) {
    assert.equal(call.method, "GET", call.path);
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    if (call.path !== "debug_token") assert.ok(!call.url.includes(TOKEN), `${call.path}: the token is not in the URL`);
    assert.ok(!call.url.includes(APP_SECRET), "the app secret is never sent, only its proof");
    assert.equal(call.params.appsecret_proof, crypto.createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex"));
  }
  // nothing about customers or Nota data: only these parameters are ever sent
  const allowed = new Set(["fields", "limit", "after", "level", "time_increment", "time_range", "effective_status", "input_token", "appsecret_proof"]);
  for (const call of world.calls) for (const key of Object.keys(call.params)) assert.ok(allowed.has(key), `unexpected parameter ${key}`);
  // the real transport itself refuses anything else
  await assert.rejects(() => realTransportPost());
  // the Graph version: v27.0 by default, overridable
  assert.match(world.calls[0].url, /^https:\/\/graph\.facebook\.com\/v27\.0\//);
  process.env.NOTA_META_GRAPH_VERSION = "v26.0";
  try { await staff("POST", "/api/website/meta-connection/test", connectBody()); assert.match(world.calls[world.calls.length - 1].url, /\/v26\.0\//); } finally { delete process.env.NOTA_META_GRAPH_VERSION; }
});
async function realTransportPost() {
  // metaClient exports no way to send a non-GET: the transport it uses by default throws on anything else.
  const real = require("../src/services/meta/metaClient");
  real.setTransport(null);
  const fetchBefore = global.fetch;
  global.fetch = async () => { throw new Error("no network in tests"); };
  try {
    const client = real.createClient({ adAccountId: ACCOUNT, token: TOKEN });
    await client.account();
  } catch (error) {
    assert.equal(error.code, "NETWORK");
    throw error;
  } finally { global.fetch = fetchBefore; real.setTransport(fakeMeta); }
}

it("no secret appears in any response, audit entry, stored error or log line", async () => {
  world.campaigns = [metaCampaign(11, "حملة")]; world.insights = [insight(11, day(-1), "5")];
  const texts = [];
  const keep = (response) => { texts.push(response.text); return response; };
  keep(await staff("POST", "/api/website/meta-connection/test", connectBody({ appSecret: APP_SECRET })));
  keep(await staff("PUT", "/api/website/meta-connection", connectBody({ appSecret: APP_SECRET }))); await metaSync.idle();
  keep(await staff("GET", "/api/website/meta-connection"));
  keep(await staff("GET", "/api/website/marketing-settings"));
  keep(await staff("GET", "/api/website/settings"));
  keep(await staff("GET", "/api/campaigns/results"));
  keep(await staff("GET", "/api/campaigns"));
  keep(await staff("GET", "/api/campaigns/meta-campaigns"));
  keep(await staff("GET", "/api/website/exchange-rates"));
  // failures: Meta's own message carries the token; it must never be relayed
  fail("debug_token", metaError(190)); fail(ACCOUNT, metaError(190));
  keep(await staff("POST", "/api/website/meta-connection/test", connectBody({ appSecret: APP_SECRET })));
  fail(ACCOUNT, metaError(190), { times: 2 });
  await metaSync.runSync({ mode: "manual" });
  keep(await staff("GET", "/api/website/meta-connection"));
  keep(await staff("DELETE", "/api/website/meta-connection"));
  const audit = JSON.stringify(await AuditLog.find({}).lean());
  const stored = JSON.stringify(await connection());
  for (const secret of [TOKEN, APP_SECRET]) {
    for (const text of texts) assert.ok(!text.includes(secret), "a response contains a secret");
    assert.ok(!audit.includes(secret), "the audit log contains a secret");
    assert.ok(!stored.includes(secret), "the database holds a secret in clear");
    assert.ok(!logged.join("\n").includes(secret), "a log line contains a secret");
  }
  assert.ok(!texts.join("").includes("Meta says"), "Meta's own text is never relayed");
  const actions = (await AuditLog.find({}).lean()).map((row) => row.action);
  assert.ok(actions.includes("meta.connected") && actions.includes("meta.disconnected"));
  assert.deepEqual((await AuditLog.findOne({ action: "meta.connected" }).lean()).details, { adAccountId: ACCOUNT });
});

// ---------------------------------------------------------------------------------------------------------------------
// sync

it("the 7-day re-sync updates the numbers Meta revised, adds new days, never duplicates; paging follows cursors, never Meta's next URL", async () => {
  world.pageSize = 2;
  world.campaigns = [1, 2, 3, 4, 5].map((id) => metaCampaign(id, `حملة ${id}`));
  world.insights = [insight(1, day(-2), "10"), insight(2, day(-2), "20"), insight(3, day(-2), "30"), insight(4, day(-3), "40"), insight(5, day(-3), "50")];
  await connect();
  assert.equal(await MetaCampaign.countDocuments({}), 5, "5 campaigns over 3 pages");
  assert.equal(await MetaInsightDay.countDocuments({}), 5);
  const pagedCalls = world.calls.filter((c) => c.path === `${ACCOUNT}/campaigns`);
  assert.equal(pagedCalls.length, 3); assert.deepEqual(pagedCalls.map((c) => c.params.after || null), [null, "2", "4"]);
  assert.ok(world.calls.every((c) => !c.url.includes("leak")), "the next URL (it carries a token) is never followed");

  // Meta revises yesterday and adds today; the old window is not read by the daily run
  world.insights = [insight(1, day(-2), "11.25"), insight(1, day(0), "3"), insight(2, day(-2), "20")];
  world.pageSize = 500;
  world.calls.length = 0;
  assert.equal((await metaSync.runSync({ mode: "daily" })).status, "ok");
  const insightCalls = world.calls.filter((c) => c.path === `${ACCOUNT}/insights`);
  assert.equal(insightCalls.length, 1, "7 days is one window");
  assert.deepEqual(JSON.parse(insightCalls[0].params.time_range), { since: day(-6), until: day(0) });
  assert.equal(insightCalls[0].params.level, "campaign"); assert.equal(insightCalls[0].params.time_increment, "1");
  assert.equal(insightCalls[0].params.fields, "campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,date_start,date_stop");
  const revised = await MetaInsightDay.findOne({ metaId: "1", day: day(-2) }).lean();
  assert.equal(revised.spendMinor, 1125);
  assert.equal(await MetaInsightDay.countDocuments({ metaId: "1" }), 2, "one new day, no duplicate");
  assert.equal(await MetaInsightDay.countDocuments({}), 6, "a day Meta no longer sends stays as it was");
  assert.equal(revised.impressions, 1000); assert.equal(revised.reach, 800); assert.equal(revised.clicks, 50); assert.equal(revised.linkClicks, 40);
});

it("a campaign seen only in the insights still gets a row, and archived campaigns are requested", async () => {
  world.campaigns = [];
  world.insights = [insight(77, day(-1), "9", { campaign_name: "حملة قديمة" })];
  await connect();
  assert.equal((await MetaCampaign.findOne({ metaId: "77" }).lean()).name, "حملة قديمة");
  const call = world.calls.find((c) => c.path === `${ACCOUNT}/campaigns`);
  assert.match(call.params.effective_status, /ARCHIVED/);
  assert.equal(call.params.fields, "id,name,status,effective_status,objective,created_time");
});

for (const [name, setup, code, pauses] of [
  ["invalid or expired token (190)", () => fail(ACCOUNT, metaError(190), { times: 99 }), "TOKEN_INVALID", true],
  ["missing permission (200)", () => fail(ACCOUNT, metaError(200), { times: 99 }), "PERMISSION_MISSING", true],
  ["missing permission (100 / 3191001)", () => fail("insights", metaError(100, "x", 3191001), { times: 99 }), "PERMISSION_MISSING", true],
  ["rate limit (613)", () => fail("insights", metaError(613), { times: 99 }), "RATE_LIMITED", false],
  ["rate limit (80000 insights)", () => fail("insights", metaError(80000, "x", 2446079), { times: 99 }), "RATE_LIMITED", false],
  ["network error (5xx)", () => fail("campaigns", {}, { status: 503, times: 99 }), "NETWORK", false],
]) {
  it(`error: ${name} is stored as a fixed safe message${pauses ? " and pauses the daily sync" : " and does not pause it"}`, async () => {
    world.campaigns = [metaCampaign(1, "حملة")]; world.insights = [insight(1, day(-1), "5")];
    await connect();
    setup();
    const result = await metaSync.runSync({ mode: "manual" });
    assert.equal(result.status, "failed"); assert.equal(result.code, code);
    const stored = await connection();
    assert.equal(stored.lastError.code, code); assert.equal(stored.lastError.message, metaClient.FAILURES[code]);
    assert.equal(Boolean(stored.paused), pauses);
    const view = ok(await staff("GET", "/api/website/meta-connection"));
    assert.equal(view.lastError.code, code); assert.ok(!JSON.stringify(view).includes("Meta says"));
    // the banner on the marketing pages
    assert.equal(ok(await staff("GET", "/api/campaigns/results")).meta.lastError.code, code);
    assert.equal(ok(await staff("GET", "/api/campaigns")).meta.lastError.code, code);
    // daily run: skipped while paused or backing off
    const before = world.calls.length;
    const daily = await metaSync.runSync({ mode: "daily" });
    if (pauses || code === "RATE_LIMITED") {
      assert.equal(daily.status, "skipped", "the daily run does not keep hammering Meta");
      assert.equal(daily.reason, pauses ? "PAUSED" : "BACKING_OFF");
      assert.equal(world.calls.length, before);
    } else {
      assert.equal(daily.status, "failed", "a network problem is simply retried by the next run");
    }
  });
}

it("rate limit: Meta's usage headers set the back-off; after it the sync resumes by itself and clears the error", async () => {
  world.campaigns = [metaCampaign(1, "حملة")]; world.insights = [insight(1, day(-1), "5")];
  await connect();
  fail("insights", metaError(80000), { headers: { "x-business-use-case-usage": JSON.stringify({ 99: [{ type: "ads_insights", call_count: 100, total_cputime: 20, total_time: 20, estimated_time_to_regain_access: 20 }] }) } });
  assert.equal((await metaSync.runSync({ mode: "daily" })).code, "RATE_LIMITED");
  const stored = await connection();
  const wait = stored.retryAfter.getTime() - Date.now();
  assert.ok(wait > 19 * 60 * 1000 && wait < 21 * 60 * 1000, `waits the 20 minutes Meta asked for (${wait})`);
  assert.equal((await metaSync.runSync({ mode: "daily" })).reason, "BACKING_OFF");
  setClock(() => new Date(Date.now() + 25 * 60 * 1000));
  assert.equal((await metaSync.runSync({ mode: "daily" })).status, "ok");
  const after = await connection();
  assert.equal(after.lastError, null); assert.equal(after.retryAfter, null);
  // the usage header parsers
  assert.equal(metaClient.readUsage({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 120 }) }).waitSeconds, 120);
  assert.equal(metaClient.readUsage({ "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 80, acc_id_util_pct: 30 }) }).busyPercent, 80);
  assert.equal(metaClient.readUsage({ "x-app-usage": JSON.stringify({ call_count: 28, total_time: 25, total_cputime: 25 }) }).busyPercent, 28);
  assert.deepEqual(metaClient.readUsage({}), { busyPercent: 0, waitSeconds: 0 });
});

it("reconnecting after an invalid token clears the pause and syncs again", async () => {
  world.campaigns = [metaCampaign(1, "حملة")]; world.insights = [insight(1, day(-1), "5")];
  await connect();
  world.token = "a-new-token-0123456789-abcdefghijklmnopq";
  assert.equal((await metaSync.runSync({ mode: "daily" })).code, "TOKEN_INVALID");
  assert.equal((await connection()).paused, true);
  await connect({ token: world.token });
  const stored = await connection();
  assert.equal(stored.paused, false); assert.equal(stored.lastError, null);
  assert.equal((await metaSync.runSync({ mode: "daily" })).status, "ok");
});

it("an account that is not active does NOT pause the sync: its numbers are still read and a warning shows", async () => {
  world.account.account_status = 2; world.account.disable_reason = 1;
  world.campaigns = [metaCampaign(1, "حملة")]; world.insights = [insight(1, day(-1), "5")];
  const view = await connect();
  assert.equal(view.accountStatusWarning, true); assert.equal(view.account.accountStatus, 2);
  assert.equal(view.paused, false); assert.equal(view.lastError, null);
  assert.equal(await MetaInsightDay.countDocuments({}), 1);
  world.insights.push(insight(1, day(0), "6"));
  assert.equal((await metaSync.runSync({ mode: "daily" })).status, "ok");
  assert.equal(await MetaInsightDay.countDocuments({}), 2);
  assert.equal(ok(await staff("GET", "/api/campaigns/results")).meta.accountStatus, 2, "the results page can show the status banner");
  world.account.account_status = 1;
  assert.equal(ok(await staff("POST", "/api/website/meta-connection/test", connectBody())).accountStatusWarning, false);
});

it("the lock: two syncs at once run once, the other reports busy; a stale lease is taken over", async () => {
  world.campaigns = [metaCampaign(1, "حملة")]; world.insights = [insight(1, day(-1), "5")];
  await connect();
  world.calls.length = 0;
  let release; const gate = new Promise((resolve) => { release = resolve; });
  world.stall = () => gate;
  const first = metaSync.runSync({ mode: "daily" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await metaSync.runSync({ mode: "daily" });
  assert.deepEqual(second, { status: "busy" });
  assert.equal(world.calls.filter((c) => c.path === ACCOUNT).length, 1, "only one sync is talking to Meta");
  world.stall = null; release();
  assert.equal((await first).status, "ok");
  assert.equal((await connection()).lockedUntil, null, "the lease is released");
  // a crashed run: its lease expires
  await MetaConnection.updateOne({ _id: "default" }, { $set: { lockedUntil: new Date(Date.now() - 1000), lockOwner: "dead:1" } });
  assert.equal((await metaSync.runSync({ mode: "daily" })).status, "ok");
  // a live lease blocks the button too
  await MetaConnection.updateOne({ _id: "default" }, { $set: { lockedUntil: new Date(Date.now() + 60000), lockOwner: "alive:2" } });
  assert.equal((await staff("POST", "/api/website/meta-connection/sync", {})).json.code, "SYNC_RUNNING");
});

it("«مزامنة دلوقتي»: once per 5 minutes, runs in the background, needs a connection", async () => {
  assert.equal((await staff("POST", "/api/website/meta-connection/sync", {})).status, 409);
  world.campaigns = [metaCampaign(1, "حملة")]; world.insights = [insight(1, day(-1), "5")];
  await connect();
  const first = await staff("POST", "/api/website/meta-connection/sync", {});
  assert.equal(first.status, 202); await metaSync.idle();
  const second = await staff("POST", "/api/website/meta-connection/sync", {});
  assert.equal(second.status, 429); assert.equal(second.json.code, "SYNC_TOO_SOON"); assert.ok(second.json.retryAfterSeconds > 0 && second.json.retryAfterSeconds <= 300);
  assert.ok(ok(await staff("GET", "/api/website/meta-connection")).nextManualSyncAt);
  setClock(() => new Date(Date.now() + 5 * 60 * 1000 + 1000));
  assert.equal((await staff("POST", "/api/website/meta-connection/sync", {})).status, 202); await metaSync.idle();
});

it("windows: backfill covers 90 days in 30-day windows, the daily run 7 days, ending on the shop's local today", () => {
  const backfill = metaSync.windowsFor(90);
  assert.equal(backfill.length, 3); assert.equal(backfill[0].since, day(-89)); assert.equal(backfill[2].until, day(0));
  for (const window of backfill) assert.ok(window.since <= window.until);
  assert.deepEqual(metaSync.windowsFor(7), [{ since: day(-6), until: day(0) }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// linking

const newCampaign = async (extra = {}) => ok(await staff("POST", "/api/campaigns", { name: `حملة ${++codeSeq}`, platform: "facebook", type: "paid", landing: { kind: "home" }, ...extra }), 201);

it("linking: a Nota campaign takes several Meta campaigns, a Meta campaign belongs to one Nota campaign; the code in the name is only suggested", async () => {
  const a = await newCampaign({ code: "ramadan-1" }); const b = await newCampaign({ code: "eid-2" });
  world.campaigns = [metaCampaign(1, "Ramadan-1 sale"), metaCampaign(2, "Other"), metaCampaign(3, "Third")];
  await connect();
  const list = ok(await staff("GET", `/api/campaigns/meta-campaigns?campaignId=${a._id}`)).data;
  assert.equal(list[0].metaId, "1"); assert.equal(list[0].suggested, true, "the one containing the code comes first");
  assert.equal(list.filter((row) => row.suggested).length, 1);
  assert.ok(list.every((row) => row.campaignId === null), "nothing was linked automatically");
  assert.equal(ok(await staff("GET", `/api/campaigns/meta-campaigns?search=third`)).data.length, 1);

  ok(await staff("POST", `/api/campaigns/${a._id}/meta-links`, { metaId: "1" }), 201);
  ok(await staff("POST", `/api/campaigns/${a._id}/meta-links`, { metaId: "2" }), 201);
  ok(await staff("POST", `/api/campaigns/${a._id}/meta-links`, { metaId: "2" }), 201); // again: idempotent for the same campaign
  const taken = await staff("POST", `/api/campaigns/${b._id}/meta-links`, { metaId: "1" });
  assert.equal(taken.status, 409); assert.equal(taken.json.code, "ALREADY_LINKED");
  assert.equal((await staff("POST", `/api/campaigns/${b._id}/meta-links`, { metaId: "999" })).json.code, "META_CAMPAIGN_NOT_FOUND");
  assert.equal((await staff("POST", `/api/campaigns/${b._id}/meta-links`, { metaId: "x" })).json.code, "INVALID_META_CAMPAIGN");
  assert.deepEqual(ok(await staff("GET", `/api/campaigns/${a._id}/meta-links`)).data.map((row) => row.metaId).sort(), ["1", "2"]);
  assert.equal(ok(await staff("GET", `/api/campaigns/${b._id}/meta-links`)).data.length, 0);
  const unlinkedOnly = ok(await staff("GET", `/api/campaigns/meta-campaigns?unlinked=1`)).data;
  assert.deepEqual(unlinkedOnly.map((row) => row.metaId), ["3"]);

  ok(await staff("DELETE", `/api/campaigns/${a._id}/meta-links/1`));
  assert.equal((await staff("DELETE", `/api/campaigns/${a._id}/meta-links/1`)).status, 404);
  ok(await staff("POST", `/api/campaigns/${b._id}/meta-links`, { metaId: "1" }), 201);

  // two requests at once: one wins
  const [x, y] = await Promise.all([staff("POST", `/api/campaigns/${a._id}/meta-links`, { metaId: "3" }), staff("POST", `/api/campaigns/${b._id}/meta-links`, { metaId: "3" })]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);

  const tiktok = await newCampaign({ platform: "tiktok", type: "organic" });
  assert.equal((await staff("POST", `/api/campaigns/${tiktok._id}/meta-links`, { metaId: "2" })).json.code, "PLATFORM_NOT_LINKABLE");
  const audit = (await AuditLog.find({}).lean()).map((row) => row.action);
  assert.ok(audit.includes("campaign.meta.linked") && audit.includes("campaign.meta.unlinked"));
  // viewing links is marketing.view, changing them marketing.manage
  const viewer = await makeStaff("viewer", "cashier", ["marketing.view"]);
  assert.equal((await staff("GET", `/api/campaigns/${a._id}/meta-links`, undefined, viewer)).status, 200);
  assert.equal((await staff("POST", `/api/campaigns/${a._id}/meta-links`, { metaId: "1" }, viewer)).status, 403);
});

// ---------------------------------------------------------------------------------------------------------------------
// results

async function seedSales(campaign) {
  // One delivered order of 2 units (230: product 100 x 2 + delivery 30, profit 100) attributed to `campaign`, through the real flows.
  await JournalEntry.deleteMany({}); await Account.deleteMany({}); await forgetBoxes(); await Counter.deleteMany({ _id: { $in: ["JE", "OB"] } }); await Meta.deleteMany({});
  await Meta.create({ _id: "schema", version: 4 }); await runMigrations();
  ok(await staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر", fulfillment: { delivery: true, pickup: true } }));
  const category = ok(await staff("POST", "/api/categories", { name: `فئة ${++categorySeq}`, image: PNG_URI }), 201);
  const categoryId = category._id || category.id || category.category?._id;
  ok(await staff("PUT", `/api/website/categories/${categoryId}`, { visibility: "show", sortOrder: 1 }));
  const created = ok(await staff("POST", "/api/products", { name: "منتج", code: "P1", categoryId, inventoryCount: 50, purchasePrice: 50, wholesalePrice: 60, retailPrice: 100, image: PNG_URI }), 201);
  const productId = created._id || created.product?._id;
  ok(await staff("PUT", `/api/website/products/${productId}`, { visibility: "show", description: "وصف", images: [PNG_URI] }));
  const zone = ok(await staff("POST", "/api/website/delivery-zones", { name: "القاهرة", fee: 30, estimatedTime: "24" }), 201);
  const courier = ok(await staff("POST", "/api/couriers", { name: "أحمد", phone: "01000000001" }), 201);
  const placed = ok(await call("POST", "/api/store/orders", { body: { items: [{ productId, qty: 2 }], zoneId: zone.id, idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE, address: "شارع 1", notes: "" }, attribution: { code: campaign.code, landedAt: new Date().toISOString() } } }), 201);
  ok(await staff("POST", `/api/orders/${placed.id}/confirm`, {})); ok(await staff("POST", `/api/orders/${placed.id}/dispatch`, { courierId: courier.id })); ok(await staff("POST", `/api/orders/${placed.id}/deliver`, {}));
  // A direct pickup order (not attributed) puts 100 of cash in the main box, so ad spend can be paid from it.
  const pickup = ok(await call("POST", "/api/store/orders", { body: { items: [{ productId, qty: 1 }], fulfillment: "pickup", idempotencyKey: uuid(), contact: { name: "عميل", phone: PHONE } } }), 201);
  for (const action of ["confirm", "prepare", "ready", "pickup"]) ok(await staff("POST", `/api/orders/${pickup.id}/${action}`, {}));
  return created;
}
async function recordSpend(campaign, amount) {
  const category = ok(await staff("GET", "/api/campaigns/ad-category"));
  return ok(await staff("POST", "/api/expenses", { accountId: category.accountId, amount, date: today(), note: "إعلان", campaignId: campaign._id }), 201);
}
const ledgerSize = async () => ({ entries: await JournalEntry.countDocuments({}), expenses: await Expense.countDocuments({}) });

it("results: a linked campaign's spend is Meta's (EGP), recorded expenses are shown apart and NOT added; platform and total add Meta once; ROI uses Meta's spend", async () => {
  const linked = await newCampaign({ code: "linked-1" }); const plain = await newCampaign({ code: "plain-1" });
  await seedSales(linked);
  await recordSpend(linked, 40); await recordSpend(plain, 25);
  world.campaigns = [metaCampaign(1, "A linked-1"), metaCampaign(2, "B"), metaCampaign(3, "Not linked")];
  world.insights = [insight(1, today(), "100.00", { impressions: "2000", reach: "1500", clicks: "90", inline_link_clicks: "80" }), insight(2, today(), "20.00", { impressions: "500", reach: "400", clicks: "10", inline_link_clicks: "5" }), insight(1, day(-1), "50.50", { impressions: "1000", reach: "700", clicks: "40", inline_link_clicks: "20" }), insight(3, today(), "7.00")];
  await connect();
  ok(await staff("POST", `/api/campaigns/${linked._id}/meta-links`, { metaId: "1" }), 201);
  ok(await staff("POST", `/api/campaigns/${linked._id}/meta-links`, { metaId: "2" }), 201);
  const before = await ledgerSize();

  const results = ok(await staff("GET", `/api/campaigns/results?from=${day(-1)}&to=${today()}`));
  const row = results.campaigns.find((item) => item.code === "linked-1");
  assert.equal(row.spend, 170.5, "100 + 50.50 + 20 from Meta");
  assert.equal(row.recordedSpend, 40, "the recorded expense is shown apart");
  assert.equal(row.meta.spend, 170.5); assert.equal(row.meta.originalSpend, 170.5); assert.equal(row.meta.originalCurrency, "EGP"); assert.equal(row.meta.needsRate, false);
  assert.equal(row.meta.impressions, 3500); assert.equal(row.meta.reach, 2600); assert.equal(row.meta.linkClicks, 105);
  assert.equal(row.meta.ctr, 0.03, "105 / 3500"); assert.equal(row.meta.cpc, 1.62, "170.5 / 105"); assert.equal(row.meta.cpm, 48.71, "170.5 / 3500 * 1000");
  assert.equal(row.sales, 230); assert.equal(row.ordersCompleted, 1);
  assert.equal(row.costPerOrder, 170.5); assert.equal(row.returnOnSpend, 1.35, "230 / 170.5");
  assert.equal(row.profitAfterAds, -70.5, "100 - 170.5");

  const other = results.campaigns.find((item) => item.code === "plain-1");
  assert.equal(other.spend, 25, "an unlinked campaign keeps the 7A rule: spend = its expenses"); assert.equal(other.meta, undefined);
  const facebook = results.platforms.find((item) => item.platform === "facebook");
  assert.equal(facebook.spend, 195.5, "Meta 170.5 once + the unlinked campaign's expense 25; the linked campaign's 40 is not added");
  assert.equal(results.totals.spend, 195.5); assert.equal(results.totals.recordedSpend, 65);
  assert.equal(results.totals.meta.spend, 170.5);
  assert.equal(results.totals.sales, 330, "230 attributed + the 100 direct pickup order");
  assert.equal(results.totals.returnOnSpend, 1.69, "330 / 195.5");

  assert.equal(results.meta.unlinked.length, 1); assert.equal(results.meta.unlinked[0].name, "Not linked"); assert.equal(results.meta.unlinked[0].spend, 7);
  assert.equal(results.meta.unlinkedSpend, 7, "shown, but not added to any total");
  const daily = results.daily.find((item) => item.day === today());
  assert.equal(daily.metaSpend, 120, "100 + 20 on that day"); assert.equal(results.daily.find((item) => item.day === day(-1)).metaSpend, 50.5);

  const single = ok(await staff("GET", `/api/campaigns/${linked._id}/results?from=${day(-1)}&to=${today()}`));
  assert.equal(single.campaign.spend, 170.5); assert.equal(single.campaign.recordedSpend, 40); assert.equal(single.meta.connected, true);
  const list = ok(await staff("GET", `/api/campaigns?from=${day(-1)}&to=${today()}`));
  assert.equal(list.data.find((item) => item._id === linked._id).kpis.spend, 170.5);
  assert.equal(results.meta.unlinked.length, 1);

  // read-only: results, syncs and links posted nothing
  assert.deepEqual(await ledgerSize(), before);
  await metaSync.runSync({ mode: "daily" });
  assert.deepEqual(await ledgerSize(), before, "syncing posts nothing");
  // without profit permission the profit numbers are stripped as before
  const noCost = await makeStaff("nocost", "cashier", ["marketing.view"]);
  const stripped = ok(await staff("GET", "/api/campaigns/results", undefined, noCost));
  assert.equal(stripped.totals.profitAfterAds, undefined); assert.equal(stripped.campaigns[0].grossProfit, undefined);
  assert.equal(stripped.totals.spend, 195.5);
});

it("currency: a USD account converts each day with the rate effective that day; without a rate the spend stays in USD and ROI says it needs a rate", async () => {
  world.account.currency = "USD"; world.account.timezone_name = "America/Los_Angeles";
  const linked = await newCampaign({ code: "usd-1" });
  await seedSales(linked);
  world.campaigns = [metaCampaign(1, "usd-1")];
  world.insights = [insight(1, day(-2), "10.00"), insight(1, day(-1), "10.00"), insight(1, day(0), "10.00")];
  await connect();
  ok(await staff("POST", `/api/campaigns/${linked._id}/meta-links`, { metaId: "1" }), 201);
  const q = `from=${day(-2)}&to=${day(0)}`;

  // no rate yet
  let results = ok(await staff("GET", `/api/campaigns/results?${q}`));
  let row = results.campaigns.find((item) => item.code === "usd-1");
  assert.equal(results.meta.currency, "USD"); assert.equal(results.meta.needsRate, true); assert.equal(results.meta.timezoneNote, true, "Meta's days are in the account's zone");
  assert.equal(results.meta.timezoneName, "America/Los_Angeles");
  assert.equal(row.needsRate, true); assert.equal(row.meta.originalSpend, 30); assert.equal(row.meta.originalCurrency, "USD"); assert.equal(row.meta.spend, 0);
  assert.equal(row.costPerOrder, null); assert.equal(row.returnOnSpend, null); assert.equal(row.profitAfterAds, null);
  assert.equal(row.meta.cpc, null); assert.equal(row.meta.cpm, null);
  assert.equal(results.totals.returnOnSpend, null); assert.equal(results.totals.needsRate, true);

  // the rate history
  assert.equal((await staff("POST", "/api/website/exchange-rates", { rate: 0, effectiveFrom: day(-2) })).json.code, "INVALID_RATE");
  assert.equal((await staff("POST", "/api/website/exchange-rates", { rate: 1.0000001, effectiveFrom: day(-2) })).json.code, "INVALID_RATE");
  assert.equal((await staff("POST", "/api/website/exchange-rates", { rate: 50, effectiveFrom: "2026-13-45" })).json.code, "INVALID_DATE");
  ok(await staff("POST", "/api/website/exchange-rates", { rate: 48, effectiveFrom: day(-1) }), 201);
  results = ok(await staff("GET", `/api/campaigns/results?${q}`));
  row = results.campaigns.find((item) => item.code === "usd-1");
  assert.equal(row.needsRate, true, "the first day has no rate yet");
  assert.equal(row.meta.spend, 960, "10 USD at 48 on each of the two days that have a rate");
  assert.equal(row.meta.originalSpend, 30);

  ok(await staff("POST", "/api/website/exchange-rates", { rate: 40, effectiveFrom: day(-2) }), 201);
  ok(await staff("POST", "/api/website/exchange-rates", { rate: 50, effectiveFrom: day(0) }), 201);
  results = ok(await staff("GET", `/api/campaigns/results?${q}`));
  row = results.campaigns.find((item) => item.code === "usd-1");
  assert.equal(row.needsRate, false); assert.equal(results.meta.needsRate, false);
  assert.equal(row.meta.spend, 400 + 480 + 500, "40, 48, 50: each day with the rate effective that day");
  assert.equal(row.meta.originalSpend, 30); assert.equal(row.meta.originalCurrency, "USD");
  assert.equal(row.spend, 1380); assert.equal(row.costPerOrder, 1380); assert.equal(row.returnOnSpend, 0.17, "230 / 1380");
  assert.equal(results.daily.find((item) => item.day === day(-1)).metaSpend, 480);

  // changing a rate re-prices the days it covers (a read-side recompute); the same date replaces, never duplicates
  ok(await staff("POST", "/api/website/exchange-rates", { rate: 49, effectiveFrom: day(-1) }), 201);
  const rates = ok(await staff("GET", "/api/website/exchange-rates"));
  assert.equal(rates.currency, "USD"); assert.equal(rates.required, true); assert.equal(rates.data.length, 3);
  assert.deepEqual(rates.data.map((item) => item.effectiveFrom), [day(0), day(-1), day(-2)]);
  results = ok(await staff("GET", `/api/campaigns/results?${q}`));
  assert.equal(results.campaigns.find((item) => item.code === "usd-1").meta.spend, 400 + 490 + 500);
  ok(await staff("DELETE", `/api/website/exchange-rates/${rates.data[2]._id}`));
  assert.equal((await staff("DELETE", `/api/website/exchange-rates/${rates.data[2]._id}`)).status, 404);
  assert.equal(ok(await staff("GET", `/api/campaigns/results?${q}`)).meta.needsRate, true, "removing the oldest rate leaves its day uncovered");
});

it("currency: an EGP account needs no rate and refuses one", async () => {
  await connect();
  assert.equal(ok(await staff("GET", "/api/website/exchange-rates")).required, false);
  assert.equal((await staff("POST", "/api/website/exchange-rates", { rate: 1, effectiveFrom: today() })).json.code, "RATE_NOT_NEEDED");
  const results = ok(await staff("GET", "/api/campaigns/results"));
  assert.equal(results.meta.timezoneNote, false); assert.equal(results.meta.needsRate, false);
});

it("results are exactly as in 7A when Meta was never connected (no new keys)", async () => {
  const campaign = await newCampaign();
  await seedSales(campaign);
  await recordSpend(campaign, 40);
  const results = ok(await staff("GET", "/api/campaigns/results"));
  assert.equal(results.meta, undefined);
  const row = results.campaigns.find((item) => item.code === campaign.code);
  assert.equal(row.spend, 40); assert.equal(row.recordedSpend, undefined); assert.equal(row.meta, undefined);
  assert.equal(results.totals.spend, 40); assert.equal(results.totals.meta, undefined);
});

it("after disconnecting, the synced numbers still show in the results", async () => {
  const linked = await newCampaign({ code: "keep-1" });
  world.campaigns = [metaCampaign(1, "keep-1")]; world.insights = [insight(1, today(), "15")];
  await connect();
  ok(await staff("POST", `/api/campaigns/${linked._id}/meta-links`, { metaId: "1" }), 201);
  ok(await staff("DELETE", "/api/website/meta-connection"));
  const results = ok(await staff("GET", "/api/campaigns/results"));
  assert.equal(results.meta.connected, false);
  assert.equal(results.campaigns.find((item) => item.code === "keep-1").meta.spend, 15);
});

it("the new permission is in the catalog, owner only", () => {
  const { PERMISSIONS, ROLE_TEMPLATES } = require("../src/auth/permissions");
  assert.equal(PERMISSIONS["marketing.connect"].ar, "ربط حساب الإعلانات");
  assert.ok(ROLE_TEMPLATES.owner.includes("marketing.connect"));
  for (const role of ["manager", "cashier", "storekeeper", "accountant"]) assert.ok(!ROLE_TEMPLATES[role].includes("marketing.connect"), role);
});
