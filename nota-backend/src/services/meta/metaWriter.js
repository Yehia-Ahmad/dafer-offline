// Online Stage 7C: the ONLY code that sends a POST to Meta. metaClient.js stays GET only (its own test proves it).
//
// Safety, because this is the first code that can make the shop spend money:
//  - an allowlist: POST act_<id>/campaigns | adsets | adcreatives | ads | adimages for the shop's own ad account, and POST <object id>
//    only for an id that Nota's own publish records say Nota created, and only the fields status, daily_budget, lifetime_budget,
//    end_time, name. No DELETE (removing is status=DELETED), no business / user / page-post / catalog / audience / billing endpoint;
//  - writes go one at a time, never in parallel, with a pause between them (and a longer one when Meta says it is busy);
//  - errors carry a fixed code and a fixed Arabic message (never Meta's text, URL or the token). INVALID_PARAMETER adds the field name only;
//  - same Bearer header + appsecret_proof as the reader. Meta never takes money from Nota: no payment data and no billing endpoint here.
// Meta docs checked 2026-11-20: Marketing API v27.0 (campaign, ad set, ad creative, ad image, validate_only), error reference.
const { BASE_URL, REQUEST_TIMEOUT_MS, MetaError, graphVersion, readUsage, classify, proofOf, parseJson } = require("./metaClient");

const EDGES = ["campaigns", "adsets", "adcreatives", "ads", "adimages"];
const OBJECT_FIELDS = ["status", "daily_budget", "lifetime_budget", "end_time", "name"];
const OBJECT_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"];
const WRITE_GAP_MS = 1000;
const BUSY_GAP_MS = 5000;

const BUDGET_SUBCODES = new Set([1885272, 1885650, 1487901]);
const POLICY_SUBCODES = new Set([2490427, 2490468, 2708008]);
const PAYMENT_SUBCODES = new Set([1404163, 1404078, 2859015]);

const blamedField = (error) => {
  let data = error && error.error_data;
  if (typeof data === "string") data = parseJson(data);
  const specs = data && data.blame_field_specs;
  const first = Array.isArray(specs) && Array.isArray(specs[0]) ? specs[0][0] : Array.isArray(specs) ? specs[0] : "";
  return typeof first === "string" ? first : "";
};

/**
 * Meta's error object -> one of our fixed codes, from numbers only (code, subcode, blame_field_specs names), never the message.
 * `context.page` is true for the creative and ad steps, where a permission error is about the Page.
 */
const classifyWrite = (status, error, context = {}) => {
  const code = Number(error && error.code);
  const subcode = Number(error && error.error_subcode);
  const field = blamedField(error);
  if (subcode === 1885183) return { kind: "APP_NOT_LIVE" };
  if (BUDGET_SUBCODES.has(subcode)) return { kind: "BUDGET_TOO_LOW" };
  if (subcode === 1885621) return { kind: "BUDGET_CONFLICT" };
  if (subcode === 2238055) return /budget/i.test(field) ? { kind: "BUDGET_TOO_LOW" } : { kind: "INVALID_PARAMETER", field };
  if (subcode === 3858258) return { kind: "IMAGE_REJECTED" };
  if (POLICY_SUBCODES.has(subcode)) return { kind: "AD_POLICY" };
  if (PAYMENT_SUBCODES.has(subcode)) return { kind: "PAYMENT_REQUIRED" };
  if ([10, 200, 294].includes(code) || (code >= 200 && code <= 299)) return { kind: context.page ? "PAGE_NOT_ALLOWED" : "PUBLISH_PERMISSION_MISSING" };
  if (code === 100) return /image|hash/i.test(field) ? { kind: "IMAGE_REJECTED" } : { kind: "INVALID_PARAMETER", field };
  const read = classify(status, error);
  if (read === "ACCOUNT_NOT_FOUND") return { kind: "INVALID_PARAMETER", field };
  if (read === "PERMISSION_MISSING") return { kind: "PUBLISH_PERMISSION_MISSING" };
  return { kind: read };
};

/** The real transport: Node's fetch, POST only, form-encoded, with a timeout. Tests replace it with setTransport(). */
const realTransport = async (url, { method, headers, body }) => {
  if (method !== "POST") throw new Error("only POST is allowed here");
  const response = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  const outHeaders = {};
  response.headers.forEach((value, key) => { outHeaders[key.toLowerCase()] = value; });
  return { status: response.status, headers: outHeaders, body: parseJson(text) };
};

let transport = realTransport;
const setTransport = (fn) => { transport = fn || realTransport; };

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setSleep = (fn) => { sleep = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); };

// One queue for the whole process: two writers never send at the same time.
let queue = Promise.resolve();
let nextAllowedAt = 0;
let gapMs = WRITE_GAP_MS;
const enqueue = (task) => {
  const run = queue.then(async () => {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await task(); } finally { nextAllowedAt = Date.now() + gapMs; }
  });
  queue = run.catch(() => {});
  return run;
};

const refuse = () => new MetaError("PUBLISH_NOT_ALLOWED");

/**
 * A writer bound to one ad account and token.
 * `ownsObject(id)` is async and answers whether Nota's own publish records created that Meta object id (see metaPublish.service).
 */
const createWriter = ({ adAccountId, token, appSecret, onUsage, ownsObject }) => {
  const accountEdge = new RegExp(`^${adAccountId}/(${EDGES.join("|")})$`);

  /** Throws PUBLISH_NOT_ALLOWED for anything outside the allowlist. Runs before any request exists. */
  const authorize = async (path, params) => {
    const clean = String(path || "").replace(/^\//, "");
    if (accountEdge.test(clean)) return clean;
    if (/^\d{1,30}$/.test(clean)) {
      const keys = Object.keys(params || {});
      if (!keys.length || keys.some((key) => !OBJECT_FIELDS.includes(key))) throw refuse();
      if (params.status !== undefined && !OBJECT_STATUSES.includes(params.status)) throw refuse();
      if (!ownsObject || !(await ownsObject(clean))) throw refuse();
      return clean;
    }
    throw refuse();
  };

  const post = (path, params, context = {}) => enqueue(async () => {
    const clean = await authorize(path, params);
    const url = new URL(`${BASE_URL}/${graphVersion()}/${clean}`);
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null) continue;
      if (/token|proof/i.test(key)) throw refuse();
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    if (appSecret) form.set("appsecret_proof", proofOf(token, appSecret));
    const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` };
    let result;
    try {
      result = await transport(url.toString(), { method: "POST", headers, body: form.toString() });
    } catch {
      // The request may or may not have reached Meta: the caller must look for the object before sending it again.
      const error = new MetaError("NETWORK");
      error.unknownResult = true;
      throw error;
    }
    const usage = readUsage(result.headers);
    if (onUsage) onUsage(usage);
    gapMs = usage.busyPercent >= 75 || usage.waitSeconds > 0 ? BUSY_GAP_MS : WRITE_GAP_MS;
    const body = result.body;
    if (result.status >= 200 && result.status < 300 && body && !body.error) return { body, usage };
    if (result.status >= 500) {
      const error = new MetaError("NETWORK");
      error.unknownResult = true;
      throw error;
    }
    const { kind, field } = classifyWrite(result.status, body && body.error, context);
    throw new MetaError(kind, { field, retryAfterSeconds: kind === "RATE_LIMITED" ? Math.max(usage.waitSeconds, 300) : 0 });
  });

  const validateOnly = (params) => ({ ...params, execution_options: ["validate_only"] });
  const edge = (name) => `${adAccountId}/${name}`;

  return {
    /** validate_only variants create nothing. */
    validateCampaign: (params) => post(edge("campaigns"), validateOnly(params)),
    validateAdSet: (params) => post(edge("adsets"), validateOnly(params)),
    validateCreative: (params) => post(edge("adcreatives"), validateOnly(params), { page: true }),

    createCampaign: (params) => post(edge("campaigns"), params),
    createAdSet: (params) => post(edge("adsets"), params),
    createCreative: (params) => post(edge("adcreatives"), params, { page: true }),
    createAd: (params) => post(edge("ads"), params, { page: true }),
    /** `bytes` is the image as base64. The same bytes always give the same hash, so repeating this is safe. */
    uploadImage: (bytes) => post(edge("adimages"), { bytes }),

    /** POST <id> with status / budget / end_time / name, only for ids Nota created. */
    updateObject: (objectId, fields) => post(String(objectId), fields),
  };
};

module.exports = { createWriter, setTransport, setSleep, classifyWrite, EDGES, OBJECT_FIELDS };
