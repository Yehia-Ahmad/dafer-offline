// Online Stage 7C tests: creating Facebook/Instagram campaigns from Nota. Meta is mocked at BOTH transports (the reader's GET transport and the
// writer's POST transport, no network). Real throwaway mongod (port 27178, replica set).
// Covers: the writer's allowlist, the full publish in order with every body, retries without duplicates, the unknown-result search by tag,
// double submit, the money ceiling, goals, the public-URL rule, managing only what Nota created, permissions, error mapping and that no
// token / Meta text ever reaches a response, a log or an audit entry.
process.env.NODE_ENV = "test";
process.env.NOTA_JWT_SECRET = "online-stage7c-staff-secret-0123456789abcdef-0123456789";
process.env.NOTA_STORE_JWT_SECRET = "online-stage7c-store-secret-0123456789abcdef-0123456789";
process.env.NOTA_SECRETS_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
process.env.NOTA_PUBLIC_URL = "https://shop-nota.com";

const assert = require("node:assert/strict");
const test = require("node:test");

const app = require("../src/app");
const AuditLog = require("../src/models/auditLog.model");
const MetaConnection = require("../src/models/metaConnection.model");
const MetaCampaign = require("../src/models/metaCampaign.model");
const MetaPublish = require("../src/models/metaPublish.model");
const MetaPublishImage = require("../src/models/metaPublishImage.model");
const ExchangeRate = require("../src/models/exchangeRate.model");
const Product = require("../src/models/product.model");
const metaClient = require("../src/services/meta/metaClient");
const metaWriter = require("../src/services/meta/metaWriter");
const metaSync = require("../src/services/meta/metaSync.service");
const publishService = require("../src/services/meta/metaPublish.service");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");
const { today } = require("./helpers/shopDay");

const TOKEN = "EAAB-SECRET-token-0123456789abcdefghijklmnop";
const ACCOUNT = "act_1234567890";
const PAGE = "555000111";
const INSTA = "777000222";
const PIXEL = "123456789012345";
const MY_TEXT = "عرض الجمعة: خصم ٢٠٪ على كل القمصان";
const SCOPES = ["ads_read", "ads_management", "pages_manage_ads", "pages_read_engagement", "pages_show_list"];
const LEAK = "Meta says: token EAAB-SECRET-token-0123456789abcdefghijklmnop is bad";
let codeSeq = 0;

let stop; let server; let baseUrl; let ownerToken;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27178 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  metaClient.setTransport(null); metaWriter.setTransport(null); metaWriter.setSleep(null); metaSync.setSleep(null);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (stop) await stop();
});

const logged = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn };
const capture = (...args) => { logged.push(args.map(String).join(" ")); };

let world;
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  logged.length = 0;
  console.log = capture; console.error = capture; console.warn = capture;
  metaSync.setSleep(async () => {}); metaWriter.setSleep(async () => {});
  world = freshWorld();
  metaClient.setTransport(fakeGet); metaWriter.setTransport(fakePost);
  await clearDatabase(); resetDeviceThrottle(); app.locals.store.loginLimiter.reset();
  await require("../src/auth/ownerAccount").createOwner({ name: "Owner", username: "s7c-owner", password: "owner-pass-123" });
  ownerToken = (await call("POST", "/api/auth/login", { body: { username: "s7c-owner", password: "owner-pass-123" } })).json.token;
});
test.afterEach(() => { console.log = realConsole.log; console.error = realConsole.error; console.warn = realConsole.warn; });
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text };
}
const staff = (method, path, body, token = ownerToken) => call(method, path, { token, body });
const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.json; };

// ---------------------------------------------------------------------------------------------------------------------
// the fake Meta

function freshWorld() {
  return {
    gets: [], posts: [], objects: new Map(), seq: 1000,
    account: { id: ACCOUNT, name: "حساب المتجر", currency: "EGP", timezone_name: "Africa/Cairo", account_status: 1, disable_reason: 0 },
    scopes: [...SCOPES],
    pages: [{ id: PAGE, name: "صفحة المتجر" }],
    instagram: [{ id: INSTA, username: "shop_eg" }],
    pixels: [{ id: PIXEL, name: "بكسل", last_fired_time: "2026-11-19T10:00:00+0000" }],
    failPost: [], // { match, status, body, times }
    dropAfterCreate: [], // { match, times }: the object IS created, then the transport throws (an unknown result)
    applied: { creative_features_spec: { inline_comment: { enroll_status: "OPT_IN" } } },
  };
}
const metaError = (code, subcode, extra = {}) => ({ error: { message: LEAK, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}), error_user_title: "عنوان من ميتا", error_user_msg: LEAK, fbtrace_id: "x", ...extra } });
const formOf = (body) => {
  const out = {};
  for (const [key, value] of new URLSearchParams(body || "")) { try { out[key] = /^[\[{]/.test(value) ? JSON.parse(value) : value; } catch { out[key] = value; } }
  return out;
};
const pageOf = (rows) => ({ status: 200, headers: {}, body: { data: rows } });

async function fakeGet(url, { method, headers }) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/v\d+\.\d+\//, "");
  const params = Object.fromEntries(parsed.searchParams);
  world.gets.push({ method, path, params, headers: { ...headers }, url });
  if (method !== "GET") return { status: 405, headers: {}, body: metaError(1) };
  if (headers.Authorization !== `Bearer ${TOKEN}`) return { status: 400, headers: {}, body: metaError(190) };
  if (path === ACCOUNT) {
    if (params.fields === "min_daily_budget") return { status: 400, headers: {}, body: metaError(100) };
    return { status: 200, headers: {}, body: world.account };
  }
  if (path === "debug_token") return { status: 200, headers: {}, body: { data: { is_valid: true, scopes: world.scopes, expires_at: 0 } } };
  if (path === `${ACCOUNT}/campaigns`) return pageOf(filterTag([...world.objects.values()].filter((o) => o.kind === "campaign"), params));
  if (path === `${ACCOUNT}/insights`) return pageOf([]);
  if (path === `${ACCOUNT}/promote_pages`) return pageOf(world.pages);
  if (path === `${ACCOUNT}/connected_instagram_accounts`) return pageOf(world.instagram);
  if (path === `${ACCOUNT}/adspixels`) return pageOf(world.pixels);
  if (path === `${ACCOUNT}/adcreatives`) return pageOf(filterTag([...world.objects.values()].filter((o) => o.kind === "creative"), params));
  if (path === `${ACCOUNT}/generatepreviews`) return pageOf([{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=${params.ad_format}"></iframe>` }]);
  if (path === "search") return pageOf([{ key: "2420", name: "القاهرة", type: "region", country_code: "EG" }, { key: "9", name: "x", type: "country", country_code: "EG" }]);
  let match = /^(\d+)\/adsets$/.exec(path);
  if (match) return pageOf(filterTag([...world.objects.values()].filter((o) => o.kind === "adset" && o.parent === match[1]), params));
  match = /^(\d+)\/ads$/.exec(path);
  if (match) return pageOf(filterTag([...world.objects.values()].filter((o) => o.kind === "ad" && o.parent === match[1]), params));
  match = /^(\d+)$/.exec(path);
  if (match && world.objects.has(match[1])) {
    const object = world.objects.get(match[1]);
    return { status: 200, headers: {}, body: { id: object.id, name: object.name, status: object.status, effective_status: object.status, daily_budget: object.daily_budget, lifetime_budget: object.lifetime_budget, degrees_of_freedom_spec: world.applied } };
  }
  return { status: 404, headers: {}, body: metaError(803) };
}
const filterTag = (objects, params) => {
  const filter = params.filtering ? JSON.parse(params.filtering)[0] : null;
  return objects.filter((o) => !filter || o.name.includes(filter.value)).map((o) => ({ id: o.id, name: o.name }));
};

async function fakePost(url, { method, headers, body }) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/v\d+\.\d+\//, "");
  const form = formOf(body);
  const record = { method, path, form, headers: { ...headers }, url, body };
  world.posts.push(record);
  if (method !== "POST") return { status: 405, headers: {}, body: metaError(1) };
  if (headers.Authorization !== `Bearer ${TOKEN}`) return { status: 400, headers: {}, body: metaError(190) };
  const failure = world.failPost.find((item) => path.includes(item.match) && item.times > 0);
  if (failure) { failure.times -= 1; return { status: failure.status || 400, headers: {}, body: failure.body }; }
  const validateOnly = Array.isArray(form.execution_options) && form.execution_options.includes("validate_only");
  const edge = /^act_\d+\/(campaigns|adsets|adcreatives|ads|adimages)$/.exec(path);
  if (edge) {
    if (validateOnly) return { status: 200, headers: {}, body: { success: true } };
    if (edge[1] === "adimages") return { status: 200, headers: {}, body: { images: { "file.png": { hash: "0123456789abcdef0123456789abcdef", url: "x" } } } };
    const kind = { campaigns: "campaign", adsets: "adset", adcreatives: "creative", ads: "ad" }[edge[1]];
    const id = String(++world.seq);
    world.objects.set(id, { id, kind, name: form.name, status: form.status || "ACTIVE", parent: form.campaign_id || form.adset_id, daily_budget: form.daily_budget, lifetime_budget: form.lifetime_budget, form });
    const drop = world.dropAfterCreate.find((item) => path.endsWith(item.match) && item.times > 0);
    if (drop) { drop.times -= 1; throw new Error("socket hang up"); }
    return { status: 200, headers: {}, body: { id } };
  }
  const object = world.objects.get(path);
  if (object) { Object.assign(object, form); return { status: 200, headers: {}, body: { success: true } }; }
  return { status: 404, headers: {}, body: metaError(803) };
}

// ---------------------------------------------------------------------------------------------------------------------
// setup helpers

const PNG = (side = 1200) => {
  const buffer = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii"); buffer.writeUInt32BE(side, 16); buffer.writeUInt32BE(side, 20);
  return buffer;
};
const png64 = (side) => PNG(side).toString("base64");

async function connect() {
  ok(await staff("PUT", "/api/website/meta-connection", { adAccountId: ACCOUNT, token: TOKEN }));
  await metaSync.idle();
  ok(await staff("PUT", "/api/website/meta-connection/publish-target", { pageId: PAGE, instagramId: INSTA }));
}
const newCampaign = async (extra = {}) => ok(await staff("POST", "/api/campaigns", { name: `حملة الجمعة ${++codeSeq}`, platform: "facebook", type: "paid", landing: { kind: "home" }, startDate: today(), ...extra }), 201);
const ad = (extra = {}) => ({ primaryText: MY_TEXT, headline: "اشتري دلوقتي", description: "شحن لكل مصر", cta: "SHOP_NOW", image: { kind: "upload", data: png64() }, ...extra });
const specOf = (extra = {}) => ({ goal: "traffic", budget: { type: "daily", amount: 300 }, audience: { advantage: true, ageMin: 20, locations: [{ key: "2420", type: "region", name: "القاهرة" }] }, ads: [ad()], ...extra });
// Images go up on their own first (one raw request each, at most 8 MB); the draft then names them by imageId.
async function uploadRaw(campaign, buffer, type = "image/png", token = ownerToken) {
  const response = await fetch(`${baseUrl}/api/campaigns/${campaign._id}/publish/images`, { method: "POST", headers: { "Content-Type": type, Authorization: `Bearer ${token}` }, body: buffer });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text };
}
async function postDraft(campaign, spec, token = ownerToken) {
  const ads = [];
  for (const entry of spec.ads || []) {
    if (entry && entry.image && entry.image.kind === "upload" && entry.image.data !== undefined) {
      const sent = await uploadRaw(campaign, Buffer.from(entry.image.data, "base64"), "image/png", token);
      if (sent.status !== 201) return sent;
      ads.push({ ...entry, image: { kind: "upload", imageId: sent.json.imageId } });
    } else ads.push(entry);
  }
  return staff("POST", `/api/campaigns/${campaign._id}/publish`, { ...spec, ads }, token);
}
const draft = async (campaign, spec = specOf()) => ok(await postDraft(campaign, spec), 201);
const runIt = async (campaign, publishId) => staff("POST", `/api/campaigns/${campaign._id}/publish/${publishId}/run`, {});
async function publishFully(campaign, spec) {
  const created = await draft(campaign, spec);
  const result = ok(await runIt(campaign, created.publishId));
  assert.equal(result.status, "published", JSON.stringify(result));
  return result;
}
const createsOf = (suffix) => world.posts.filter((p) => p.path.endsWith(suffix) && !(p.form.execution_options || []).includes("validate_only"));
const makeStaff = async (username, role, permissions) => {
  ok(await staff("POST", "/api/users", { name: username, username, password: "secret-pass-1", role, ...(permissions ? { permissions } : {}) }), 201);
  return ok(await call("POST", "/api/auth/login", { body: { username, password: "secret-pass-1" } })).token;
};

// ---------------------------------------------------------------------------------------------------------------------
// the writer's allowlist

it("the writer refuses every endpoint outside the allowlist, and POST <id> for an id Nota did not create or with a field outside the list", async () => {
  const owned = new Set(["999"]);
  const writer = metaWriter.createWriter({ adAccountId: ACCOUNT, token: TOKEN, ownsObject: async (id) => owned.has(id) });
  for (const path of [`${ACCOUNT}`, `${ACCOUNT}/insights`, `${ACCOUNT}/users`, `${ACCOUNT}/customaudiences`, `${ACCOUNT}/adspixels`, "act_999/campaigns", "me/feed", "me", "1234/feed", `${PAGE}/feed`, "business_users", "1/../2", `${ACCOUNT}/campaigns/extra`, "debug_token"]) {
    await assert.rejects(() => writer.updateObject(path, { status: "PAUSED" }), (error) => error.code === "PUBLISH_NOT_ALLOWED", path);
  }
  await assert.rejects(() => writer.updateObject("123", { status: "PAUSED" }), (error) => error.code === "PUBLISH_NOT_ALLOWED", "an id Nota did not create");
  for (const fields of [{ objective: "OUTCOME_SALES" }, { status: "PAUSED", spend_cap: 1 }, { access_token: "x" }, {}, { status: "WHATEVER" }, { targeting: {} }]) {
    await assert.rejects(() => writer.updateObject("999", fields), (error) => error.code === "PUBLISH_NOT_ALLOWED", JSON.stringify(fields));
  }
  assert.equal(world.posts.length, 0, "nothing refused reached Meta");
  // the allowed ones
  await world.objects.set("999", { id: "999", kind: "campaign", name: "x" });
  await writer.updateObject("999", { status: "PAUSED", daily_budget: 5000, lifetime_budget: 9000, end_time: "2026-12-01T00:00:00.000Z", name: "n" });
  await writer.validateCampaign({ name: "t" });
  assert.equal(world.posts.length, 2);
  // there is no DELETE and no GET path in the writer, and the reader still refuses anything but GET
  assert.equal(typeof writer.delete, "undefined");
  const source = require("node:fs").readFileSync(require.resolve("../src/services/meta/metaWriter.js"), "utf8");
  assert.ok(!/method:\s*"(DELETE|PUT|PATCH)"/.test(source));
  assert.ok(require("node:fs").readFileSync(require.resolve("../src/services/meta/metaClient.js"), "utf8").includes('if (method !== "GET") throw'));
});

// ---------------------------------------------------------------------------------------------------------------------
// the full publish

it("a full publish sends, in order: validate, campaign (PAUSED, no special categories, campaign budget), images, ad set, creatives, ads; then links and syncs", async () => {
  await connect();
  const campaign = await newCampaign();
  const result = await publishFully(campaign, specOf({ ads: [ad(), ad({ headline: "تاني", image: { kind: "upload", data: png64(1080) } })] }));
  const writes = world.posts.map((p) => `${p.path.replace(ACCOUNT + "/", "")}${(p.form.execution_options || []).length ? ":validate" : ""}`);
  assert.deepEqual(writes, ["campaigns:validate", "campaigns", "adimages", "adimages", "adsets:validate", "adsets", "adcreatives:validate", "adcreatives", "adcreatives:validate", "adcreatives", "ads", "ads"]);

  const [metaCampaign] = createsOf("/campaigns");
  assert.equal(metaCampaign.form.status, "PAUSED");
  assert.deepEqual(metaCampaign.form.special_ad_categories, []);
  assert.equal(metaCampaign.form.objective, "OUTCOME_TRAFFIC");
  assert.equal(metaCampaign.form.buying_type, "AUCTION");
  assert.equal(metaCampaign.form.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(metaCampaign.form.daily_budget, "30000", "300 EGP in minor units (offset 100): the budget lives on the campaign");
  assert.equal(metaCampaign.form.lifetime_budget, undefined);
  const publishId = result.publishId;
  assert.ok(metaCampaign.form.name.endsWith(`[nota:${publishId}]`), "the hidden tag ends the name");
  assert.ok(metaCampaign.form.name.includes(campaign.code));

  const [adSet] = createsOf("/adsets");
  assert.equal(adSet.form.status, "ACTIVE"); assert.equal(adSet.form.optimization_goal, "LINK_CLICKS"); assert.equal(adSet.form.destination_type, "WEBSITE");
  assert.equal(adSet.form.campaign_id, result.metaCampaignId); assert.equal(adSet.form.daily_budget, undefined, "no budget on the ad set");
  assert.deepEqual(adSet.form.targeting.geo_locations, { countries: ["EG"], regions: [{ key: "2420" }] });
  assert.deepEqual(adSet.form.targeting.targeting_automation, { advantage_audience: 1 }, "explicit");
  assert.equal(adSet.form.targeting.age_min, 20); assert.equal(adSet.form.targeting.age_max, undefined, "Advantage+ audience fixes the maximum age: never sent");
  assert.equal(adSet.form.targeting.genders, undefined);
  assert.ok(adSet.form.name.endsWith(`[nota:${publishId}]`));

  const creatives = createsOf("/adcreatives");
  assert.equal(creatives.length, 2);
  for (const creative of creatives) {
    const spec = creative.form.object_story_spec;
    assert.equal(spec.page_id, PAGE); assert.equal(spec.instagram_user_id, INSTA);
    assert.equal(spec.link_data.message, MY_TEXT, "the shop's text, word for word");
    assert.equal(spec.link_data.image_hash, "0123456789abcdef0123456789abcdef");
    assert.equal(spec.link_data.call_to_action.type, "SHOP_NOW");
    assert.equal(creative.form.degrees_of_freedom_spec.creative_features_spec.product_extensions.enroll_status, "OPT_OUT");
    for (const key of ["text_optimizations", "description_automation", "text_translation"]) assert.equal(creative.form.degrees_of_freedom_spec.creative_features_spec[key].enroll_status, "OPT_OUT", key);
  }
  const ads = createsOf("/ads");
  assert.equal(ads.length, 2); for (const created of ads) { assert.equal(created.form.status, "ACTIVE"); assert.equal(created.form.adset_id, adSet && [...world.objects.values()].find((o) => o.kind === "adset").id); }

  // what Meta applied is read back (GET) and stored
  const stored = await MetaPublish.findOne({ publishId }).lean();
  assert.deepEqual(stored.ads[0].appliedFeatures, world.applied);
  assert.equal(stored.status, "published");
  assert.equal(await MetaPublishImage.countDocuments({ publishId }), 0, "uploaded bytes are dropped once published");

  // linked to the Nota campaign automatically, created by Nota, and a 7B sync started
  const link = await MetaCampaign.findOne({ metaId: result.metaCampaignId }).lean();
  assert.equal(String(link.campaignId), campaign._id); assert.equal(link.createdByNota, true); assert.equal(link.status, "PAUSED");
  await metaSync.idle();
  assert.ok(world.gets.some((g) => g.path === `${ACCOUNT}/insights`), "a manual sync ran in the background");
  const links = ok(await staff("GET", `/api/campaigns/${campaign._id}/meta-links`)).data;
  assert.equal(links[0].createdByNota, true);

  // the audit: no token, no ad text, no image bytes
  const audit = await AuditLog.find({ action: "meta.publish.created" }).lean();
  assert.equal(audit.length, 1);
  const text = JSON.stringify(audit);
  assert.ok(!text.includes(TOKEN) && !text.includes(MY_TEXT) && !text.includes(png64()));
  assert.equal(audit[0].details.ads, 2); assert.equal(audit[0].details.budgetType, "daily");
});

it("no ad set body carries device or OS targeting (v27's device expansion does not apply); turning Advantage+ off sends the age range and gender", async () => {
  await connect();
  const campaign = await newCampaign();
  await publishFully(campaign, specOf({ audience: { advantage: false, ageMin: 22, ageMax: 50, gender: "female" } }));
  const [adSet] = createsOf("/adsets");
  assert.ok(!/user_device|user_os|individual_setting|"device"/.test(JSON.stringify(adSet.form)));
  assert.deepEqual(adSet.form.targeting.targeting_automation, { advantage_audience: 0 });
  assert.equal(adSet.form.targeting.age_min, 22); assert.equal(adSet.form.targeting.age_max, 50); assert.deepEqual(adSet.form.targeting.genders, [2]);
  assert.deepEqual(adSet.form.targeting.geo_locations, { countries: ["EG"] }, "Egypt always");
  assert.equal(adSet.form.targeting.publisher_platforms, undefined, "Advantage+ placements: nothing sent");
  // Advantage+ on: age_min only 18-25
  const second = await newCampaign();
  assert.equal((await postDraft(second, specOf({ audience: { advantage: true, ageMin: 30 } }))).status, 400);
});

it("a total budget needs an end date, goes on the campaign as lifetime_budget and the ad set carries end_time", async () => {
  await connect();
  const campaign = await newCampaign();
  const end = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  assert.equal((await postDraft(campaign, specOf({ budget: { type: "lifetime", amount: 2000 } }))).status, 400, "no end date");
  await publishFully(campaign, specOf({ budget: { type: "lifetime", amount: 2000, endTime: `${end}T23:00` } }));
  const [metaCampaign] = createsOf("/campaigns"); const [adSet] = createsOf("/adsets");
  assert.equal(metaCampaign.form.lifetime_budget, "200000"); assert.equal(metaCampaign.form.daily_budget, undefined);
  assert.ok(adSet.form.end_time && adSet.form.start_time);
});

// ---------------------------------------------------------------------------------------------------------------------
// retries, unknown results, double submit

it("a retry after a failure at each step continues from that step and never creates anything twice", async () => {
  await connect();
  for (const [step, match] of [["campaign", "act_1234567890/campaigns"], ["images", "adimages"], ["adset", "adsets"], ["creatives", "adcreatives"], ["ads", "/ads"]]) {
    world.posts.length = 0; world.objects.clear();
    const campaign = await newCampaign();
    const created = await draft(campaign, specOf({ ads: [ad(), ad()] }));
    // fail the REAL create of that step (validate_only requests pass: the failure rule is skipped for them)
    world.failPost.push({ match: "", status: 400, body: metaError(100, 1885272), times: 0 });
    const rule = { match, status: 400, body: metaError(100, 1885272), times: 1 };
    const original = world.failPost; world.failPost = [rule];
    if (step === "campaign") rule.times = 2; // the validate_only call is the first POST to campaigns
    const failed = ok(await runIt(campaign, created.publishId));
    assert.equal(failed.status, "failed", step);
    assert.equal(failed.lastError.code, "BUDGET_TOO_LOW");
    assert.ok(Object.values(failed.steps).some((s) => s.state === "failed"), step);
    // the campaign (if created) is still PAUSED: nothing spends
    for (const object of world.objects.values()) if (object.kind === "campaign") assert.equal(object.status, "PAUSED");
    world.failPost = original;
    const retried = ok(await runIt(campaign, created.publishId));
    assert.equal(retried.status, "published", `${step}: ${JSON.stringify(retried)}`);
    const count = (kind) => [...world.objects.values()].filter((o) => o.kind === kind).length;
    assert.equal(count("campaign"), 1, `${step}: one campaign`); assert.equal(count("adset"), 1, `${step}: one ad set`);
    assert.equal(count("creative"), 2, `${step}: two creatives`); assert.equal(count("ad"), 2, `${step}: two ads`);
  }
});

it("an unknown result (timeout after sending a create) finds the object by its tag and does not re-create it", async () => {
  await connect();
  for (const [match, kind] of [["/campaigns", "campaign"], ["/adsets", "adset"], ["/adcreatives", "creative"], ["/ads", "ad"]]) {
    world.posts.length = 0; world.objects.clear();
    const campaign = await newCampaign();
    const created = await draft(campaign);
    world.dropAfterCreate = [{ match, times: 1 }];
    const result = ok(await runIt(campaign, created.publishId));
    assert.equal(result.status, "published", `${kind}: ${JSON.stringify(result)}`);
    assert.equal([...world.objects.values()].filter((o) => o.kind === kind).length, 1, `${kind} was not created twice`);
    assert.ok(world.gets.some((g) => (g.params.filtering || "").includes(`[nota:${created.publishId}]`)), `${kind}: searched by tag`);
  }
});

it("an unknown result where the object does NOT exist retries once", async () => {
  await connect();
  const campaign = await newCampaign();
  const created = await draft(campaign);
  let first = true;
  metaWriter.setTransport(async (url, options) => {
    if (first && url.endsWith(`${ACCOUNT}/campaigns`) && !options.body.includes("validate_only")) { first = false; throw new Error("timeout"); }
    return fakePost(url, options);
  });
  assert.equal(ok(await runIt(campaign, created.publishId)).status, "published");
  assert.equal([...world.objects.values()].filter((o) => o.kind === "campaign").length, 1);
});

it("double submit and two tabs: one publish only", async () => {
  await connect();
  const campaign = await newCampaign();
  const created = await draft(campaign);
  const [a, b] = await Promise.all([runIt(campaign, created.publishId), runIt(campaign, created.publishId)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `${a.text} ${b.text}`);
  assert.equal([...a.status === 409 ? [a] : [b]][0].json.code, "PUBLISH_RUNNING");
  assert.equal([...world.objects.values()].filter((o) => o.kind === "campaign").length, 1);
  // running a finished publish again changes nothing
  const before = world.posts.length;
  assert.equal(ok(await runIt(campaign, created.publishId)).status, "published");
  assert.equal(world.posts.length, before);
});

it("«إلغاء» sets the created campaign to DELETED and marks the record cancelled", async () => {
  await connect();
  const campaign = await newCampaign();
  const created = await draft(campaign);
  world.failPost = [{ match: "adsets", status: 400, body: metaError(100, 1885272), times: 5 }];
  assert.equal(ok(await runIt(campaign, created.publishId)).status, "failed");
  const cancelled = ok(await staff("POST", `/api/campaigns/${campaign._id}/publish/${created.publishId}/cancel`, {}));
  assert.equal(cancelled.status, "cancelled");
  assert.equal([...world.objects.values()].find((o) => o.kind === "campaign").status, "DELETED");
  assert.equal(await MetaPublishImage.countDocuments({}), 0);
  assert.ok(await AuditLog.exists({ action: "meta.publish.cancelled" }));
});

// ---------------------------------------------------------------------------------------------------------------------
// money

it("ceiling: above is refused, at is allowed; non-EGP converts with the 7B rate, without a rate it is refused; offset != 100 disables publishing", async () => {
  await connect();
  const campaign = await newCampaign();
  const over = await postDraft(campaign, specOf({ budget: { type: "daily", amount: 1000.01 } }));
  assert.equal(over.status, 409); assert.equal(over.json.code, "BUDGET_OVER_CEILING");
  ok(await postDraft(campaign, specOf({ budget: { type: "daily", amount: 1000 } })), 201);
  assert.equal((await postDraft(campaign, specOf({ budget: { type: "lifetime", amount: 10000.01, endTime: `${new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10)}T20:00` } }))).json.code, "BUDGET_OVER_CEILING");

  // the ceiling is a setting that needs marketing.publish
  const manager = await makeStaff("mgr", "manager");
  assert.equal((await staff("PUT", "/api/website/marketing-settings", { maxDailyBudgetEgp: 5 }, manager)).status, 403);
  ok(await staff("PUT", "/api/website/marketing-settings", { maxDailyBudgetEgp: 50 }));
  assert.equal((await postDraft(campaign, specOf({ budget: { type: "daily", amount: 51 } }))).json.code, "BUDGET_OVER_CEILING");
  assert.equal(ok(await staff("GET", `/api/campaigns/${campaign._id}/publish/options`)).ceiling.dailyEgp, 50);

  // a USD account
  ok(await staff("PUT", "/api/website/marketing-settings", { maxDailyBudgetEgp: 1000 }));
  world.account.currency = "USD";
  await connect();
  const noRate = await postDraft(campaign, specOf({ budget: { type: "daily", amount: 5 } }));
  assert.equal(noRate.status, 409); assert.equal(noRate.json.code, "RATE_REQUIRED");
  await ExchangeRate.create({ currency: "USD", rate: 50, effectiveFrom: "2020-01-01" });
  ok(await postDraft(campaign, specOf({ budget: { type: "daily", amount: 20 } })), 201); // 20 USD = 1000 EGP: at the ceiling
  assert.equal((await postDraft(campaign, specOf({ budget: { type: "daily", amount: 20.01 } }))).json.code, "BUDGET_OVER_CEILING");

  // a currency with another offset
  world.account.currency = "JPY";
  await connect();
  const options = ok(await staff("GET", `/api/campaigns/${campaign._id}/publish/options`));
  assert.equal(options.ready, false); assert.ok(options.blockers.some((b) => b.code === "CURRENCY_NOT_SUPPORTED"));
  assert.equal((await postDraft(campaign, specOf())).json.code, "CURRENCY_NOT_SUPPORTED");
});

it("the sales goal is refused without a pixel or with a pixel the ad account cannot see; allowed with a visible one", async () => {
  await connect();
  const campaign = await newCampaign();
  const sales = () => postDraft(campaign, specOf({ goal: "sales" }));
  assert.equal((await sales()).json.code, "PIXEL_REQUIRED", "no pixel id in the settings");
  ok(await staff("PUT", "/api/website/marketing-settings", { metaPixelId: "999999999999999" }));
  assert.equal((await sales()).json.code, "PIXEL_REQUIRED", "the account cannot see this pixel");
  assert.equal(ok(await staff("GET", `/api/campaigns/${campaign._id}/publish/options`)).salesAllowed, false);
  ok(await staff("PUT", "/api/website/marketing-settings", { metaPixelId: PIXEL }));
  const options = ok(await staff("GET", `/api/campaigns/${campaign._id}/publish/options`));
  assert.equal(options.salesAllowed, true); assert.equal(options.pixel.lastFiredTime, "2026-11-19T10:00:00+0000");
  const created = ok(await sales(), 201);
  assert.equal(ok(await runIt(campaign, created.publishId)).status, "published");
  const [metaCampaign] = createsOf("/campaigns"); const [adSet] = createsOf("/adsets");
  assert.equal(metaCampaign.form.objective, "OUTCOME_SALES");
  assert.equal(adSet.form.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.deepEqual(adSet.form.promoted_object, { pixel_id: PIXEL, custom_event_type: "PURCHASE" });
});

// ---------------------------------------------------------------------------------------------------------------------
// the link, images

it("a non-public site URL is refused; the link is the UTM link, never /go/", async () => {
  await connect();
  const campaign = await newCampaign({ landing: { kind: "path", path: "/offers" } });
  const saved = process.env.NOTA_PUBLIC_URL;
  try {
    for (const url of ["http://shop-nota.com", "https://localhost:3000", "https://192.168.1.5", "https://shop.local", "", "https://intranet"]) {
      process.env.NOTA_PUBLIC_URL = url;
      assert.equal(ok(await staff("GET", `/api/campaigns/${campaign._id}/publish/options`)).blockers.some((b) => b.code === "SITE_NOT_PUBLIC"), true, url || "(empty)");
      const refused = await postDraft(campaign, specOf());
      assert.equal(refused.status, 409, url); assert.equal(refused.json.code, "SITE_NOT_PUBLIC");
      assert.equal(await MetaPublish.countDocuments({}), 0, "no draft for a non-public site");
    }
  } finally { process.env.NOTA_PUBLIC_URL = saved; }
  const result = await publishFully(campaign, specOf());
  const link = createsOf("/adcreatives")[0].form.object_story_spec.link_data.link;
  assert.equal(link, `https://shop-nota.com/offers?utm_source=facebook&utm_medium=paid&utm_campaign=${campaign.code}`);
  assert.ok(!link.includes("/go/"));
  assert.equal(createsOf("/adcreatives")[0].form.object_story_spec.link_data.call_to_action.value.link, link);
  assert.ok(result.publishId);
});

it("images: at most 8 MB, jpg/png only, at least 600x600, 1 to 5 ads, text limits; a product's website image works", async () => {
  await connect();
  const campaign = await newCampaign();
  const tryAd = (extra) => postDraft(campaign, specOf({ ads: [ad(extra)] }));
  assert.equal((await tryAd({ image: { kind: "upload", data: png64(500) } })).json.code, "IMAGE_INVALID", "under 600x600");
  assert.equal((await tryAd({ image: { kind: "upload", data: Buffer.from("not an image at all").toString("base64") } })).json.code, "IMAGE_INVALID");
  assert.equal((await uploadRaw(campaign, Buffer.concat([PNG(), Buffer.alloc(8 * 1024 * 1024)]))).status, 413, "over 8 MB: refused before it is read");
  assert.equal((await tryAd({ primaryText: "" })).status, 400);
  assert.equal((await tryAd({ primaryText: "ا".repeat(501) })).status, 400);
  assert.equal((await postDraft(campaign, specOf({ ads: [] }))).status, 400);
  assert.equal((await postDraft(campaign, specOf({ ads: [ad(), ad(), ad(), ad(), ad(), ad()] }))).status, 400);
  const warned = ok(await tryAd({ headline: "ع".repeat(41), image: { kind: "upload", data: png64(700) } }), 201);
  assert.equal(warned.warnings.length, 2, "headline over 40 and an image under 1080x1080 only warn");
  // inserted raw: this test is about the image, not the product's required fields
  const inserted = await Product.collection.insertOne({ name: "قميص", image: png64(1200), website: { images: [png64(800)] } });
  const productId = String(inserted.insertedId);
  ok(await tryAd({ image: { kind: "product", productId, index: 0 } }), 201);
  ok(await tryAd({ image: { kind: "product", productId, index: 1 } }), 201);
  assert.equal((await tryAd({ image: { kind: "product", productId, index: 3 } })).json.code, "IMAGE_INVALID");
});

it("each image is its own request (raw bytes, at most 8 MB), staged, then claimed by the draft that names it; the normal body limit stays elsewhere", async () => {
  await connect();
  const campaign = await newCampaign();
  const other = await newCampaign();
  const one = ok(await uploadRaw(campaign, PNG(1200)), 201);
  assert.match(one.imageId, /^[a-f0-9]{32}$/); assert.equal(one.mime, "image/png"); assert.equal(one.width, 1200); assert.equal(one.bytes, PNG(1200).length);
  assert.equal(await MetaPublishImage.countDocuments({ imageId: one.imageId, publishId: new RegExp("^stage-") }), 1, "staged");
  assert.equal(world.posts.length, 0, "an upload to Nota sends nothing to Meta");
  // exactly 8 MB goes through; over it is refused; jpg too; anything else is refused
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x04, 0x38, 0x03]), Buffer.alloc(30)]);
  assert.equal(ok(await uploadRaw(campaign, jpg, "image/jpeg"), 201).mime, "image/jpeg");
  const big = Buffer.concat([PNG(), Buffer.alloc(8 * 1024 * 1024 - PNG().length)]);
  assert.equal(big.length, 8 * 1024 * 1024);
  ok(await uploadRaw(campaign, big), 201);
  assert.equal((await uploadRaw(campaign, Buffer.concat([big, Buffer.alloc(1)]))).status, 413);
  assert.equal((await uploadRaw(campaign, Buffer.from("not an image at all"))).json.code, "IMAGE_INVALID");
  assert.equal((await uploadRaw(campaign, PNG(500))).json.code, "IMAGE_INVALID", "under 600x600");
  assert.equal((await uploadRaw(campaign, PNG(), "application/octet-stream")).json.code, "IMAGE_INVALID", "only image/jpeg and image/png are read");
  // session and permission come first
  assert.equal((await call("POST", `/api/campaigns/${campaign._id}/publish/images`, {})).status, 401);
  const salesToken = await makeStaff("mgr1", "manager");
  assert.equal((await uploadRaw(campaign, PNG(), "image/png", salesToken)).status, 403);
  // a draft names its images; unknown, malformed and other-campaign ids are refused; the claimed image leaves the staging area
  const second = ok(await uploadRaw(campaign, PNG(1080)), 201);
  const created = ok(await staff("POST", `/api/campaigns/${campaign._id}/publish`, specOf({ ads: [ad({ image: { kind: "upload", imageId: one.imageId } }), ad({ image: { kind: "upload", imageId: second.imageId } })] })), 201);
  assert.equal(await MetaPublishImage.countDocuments({ publishId: created.publishId }), 2);
  assert.equal(await MetaPublishImage.countDocuments({ imageId: one.imageId, publishId: new RegExp("^stage-") }), 0, "no longer staged");
  for (const image of [{ kind: "upload", imageId: "f".repeat(32) }, { kind: "upload", imageId: "nope" }, { kind: "upload" }, { kind: "upload", data: png64() }]) {
    assert.equal((await staff("POST", `/api/campaigns/${campaign._id}/publish`, specOf({ ads: [ad({ image })] }))).json.code, "IMAGE_INVALID", JSON.stringify(image).slice(0, 40));
  }
  const foreign = ok(await uploadRaw(other, PNG()), 201);
  assert.equal((await staff("POST", `/api/campaigns/${campaign._id}/publish`, specOf({ ads: [ad({ image: { kind: "upload", imageId: foreign.imageId } })] }))).json.code, "IMAGE_INVALID", "another campaign's upload");
  // it publishes with those bytes and the bytes are dropped afterwards
  ok(await runIt(campaign, created.publishId));
  assert.equal(await MetaPublishImage.countDocuments({ publishId: created.publishId }), 0);
  // a staged image nobody claimed is dropped after a day (on the next upload)
  await MetaPublishImage.collection.updateOne({ imageId: foreign.imageId }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
  ok(await uploadRaw(other, PNG()), 201);
  assert.equal(await MetaPublishImage.countDocuments({ imageId: foreign.imageId }), 0);
  // the normal limit still applies to the draft itself: no endpoint takes the old 56 MB body
  const huge = await staff("POST", `/api/campaigns/${campaign._id}/publish`, { ...specOf(), padding: "x".repeat(11 * 1024 * 1024) });
  assert.equal(huge.status, 413);
  assert.ok(!require("node:fs").readFileSync(require.resolve("../src/app.js"), "utf8").includes("56mb"));
});

it("the preview uploads the ad's image once (no spend) and returns Meta's own frame through the reader", async () => {
  await connect();
  const campaign = await newCampaign();
  const created = await draft(campaign);
  const first = ok(await staff("POST", `/api/campaigns/${campaign._id}/publish/${created.publishId}/preview`, { index: 0, format: "instagram" }));
  assert.match(first.frames[0], /preview_iframe/);
  const previewGet = world.gets.find((g) => g.path === `${ACCOUNT}/generatepreviews`);
  assert.equal(previewGet.method, "GET"); assert.equal(previewGet.params.ad_format, "INSTAGRAM_STANDARD");
  ok(await staff("POST", `/api/campaigns/${campaign._id}/publish/${created.publishId}/preview`, { index: 0 }));
  assert.equal(world.posts.filter((p) => p.path.endsWith("adimages")).length, 1, "the hash is cached: one upload");
  assert.equal(world.posts.filter((p) => !p.path.endsWith("adimages")).length, 0, "a preview creates no campaign, ad set or ad");
});

// ---------------------------------------------------------------------------------------------------------------------
// switching on and managing

it("«تشغيل» needs the confirmation; switching, budget, end date and archive work only on campaigns Nota created", async () => {
  await connect();
  const campaign = await newCampaign();
  const result = await publishFully(campaign);
  await metaSync.idle();
  const base = `/api/campaigns/${campaign._id}/meta-links/${result.metaCampaignId}`;
  const object = () => world.objects.get(result.metaCampaignId);

  assert.equal((await staff("POST", `${base}/status`, { status: "ACTIVE" })).json.code, "CONFIRM_REQUIRED");
  assert.equal(object().status, "PAUSED", "nothing runs until the owner confirms");
  const on = ok(await staff("POST", `${base}/status`, { status: "ACTIVE", confirmSpend: true }));
  assert.equal(on.summary.amountMinor, 30000); assert.equal(on.summary.type, "daily");
  assert.equal(object().status, "ACTIVE");
  assert.equal((await MetaCampaign.findOne({ metaId: result.metaCampaignId }).lean()).status, "ACTIVE", "status refreshed from Meta and recorded");
  ok(await staff("POST", `${base}/status`, { status: "PAUSED" }));
  assert.equal(object().status, "PAUSED");

  // budget: ceiling applies, change is audited old -> new
  assert.equal((await staff("POST", `${base}/budget`, { amount: 5000 })).json.code, "BUDGET_OVER_CEILING");
  const changed = ok(await staff("POST", `${base}/budget`, { amount: 450 }));
  assert.equal(changed.oldMinor, 30000); assert.equal(changed.newMinor, 45000); assert.equal(object().daily_budget, "45000");
  const budgetAudit = await AuditLog.findOne({ action: "meta.campaign.budget" }).lean();
  assert.equal(budgetAudit.details.oldMinor, 30000); assert.equal(budgetAudit.details.newMinor, 45000);

  // end date (lives on the ad set)
  const end = `${new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10)}T22:00`;
  ok(await staff("POST", `${base}/end-time`, { endTime: end }));
  assert.ok([...world.objects.values()].find((o) => o.kind === "adset").end_time);
  assert.equal((await staff("POST", `${base}/end-time`, { endTime: "2020-01-01T10:00" })).status, 400);

  ok(await staff("POST", `${base}/archive`, {}));
  assert.equal(object().status, "ARCHIVED");
  assert.equal((await staff("POST", `${base}/status`, { status: "ACTIVE", confirmSpend: true })).json.code, "CAMPAIGN_CLOSED");

  // a campaign 7B synced (not created by Nota) is read-only
  const foreign = await MetaCampaign.create({ metaId: "424242", adAccountId: ACCOUNT, name: "من Ads Manager", status: "PAUSED", campaignId: campaign._id });
  world.objects.set("424242", { id: "424242", kind: "campaign", name: "x", status: "PAUSED" });
  const before = world.posts.length;
  for (const [path, body] of [["status", { status: "ACTIVE", confirmSpend: true }], ["budget", { amount: 10 }], ["end-time", { endTime: end }], ["archive", {}], ["refresh", {}]]) {
    const refused = await staff("POST", `/api/campaigns/${campaign._id}/meta-links/${foreign.metaId}/${path}`, body);
    assert.equal(refused.status, 409, path); assert.equal(refused.json.code, "NOT_CREATED_BY_NOTA", path);
  }
  assert.equal(world.posts.length, before, "nothing reached Meta");
  assert.ok(await AuditLog.exists({ action: "meta.campaign.status" })); assert.ok(await AuditLog.exists({ action: "meta.campaign.archived" })); assert.ok(await AuditLog.exists({ action: "meta.campaign.end_time" }));
});

it("switching on checks the ceiling again at that moment", async () => {
  await connect();
  const campaign = await newCampaign();
  const result = await publishFully(campaign);
  ok(await staff("PUT", "/api/website/marketing-settings", { maxDailyBudgetEgp: 100 }));
  const refused = await staff("POST", `/api/campaigns/${campaign._id}/meta-links/${result.metaCampaignId}/status`, { status: "ACTIVE", confirmSpend: true });
  assert.equal(refused.json.code, "BUDGET_OVER_CEILING");
  assert.equal(world.objects.get(result.metaCampaignId).status, "PAUSED");
});

// ---------------------------------------------------------------------------------------------------------------------
// permissions, the card

it("only marketing.publish can publish: the manager template does not have it, marketing.connect alone cannot", async () => {
  await connect();
  const campaign = await newCampaign();
  const created = await draft(campaign);
  const manager = await makeStaff("mgr", "manager");
  const connectOnly = await makeStaff("conn", "custom", ["marketing.view", "marketing.manage", "marketing.connect"]);
  const publisher = await makeStaff("pub", "custom", ["marketing.view", "marketing.publish"]);
  const requests = [["GET", `/api/campaigns/${campaign._id}/publish/options`], ["POST", `/api/campaigns/${campaign._id}/publish`, specOf()], ["POST", `/api/campaigns/${campaign._id}/publish/${created.publishId}/run`, {}], ["POST", `/api/campaigns/${campaign._id}/publish/${created.publishId}/preview`, { index: 0 }], ["POST", `/api/campaigns/${campaign._id}/publish/${created.publishId}/cancel`, {}], ["POST", `/api/campaigns/${campaign._id}/meta-links/1/status`, { status: "ACTIVE" }], ["POST", `/api/campaigns/${campaign._id}/meta-links/1/budget`, { amount: 1 }], ["GET", "/api/campaigns/meta-geo?q=ca"]];
  const writesBefore = world.posts.length;
  for (const [method, path, body] of requests) {
    for (const token of [manager, connectOnly]) assert.equal((await staff(method, path, body, token)).status, 403, `${method} ${path}`);
  }
  assert.equal(world.posts.length, writesBefore, "a refused request never reaches Meta");
  assert.equal((await staff("GET", `/api/campaigns/${campaign._id}/publish/options`, undefined, publisher)).status, 200);
  const me = ok(await staff("GET", "/api/auth/me"));
  assert.ok(me.permissions.includes("marketing.publish"));
  assert.equal((await staff("PUT", "/api/website/meta-connection/publish-target", { pageId: PAGE }, publisher)).status, 403, "choosing the Page needs marketing.connect");
});

it("the card: mode from the scopes, the Page and Instagram pickers come from Meta's lists and nothing else is accepted", async () => {
  world.scopes = ["ads_read"];
  ok(await staff("PUT", "/api/website/meta-connection", { adAccountId: ACCOUNT, token: TOKEN }));
  await metaSync.idle();
  assert.equal(ok(await staff("GET", "/api/website/meta-connection")).mode, "read");
  const noPublish = await staff("GET", `/api/campaigns/${(await newCampaign())._id}/publish/options`);
  assert.equal(ok(noPublish).mode, "read"); assert.equal(ok(noPublish).ready, false);
  assert.ok(ok(noPublish).blockers.find((b) => b.code === "PUBLISH_PERMISSION_MISSING").missing.includes("pages_manage_ads"));

  world.scopes = [...SCOPES];
  ok(await staff("PUT", "/api/website/meta-connection", { adAccountId: ACCOUNT, token: TOKEN }));
  await metaSync.idle();
  const card = ok(await staff("GET", "/api/website/meta-connection"));
  assert.equal(card.mode, "readwrite"); assert.equal(card.page, null);
  assert.deepEqual(ok(await staff("GET", "/api/website/meta-connection/pages")).data, [{ id: PAGE, name: "صفحة المتجر" }]);
  assert.deepEqual(ok(await staff("GET", "/api/website/meta-connection/instagram-accounts")).data, [{ id: INSTA, name: "shop_eg" }]);
  assert.equal((await staff("PUT", "/api/website/meta-connection/publish-target", { pageId: "999" })).json.code, "PAGE_NOT_ALLOWED");
  assert.equal((await staff("PUT", "/api/website/meta-connection/publish-target", { pageId: PAGE, instagramId: "1" })).json.code, "INSTAGRAM_NOT_FOUND");
  const saved = ok(await staff("PUT", "/api/website/meta-connection/publish-target", { pageId: PAGE }));
  assert.deepEqual(saved.page, { id: PAGE, name: "صفحة المتجر" }); assert.equal(saved.instagram, null);
  // without a Page there is no publishing
  await MetaConnection.updateOne({ _id: "default" }, { $unset: { pageId: "" } });
  const noPage = ok(await staff("GET", `/api/campaigns/${(await newCampaign())._id}/publish/options`));
  assert.ok(noPage.blockers.some((b) => b.code === "PAGE_REQUIRED"));
  // the instagram fallback: the Page's instagram_business_account
  world.instagram = [];
  const originalGet = fakeGet;
  metaClient.setTransport(async (url, options) => {
    if (new URL(url).pathname.endsWith(`/${PAGE}`)) return { status: 200, headers: {}, body: { instagram_business_account: { id: "888", username: "from_page" } } };
    return originalGet(url, options);
  });
  assert.deepEqual(ok(await staff("GET", `/api/website/meta-connection/instagram-accounts?pageId=${PAGE}`)).data, [{ id: "888", name: "from_page" }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// errors: fixed messages, nothing from Meta

it("every write error maps to a fixed message; no Meta text, URL, field text or token in a response, a log or an audit entry", async () => {
  await connect();
  const cases = [
    [metaError(100, 1885272), "BUDGET_TOO_LOW"], [metaError(100, 1885650), "BUDGET_TOO_LOW"], [metaError(100, 1487901), "BUDGET_TOO_LOW"],
    [metaError(100, 1885621), "BUDGET_CONFLICT"],
    [metaError(100, 2238055, { error_data: JSON.stringify({ blame_field_specs: [["daily_budget"]] }) }), "BUDGET_TOO_LOW"],
    [metaError(100, 3858258), "IMAGE_REJECTED"],
    [metaError(100, 2490427), "AD_POLICY"], [metaError(100, 2490468), "AD_POLICY"], [metaError(100, 2708008), "AD_POLICY"],
    [metaError(100, 1404163), "PAYMENT_REQUIRED"], [metaError(100, 1404078), "PAYMENT_REQUIRED"],
    [metaError(100, 1885183), "APP_NOT_LIVE"],
    [metaError(10), "PUBLISH_PERMISSION_MISSING"], [metaError(200), "PUBLISH_PERMISSION_MISSING"], [metaError(294), "PUBLISH_PERMISSION_MISSING"],
    [metaError(190), "TOKEN_INVALID"], [metaError(17), "RATE_LIMITED"],
    [metaError(100, 33, { error_data: { blame_field_specs: [["targeting"]] } }), "INVALID_PARAMETER"],
    [metaError(1), "META_ERROR"],
  ];
  for (const [body, code] of cases) {
    world.posts.length = 0; world.objects.clear();
    const campaign = await newCampaign();
    const created = await draft(campaign);
    world.failPost = [{ match: "campaigns", status: 400, body, times: 1 }];
    const result = ok(await runIt(campaign, created.publishId));
    assert.equal(result.status, "failed", code); assert.equal(result.lastError.code, code, JSON.stringify(body.error));
    const text = JSON.stringify(result);
    for (const forbidden of [LEAK, "EAAB-SECRET", "عنوان من ميتا", "graph.facebook.com", "fbtrace"]) assert.ok(!text.includes(forbidden), `${code}: ${forbidden}`);
  }
  // invalid parameter names the field only
  const campaign = await newCampaign();
  const created = await draft(campaign);
  world.failPost = [{ match: "campaigns", status: 400, body: metaError(100, 33, { error_data: { blame_field_specs: [["targeting"]] } }), times: 1 }];
  const invalid = ok(await runIt(campaign, created.publishId));
  assert.match(invalid.lastError.message, /targeting/); assert.ok(!invalid.lastError.message.includes(LEAK));
  // a page error on the creative step is about the Page
  const second = await newCampaign();
  const createdSecond = await draft(second);
  world.failPost = [{ match: "adcreatives", status: 400, body: metaError(200), times: 1 }];
  assert.equal(ok(await runIt(second, createdSecond.publishId)).lastError.code, "PAGE_NOT_ALLOWED");
  // an account that cannot run ads stops before anything is sent
  world.account.account_status = 3;
  await connect();
  const third = await newCampaign();
  assert.equal((await postDraft(third, specOf())).json.code, "PAYMENT_REQUIRED");

  const everything = [...logged, JSON.stringify(await AuditLog.find({}).lean()), JSON.stringify(await MetaPublish.find({}).lean())].join("\n");
  assert.ok(!everything.includes(TOKEN), "the token is in no log, audit entry or publish record");
  assert.ok(!everything.includes(LEAK));
  // the token travels only in the header, never in a URL or a body
  for (const post of world.posts) { assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`); assert.ok(!post.url.includes(TOKEN) && !post.body.includes(TOKEN)); }
});

it("the reader's new GETs and the geo search: only Egyptian governorates/cities, cached", async () => {
  await connect();
  const campaign = await newCampaign();
  const first = ok(await staff("GET", "/api/campaigns/meta-geo?q=القاهرة"));
  assert.deepEqual(first.data, [{ key: "2420", type: "region", name: "القاهرة", region: "" }], "the country row is dropped");
  const searches = () => world.gets.filter((g) => g.path === "search").length;
  const count = searches();
  ok(await staff("GET", "/api/campaigns/meta-geo?q=القاهرة"));
  assert.equal(searches(), count, "cached");
  assert.equal(world.gets.find((g) => g.path === "search").params.country_code, "EG");
  assert.ok(campaign);
  for (const get of world.gets) assert.equal(get.method, "GET");
});

// ---------------------------------------------------------------------------------------------------------------------
// the public /privacy text (owner-editable like the other texts)

it("the privacy text is saved like the other editable texts (trimmed, plain, at most 10000), blank clears it, and the public settings carry it", async () => {
  const put = (body) => staff("PUT", "/api/website/settings", { enabled: true, orderingEnabled: true, title: "متجر", ...body });
  assert.equal(ok(await call("GET", "/api/store/settings")).privacyPolicy, undefined, "closed or empty settings: nothing to read yet");
  ok(await put({ privacyPolicy: "  سياسة الخصوصية بتاعتنا\nمفيش بيانات بتتباع.  " }));
  assert.equal(ok(await staff("GET", "/api/website/settings")).privacyPolicy, "سياسة الخصوصية بتاعتنا\nمفيش بيانات بتتباع.");
  assert.equal(ok(await call("GET", "/api/store/settings")).privacyPolicy, "سياسة الخصوصية بتاعتنا\nمفيش بيانات بتتباع.");
  // markup stays text: it is stored as typed and the storefront prints it with interpolation (no innerHTML), checked below
  ok(await put({ privacyPolicy: "<script>alert(1)</script> نص" }));
  assert.equal(ok(await call("GET", "/api/store/settings")).privacyPolicy, "<script>alert(1)</script> نص");
  const source = require("node:fs").readFileSync(require.resolve("../../nota-storefront/src/app/pages/policy.ts"), "utf8");
  assert.ok(!/innerHTML|bypassSecurityTrust|\[innerHtml\]/i.test(source), "the storefront never renders the text as HTML");
  // over the limit / not a string
  assert.equal((await put({ privacyPolicy: "ا".repeat(10001) })).status, 400);
  assert.equal((await put({ privacyPolicy: { a: 1 } })).status, 400);
  ok(await put({ privacyPolicy: "ا".repeat(10000) }));
  // blank clears it (the storefront then writes its own text)
  ok(await put({ privacyPolicy: "   " }));
  assert.equal(ok(await call("GET", "/api/store/settings")).privacyPolicy, "");
});
