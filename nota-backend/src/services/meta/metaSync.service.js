// Online Stage 7B: reads the shop's Meta ad account into MetaCampaign and MetaInsightDay. Read-only toward Meta (GET only) and it
// posts nothing in Nota: the synced numbers are only ever read by the marketing results.
//
// Modes: "backfill" (last 90 days, after connecting), "daily" (last 7 days: Meta keeps revising recent numbers) and "manual"
// (the «مزامنة دلوقتي» button, same window as daily). A Mongo lease keeps two syncs (CLI + HTTP, separate processes) from running at once.
const os = require("node:os");
const MetaConnection = require("../../models/metaConnection.model");
const MetaCampaign = require("../../models/metaCampaign.model");
const MetaInsightDay = require("../../models/metaInsightDay.model");
const secretBox = require("../../utils/secretBox");
const clock = require("../../utils/clock");
const { createClient, MetaError } = require("./metaClient");
const { parseMinor, parseCount } = require("./metaMoney");

const LEASE_MS = 10 * 60 * 1000;
const BACKFILL_DAYS = 90;
const RESYNC_DAYS = 7;
const WINDOW_DAYS = 30;
const MANUAL_GAP_MS = 5 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setSleep = (fn) => { sleep = fn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); };

const addDays = (day, count) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

/** [{since, until}] windows of at most WINDOW_DAYS covering the last `days` days up to today (the shop's local day). */
const windowsFor = (days) => {
  const today = clock.localDayString(clock.now());
  const first = addDays(today, -(days - 1));
  const windows = [];
  for (let since = first; since <= today; since = addDays(since, WINDOW_DAYS)) {
    const until = addDays(since, WINDOW_DAYS - 1);
    windows.push({ since, until: until > today ? today : until });
  }
  return windows;
};

const ownerId = () => `${os.hostname()}:${process.pid}`;

/** Takes the lease or returns null when another sync holds it. */
const acquireLease = async (owner) => {
  const now = clock.now();
  return MetaConnection.findOneAndUpdate(
    { _id: "default", $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }, { lockedUntil: { $exists: false } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS), lockOwner: owner } },
    { new: true }
  );
};

const releaseLease = (owner) => MetaConnection.updateOne({ _id: "default", lockOwner: owner }, { $set: { lockedUntil: null, lockOwner: null } });

/** The decrypted credentials of a connection (never logged, never returned by an endpoint). */
const credentialsOf = (connection) => ({
  adAccountId: connection.adAccountId,
  token: secretBox.open(connection.tokenSealed, "meta-token"),
  appSecret: connection.appSecretSealed ? secretBox.open(connection.appSecretSealed, "meta-app-secret") : undefined,
});

const clientFor = (connection, options = {}) => createClient({ ...credentialsOf(connection), ...options });

/**
 * How far back this run reads. A run with no completed backfill (the first one failed half way, for example on a rate limit) is a
 * backfill. Otherwise the window reaches back to the last successful sync plus 7 days (Meta revises recent numbers), at least 7 and at most
 * 90 days, so a server that was off for two weeks catches up.
 */
const syncPlan = (connection, mode) => {
  if (mode === "backfill" || !connection.lastBackfillAt) return { mode: "backfill", days: BACKFILL_DAYS };
  const today = clock.localDayString(clock.now());
  const last = connection.lastSyncOkAt ? clock.localDayString(connection.lastSyncOkAt) : null;
  const gap = last ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000)) : BACKFILL_DAYS;
  return { mode, days: Math.min(BACKFILL_DAYS, Math.max(RESYNC_DAYS, gap + RESYNC_DAYS)) };
};

const upsertCampaigns = async (rows, adAccountId) => {
  if (!rows.length) return;
  const syncedAt = clock.now();
  await MetaCampaign.bulkWrite(rows.filter((row) => row && row.id).map((row) => ({
    updateOne: {
      filter: { metaId: String(row.id) },
      update: { $set: { adAccountId, name: String(row.name || ""), status: row.status, effectiveStatus: row.effective_status, objective: row.objective, createdTime: row.created_time ? new Date(row.created_time) : undefined, syncedAt } },
      upsert: true,
    },
  })));
};

const upsertInsights = async (rows, currency, adAccountId) => {
  const valid = rows.filter((row) => row && row.campaign_id && DAY_RE.test(String(row.date_start || "")));
  if (!valid.length) return 0;
  // A campaign seen only in insights (not in the campaigns list) still gets a row, so its spend is never hidden.
  await MetaCampaign.bulkWrite(valid.map((row) => ({
    updateOne: { filter: { metaId: String(row.campaign_id) }, update: { $setOnInsert: { metaId: String(row.campaign_id), adAccountId, name: String(row.campaign_name || "") } }, upsert: true },
  })));
  await MetaInsightDay.bulkWrite(valid.map((row) => ({
    updateOne: {
      filter: { metaId: String(row.campaign_id), day: row.date_start },
      update: { $set: { adAccountId, currency, spendMinor: parseMinor(row.spend) || 0, impressions: parseCount(row.impressions), reach: parseCount(row.reach), clicks: parseCount(row.clicks), linkClicks: parseCount(row.inline_link_clicks) } },
      upsert: true,
    },
  })));
  return valid.length;
};

const accountFields = (account) => ({
  name: account.name || "",
  currency: String(account.currency || "").toUpperCase(),
  timezoneName: account.timezone_name || "",
  accountStatus: Number(account.account_status),
  disableReason: Number(account.disable_reason) || 0,
});

/**
 * Runs one sync. Returns { status: "ok" | "busy" | "skipped" | "failed", reason?, code?, rows? }.
 * It never throws for a Meta problem: the problem is stored on the connection (fixed code and message) and returned.
 */
const runSync = async ({ mode = "daily" } = {}) => {
  const owner = ownerId();
  let connection = await MetaConnection.findById("default").lean();
  if (!connection || !connection.connected || !connection.tokenSealed) return { status: "skipped", reason: "NOT_CONNECTED" };
  if (mode === "daily" && connection.paused) return { status: "skipped", reason: "PAUSED" };
  if (connection.retryAfter && connection.retryAfter > clock.now() && mode !== "backfill") return { status: "skipped", reason: "BACKING_OFF" };

  connection = await acquireLease(owner);
  if (!connection) return { status: "busy" };
  try {
    const client = clientFor(connection);
    const pageDelay = async (usage) => { await sleep(Math.min(30, Math.max(1, usage.waitSeconds || 2)) * 1000); };

    const account = await client.account();
    const info = accountFields(account);
    // The account status never pauses the sync: insights of a disabled or unsettled account are still wanted. It shows as a banner.
    await MetaConnection.updateOne({ _id: "default" }, { $set: { account: info } });

    const plan = syncPlan(connection, mode);
    await upsertCampaigns(await client.campaigns({ pageDelay }), connection.adAccountId);
    let rows = 0;
    for (const window of windowsFor(plan.days)) {
      rows += await upsertInsights(await client.insights(window.since, window.until, { pageDelay }), info.currency, connection.adAccountId);
    }
    const now = clock.now();
    await MetaConnection.updateOne({ _id: "default" }, {
      $set: { lastSyncAt: now, lastSyncOkAt: now, lastError: null, retryAfter: null, ...(plan.mode === "backfill" ? { lastBackfillAt: now } : {}) },
    });
    return { status: "ok", rows };
  } catch (error) {
    const known = error instanceof MetaError ? error : error && error.code === "SECRETS_KEY_MISSING" ? new MetaError("SECRETS_KEY_MISSING") : new MetaError("META_ERROR");
    const now = clock.now();
    const set = { lastSyncAt: now, lastError: { code: known.code, message: known.message, at: now } };
    if (known.pausesSync) set.paused = true;
    if (known.code === "RATE_LIMITED") set.retryAfter = new Date(now.getTime() + known.retryAfterSeconds * 1000);
    await MetaConnection.updateOne({ _id: "default" }, { $set: set });
    return { status: "failed", code: known.code };
  } finally {
    await releaseLease(owner).catch(() => {});
  }
};

// The HTTP button / connect run in the background; tests await idle().
let inflight = Promise.resolve();
const startInBackground = (mode) => {
  inflight = runSync({ mode }).catch(() => ({ status: "failed" }));
  return inflight;
};
const idle = async () => { await inflight; };

module.exports = { runSync, startInBackground, idle, setSleep, windowsFor, syncPlan, addDays, credentialsOf, clientFor, MANUAL_GAP_MS, BACKFILL_DAYS, RESYNC_DAYS, WINDOW_DAYS };
