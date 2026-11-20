// Online Stage 7B: the ONLY code that talks to Meta. Read-only by construction:
//  - every request is a GET (the transport refuses anything else),
//  - nothing about customers is ever sent (only the ad account id, field lists and date ranges),
//  - the token travels in an Authorization header (never in a URL) except for /debug_token, where Meta wants it as a parameter,
//  - errors carry a fixed code and a fixed Arabic message, never Meta's text, never the URL, never the token.
// Meta docs: Marketing API Insights, rate limiting (X-Business-Use-Case-Usage, X-Ad-Account-Usage, X-FB-Ads-Insights-Throttle),
// error reference, Graph API secure requests (appsecret_proof) and debug_token. Checked 2026-11-20.
const crypto = require("node:crypto");

const BASE_URL = "https://graph.facebook.com";
const DEFAULT_VERSION = "v27.0";
const REQUEST_TIMEOUT_MS = 30000;

const graphVersion = () => {
  const configured = String(process.env.NOTA_META_GRAPH_VERSION || "").trim();
  return /^v\d{1,3}\.\d{1,2}$/.test(configured) ? configured : DEFAULT_VERSION;
};

// kind -> { code, message }. These are the only texts that leave this module.
const FAILURES = {
  TOKEN_INVALID: "التوكن غير صالح أو انتهت صلاحيته. اعمل توكن جديد وابعته في الربط.",
  PERMISSION_MISSING: "التوكن ناقصه صلاحية ads_read أو الحساب مش متاح للمستخدم. راجع الصلاحيات.",
  RATE_LIMITED: "ميتا طلبت نستنى شوية (حد الاستخدام). هنحاول تاني لوحدنا.",
  ACCOUNT_NOT_FOUND: "رقم حساب الإعلانات غير صحيح أو غير متاح للتوكن ده.",
  NETWORK: "تعذر الاتصال بميتا. هنحاول تاني.",
  META_ERROR: "ميتا رجّعت خطأ غير متوقع.",
  SECRETS_KEY_MISSING: "مفتاح تشفير السيرفر (NOTA_SECRETS_KEY) مش مظبوط.",
};

class MetaError extends Error {
  constructor(code, { retryAfterSeconds = 0 } = {}) {
    super(FAILURES[code] || FAILURES.META_ERROR);
    this.name = "MetaError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  /** These two stop the daily sync until the owner reconnects. */
  get pausesSync() { return this.code === "TOKEN_INVALID" || this.code === "PERMISSION_MISSING"; }
}

const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const TOKEN_CODES = new Set([102, 104, 190]);

/** Meta's error object -> one of our fixed codes. Only numbers are read, never the message. */
const classify = (status, error) => {
  const code = Number(error && error.code);
  const subcode = Number(error && error.error_subcode);
  if (TOKEN_CODES.has(code)) return "TOKEN_INVALID";
  if (RATE_CODES.has(code) || subcode === 1504022 || subcode === 1504039) return "RATE_LIMITED";
  if (code === 10 || (code >= 200 && code <= 299) || subcode === 3191001) return "PERMISSION_MISSING";
  if (code === 100 && status === 400) return "ACCOUNT_NOT_FOUND";
  if (status === 401) return "TOKEN_INVALID";
  if (status === 403) return "PERMISSION_MISSING";
  if (status === 429) return "RATE_LIMITED";
  return "META_ERROR";
};

const parseJson = (value) => { try { return JSON.parse(value); } catch { return null; } };

/**
 * Meta's usage headers -> { busyPercent, waitSeconds }. busyPercent is the highest utilisation seen (0-100);
 * waitSeconds is how long Meta says to stay away (0 when not blocked).
 */
const readUsage = (headers = {}) => {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];
  let busy = 0;
  let wait = 0;
  const account = parseJson(get("x-ad-account-usage"));
  if (account) {
    busy = Math.max(busy, Number(account.acc_id_util_pct) || 0);
    if ((Number(account.acc_id_util_pct) || 0) >= 100) wait = Math.max(wait, Number(account.reset_time_duration) || 0);
  }
  const throttle = parseJson(get("x-fb-ads-insights-throttle"));
  if (throttle) busy = Math.max(busy, Number(throttle.acc_id_util_pct) || 0, Number(throttle.app_id_util_pct) || 0);
  const business = parseJson(get("x-business-use-case-usage"));
  if (business && typeof business === "object") {
    for (const entries of Object.values(business)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        busy = Math.max(busy, Number(entry.call_count) || 0, Number(entry.total_cputime) || 0, Number(entry.total_time) || 0);
        wait = Math.max(wait, (Number(entry.estimated_time_to_regain_access) || 0) * 60);
      }
    }
  }
  const app = parseJson(get("x-app-usage"));
  if (app) busy = Math.max(busy, Number(app.call_count) || 0, Number(app.total_cputime) || 0, Number(app.total_time) || 0);
  return { busyPercent: busy, waitSeconds: wait };
};

/** The real transport: Node's fetch, GET only, with a timeout. Tests replace it with setTransport(). */
const realTransport = async (url, { method, headers }) => {
  if (method !== "GET") throw new Error("only GET is allowed");
  const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  const outHeaders = {};
  response.headers.forEach((value, key) => { outHeaders[key.toLowerCase()] = value; });
  return { status: response.status, headers: outHeaders, body: parseJson(text) };
};

let transport = realTransport;
const setTransport = (fn) => { transport = fn || realTransport; };

const proofOf = (token, appSecret) => crypto.createHmac("sha256", appSecret).update(token).digest("hex");

const normalizeAccountId = (value) => {
  const match = /^(?:act_)?(\d{5,20})$/.exec(String(value || "").trim());
  return match ? `act_${match[1]}` : null;
};

/** A client bound to one ad account and token. `onUsage({busyPercent, waitSeconds})` is told about every response. */
const createClient = ({ adAccountId, token, appSecret, onUsage }) => {
  const request = async (path, params = {}, { tokenAsParam = false } = {}) => {
    const url = new URL(`${BASE_URL}/${graphVersion()}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const headers = { Accept: "application/json" };
    if (tokenAsParam) url.searchParams.set("input_token", token);
    headers.Authorization = `Bearer ${token}`;
    if (appSecret) url.searchParams.set("appsecret_proof", proofOf(token, appSecret));
    let result;
    try {
      result = await transport(url.toString(), { method: "GET", headers });
    } catch {
      throw new MetaError("NETWORK");
    }
    const usage = readUsage(result.headers);
    if (onUsage) onUsage(usage);
    const body = result.body;
    if (result.status >= 200 && result.status < 300 && body && !body.error) return { body, usage };
    if (result.status >= 500) throw new MetaError("NETWORK");
    const kind = classify(result.status, body && body.error);
    throw new MetaError(kind, { retryAfterSeconds: kind === "RATE_LIMITED" ? Math.max(usage.waitSeconds, 300) : 0 });
  };

  /** Follows cursors (never the `next` URL, which carries the token) and returns every row. */
  const getAll = async (path, params, { pageDelay } = {}) => {
    const rows = [];
    let after;
    for (let page = 0; page < 200; page += 1) {
      const { body, usage } = await request(path, { ...params, ...(after ? { after } : {}) });
      rows.push(...(Array.isArray(body.data) ? body.data : []));
      const next = body.paging && body.paging.next && body.paging.cursors && body.paging.cursors.after;
      if (!next) break;
      after = body.paging.cursors.after;
      if (pageDelay && usage.busyPercent >= 75) await pageDelay(usage);
    }
    return rows;
  };

  return {
    /** GET /act_<id>?fields=name,currency,timezone_name,account_status,disable_reason */
    account: async () => (await request(adAccountId, { fields: "name,currency,timezone_name,account_status,disable_reason" })).body,

    /** The token's granted scopes: /debug_token first, /me/permissions when Meta refuses it for this kind of token. */
    permissions: async () => {
      try {
        const { body } = await request("debug_token", {}, { tokenAsParam: true });
        const data = body.data || {};
        if (data.is_valid === false) throw new MetaError("TOKEN_INVALID");
        return { scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [], expiresAt: data.expires_at ? Number(data.expires_at) : 0, source: "debug_token" };
      } catch (error) {
        if (!(error instanceof MetaError) || error.code === "TOKEN_INVALID" || error.code === "NETWORK" || error.code === "RATE_LIMITED") throw error;
      }
      const { body } = await request("me/permissions", {});
      const scopes = (Array.isArray(body.data) ? body.data : []).filter((row) => row.status === "granted").map((row) => String(row.permission));
      return { scopes, expiresAt: 0, source: "me/permissions" };
    },

    /** GET /act_<id>/campaigns (every status, so archived campaigns keep their name for old insights). */
    campaigns: (options) => getAll(`${adAccountId}/campaigns`, {
      fields: "id,name,status,effective_status,objective,created_time",
      effective_status: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED"],
      limit: 200,
    }, options),

    /** GET /act_<id>/insights, one row per Meta campaign and day. */
    insights: (since, until, options) => getAll(`${adAccountId}/insights`, {
      level: "campaign",
      time_increment: 1,
      time_range: { since, until },
      fields: "campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,date_start,date_stop",
      limit: 500,
    }, options),
  };
};

module.exports = { createClient, setTransport, MetaError, FAILURES, normalizeAccountId, graphVersion, readUsage, classify, proofOf, DEFAULT_VERSION };
