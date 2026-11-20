// Online Stage 7B: the connection of the shop's Meta ad account and the exchange-rate history. All of it needs marketing.connect
// (owner only by default) except reading the rates. The token and app secret go in once, are stored encrypted and are never returned:
// only their last 4 characters. Nothing here calls Meta with anything but a GET.
const asyncHandler = require("../utils/asyncHandler");
const { httpError } = require("../auth/middleware");
const MetaConnection = require("../models/metaConnection.model");
const ExchangeRate = require("../models/exchangeRate.model");
const AuditLog = require("../models/auditLog.model");
const secretBox = require("../utils/secretBox");
const clock = require("../utils/clock");
const { createClient, normalizeAccountId, MetaError } = require("../services/meta/metaClient");
const sync = require("../services/meta/metaSync.service");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_STATUSES = new Set([1, 9]); // ACTIVE, IN_GRACE_PERIOD

const metaFailure = (error) => {
  if (error instanceof MetaError) return httpError(error.code === "RATE_LIMITED" ? 429 : 400, error.code, error.message);
  if (error && error.code === "SECRETS_KEY_MISSING") return httpError(500, "SECRETS_KEY_MISSING", new MetaError("SECRETS_KEY_MISSING").message);
  return httpError(502, "META_ERROR", new MetaError("META_ERROR").message);
};

const text = (value, max) => String(value === undefined || value === null ? "" : value).trim().slice(0, max);

/** The connection as the browser may see it: no token, no app secret, only their last 4 characters. */
const view = (connection) => {
  const c = connection || {};
  const now = clock.now();
  const nextManual = c.lastManualSyncAt ? new Date(c.lastManualSyncAt.getTime() + sync.MANUAL_GAP_MS) : null;
  return {
    connected: Boolean(c.connected),
    adAccountId: c.connected ? c.adAccountId : null,
    tokenLast4: c.connected ? c.tokenLast4 || null : null,
    hasAppSecret: Boolean(c.connected && c.appSecretSealed),
    appSecretLast4: c.connected ? c.appSecretLast4 || null : null,
    account: c.connected && c.account ? { name: c.account.name, currency: c.account.currency, timezoneName: c.account.timezoneName, accountStatus: c.account.accountStatus, disableReason: c.account.disableReason } : null,
    accountStatusWarning: Boolean(c.connected && c.account && Number.isFinite(c.account.accountStatus) && !ACTIVE_STATUSES.has(c.account.accountStatus)),
    scopes: c.connected ? c.scopes || [] : [],
    connectedAt: c.connectedAt || null,
    lastSyncAt: c.lastSyncAt || null,
    lastSyncOkAt: c.lastSyncOkAt || null,
    lastError: c.lastError && c.lastError.code ? { code: c.lastError.code, message: c.lastError.message, at: c.lastError.at } : null,
    paused: Boolean(c.paused),
    syncing: Boolean(c.lockedUntil && c.lockedUntil > now),
    nextManualSyncAt: nextManual && nextManual > now ? nextManual : null,
  };
};

// Reads the credentials sent in a request, or falls back to the saved ones (to re-test the current connection).
const credentialsFrom = async (body) => {
  const saved = await MetaConnection.findById("default").lean();
  const adAccountId = normalizeAccountId(body && body.adAccountId !== undefined && body.adAccountId !== "" ? body.adAccountId : saved && saved.adAccountId);
  if (!adAccountId) throw httpError(400, "INVALID_ACCOUNT_ID", "رقم حساب الإعلانات غير صحيح (act_ وبعده أرقام)");
  const sentToken = text(body && body.token, 1000);
  const token = sentToken || (saved && saved.connected && saved.tokenSealed ? secretBox.open(saved.tokenSealed, "meta-token") : "");
  if (!token || /\s/.test(token) || token.length < 20) throw httpError(400, "INVALID_TOKEN", "التوكن مطلوب (نص طويل من غير مسافات)");
  const sentSecret = text(body && body.appSecret, 200);
  const appSecret = sentSecret || (!sentToken && saved && saved.appSecretSealed ? secretBox.open(saved.appSecretSealed, "meta-app-secret") : "");
  if (sentSecret && /\s/.test(sentSecret)) throw httpError(400, "INVALID_APP_SECRET", "سر التطبيق غير صالح");
  return { adAccountId, token, appSecret: appSecret || undefined };
};

// Calls Meta (GET only): the account and the token's permissions. Throws a MetaError for any problem.
const probe = async (credentials) => {
  const client = createClient(credentials);
  const account = await client.account();
  const permissions = await client.permissions();
  const hasAdsRead = permissions.scopes.includes("ads_read");
  return {
    account: {
      name: String(account.name || ""),
      currency: String(account.currency || "").toUpperCase(),
      timezoneName: String(account.timezone_name || ""),
      accountStatus: Number(account.account_status),
      disableReason: Number(account.disable_reason) || 0,
    },
    scopes: permissions.scopes,
    expiresAt: permissions.expiresAt,
    hasAdsRead,
  };
};

const get = asyncHandler(async (_req, res) => res.json(view(await MetaConnection.findById("default").lean())));

// POST /api/website/meta-connection/test  { adAccountId, token?, appSecret? }  ("اختبار الربط"). Nothing is saved.
const test = asyncHandler(async (req, res) => {
  const credentials = await credentialsFrom(req.body);
  let result;
  try { result = await probe(credentials); } catch (error) { throw metaFailure(error); }
  res.json({ ok: result.hasAdsRead, account: result.account, accountStatusWarning: !ACTIVE_STATUSES.has(result.account.accountStatus), scopes: result.scopes, hasAdsRead: result.hasAdsRead, neverExpires: !result.expiresAt, expiresAt: result.expiresAt ? new Date(result.expiresAt * 1000) : null });
});

// PUT /api/website/meta-connection  { adAccountId, token, appSecret? }. Saving is only allowed after a successful test: the server runs it again.
const save = asyncHandler(async (req, res) => {
  const credentials = await credentialsFrom(req.body);
  if (!req.body || !text(req.body.token, 1000)) throw httpError(400, "INVALID_TOKEN", "التوكن مطلوب");
  let result;
  try { result = await probe(credentials); } catch (error) { throw metaFailure(error); }
  if (!result.hasAdsRead) throw httpError(400, "PERMISSION_MISSING", new MetaError("PERMISSION_MISSING").message);
  let tokenSealed;
  let appSecretSealed;
  try {
    tokenSealed = secretBox.seal(credentials.token, "meta-token");
    appSecretSealed = credentials.appSecret ? secretBox.seal(credentials.appSecret, "meta-app-secret") : undefined;
  } catch (error) { throw metaFailure(error); }
  const now = clock.now();
  const previous = await MetaConnection.findById("default").lean();
  const sameAccount = previous && previous.adAccountId === credentials.adAccountId;
  await MetaConnection.findOneAndUpdate({ _id: "default" }, {
    $set: {
      connected: true, adAccountId: credentials.adAccountId, tokenSealed, tokenLast4: secretBox.last4(credentials.token),
      appSecretSealed: appSecretSealed || null, appSecretLast4: credentials.appSecret ? secretBox.last4(credentials.appSecret) : null,
      account: result.account, scopes: result.scopes, connectedAt: now, paused: false, lastError: null, retryAfter: null,
    },
  }, { upsert: true, new: true });
  // A first connection (or a different account) backfills 90 days; reconnecting the same account only re-syncs the last days.
  sync.startInBackground(sameAccount && previous.lastBackfillAt ? "manual" : "backfill");
  res.json(view(await MetaConnection.findById("default").lean()));
});

// DELETE /api/website/meta-connection  («فصل الحساب»): the token and app secret are removed and syncing stops; synced data stays.
const disconnect = asyncHandler(async (req, res) => {
  await MetaConnection.updateOne({ _id: "default" }, {
    $set: { connected: false, paused: false, lastError: null, retryAfter: null },
    $unset: { tokenSealed: "", tokenLast4: "", appSecretSealed: "", appSecretLast4: "" },
  });
  res.json(view(await MetaConnection.findById("default").lean()));
});

// POST /api/website/meta-connection/sync  («مزامنة دلوقتي»): once per 5 minutes, runs in the background.
const syncNow = asyncHandler(async (_req, res) => {
  const now = clock.now();
  const connection = await MetaConnection.findById("default").lean();
  if (!connection || !connection.connected) throw httpError(409, "NOT_CONNECTED", "حساب الإعلانات غير مربوط");
  if (connection.lockedUntil && connection.lockedUntil > now) throw httpError(409, "SYNC_RUNNING", "المزامنة شغالة دلوقتي");
  const claimed = await MetaConnection.updateOne(
    { _id: "default", $or: [{ lastManualSyncAt: null }, { lastManualSyncAt: { $exists: false } }, { lastManualSyncAt: { $lte: new Date(now.getTime() - sync.MANUAL_GAP_MS) } }] },
    { $set: { lastManualSyncAt: now } }
  );
  if (!claimed.modifiedCount) {
    const wait = Math.max(1, Math.ceil((connection.lastManualSyncAt.getTime() + sync.MANUAL_GAP_MS - now.getTime()) / 1000));
    res.set("Retry-After", String(wait));
    const tooSoon = httpError(429, "SYNC_TOO_SOON", "المزامنة اتعملت من شوية، جرب بعد 5 دقايق");
    tooSoon.responseData.retryAfterSeconds = wait;
    throw tooSoon;
  }
  sync.startInBackground("manual");
  res.status(202).json(view(await MetaConnection.findById("default").lean()));
});

// ----- exchange rates (only meaningful when the ad account currency is not EGP) -----
const rateView = (row) => ({ _id: row._id, currency: row.currency, rate: row.rate, effectiveFrom: row.effectiveFrom, createdByName: row.createdByName || "" });

const accountCurrency = async () => {
  const connection = await MetaConnection.findById("default").lean();
  return connection && connection.account && connection.account.currency ? connection.account.currency : null;
};

const listRates = asyncHandler(async (_req, res) => {
  const currency = await accountCurrency();
  const rows = currency ? await ExchangeRate.find({ currency }).sort({ effectiveFrom: -1 }).lean() : [];
  res.json({ currency, required: Boolean(currency && currency !== "EGP"), data: rows.map(rateView) });
});

const saveRate = asyncHandler(async (req, res) => {
  const currency = await accountCurrency();
  if (!currency || currency === "EGP") throw httpError(409, "RATE_NOT_NEEDED", "حساب الإعلانات بالجنيه، مفيش حاجة لسعر الصرف");
  const rate = Number(req.body && req.body.rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1e6 || Math.round(rate * 1e6) / 1e6 !== rate) throw httpError(400, "INVALID_RATE", "سعر الصرف غير صالح (رقم موجب، لحد 6 أرقام عشرية)");
  const effectiveFrom = text(req.body && req.body.effectiveFrom, 10);
  if (!DAY_RE.test(effectiveFrom) || Number.isNaN(Date.parse(`${effectiveFrom}T00:00:00Z`))) throw httpError(400, "INVALID_DATE", "تاريخ السريان غير صالح");
  const row = await ExchangeRate.findOneAndUpdate({ currency, effectiveFrom }, { $set: { rate, createdByName: req.user && req.user.name } }, { upsert: true, new: true });
  res.status(201).json(rateView(row));
});

const deleteRate = asyncHandler(async (req, res) => {
  const row = await ExchangeRate.findByIdAndDelete(req.params.id).catch(() => null);
  if (!row) throw httpError(404, "RATE_NOT_FOUND", "السعر غير موجود");
  res.json({ ok: true });
});

/** Connect / disconnect are logged by the route (key names only). The daily CLI has no request, so it writes directly when needed. */
const auditDirect = (entry) => AuditLog.create({ at: new Date(), ...entry }).catch(() => {});

module.exports = { get, test, save, disconnect, syncNow, listRates, saveRate, deleteRate, view, auditDirect };
