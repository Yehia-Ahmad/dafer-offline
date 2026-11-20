// Online Stage 7B: the synced Meta numbers shaped for the marketing results. Read-only: it only reads MetaConnection, MetaCampaign,
// MetaInsightDay and ExchangeRate. Nothing is posted and no price changes.
//
// Money: insights are integer minor units of THEIR OWN currency (the ad account's currency when the row was synced; a shop that replaced
// a disabled account can hold several). Each row converts with the rate of its currency effective that day (EGP = 1). A row with no rate
// keeps its original amount and marks the figures "needs a rate".
const MetaConnection = require("../../models/metaConnection.model");
const MetaCampaign = require("../../models/metaCampaign.model");
const MetaInsightDay = require("../../models/metaInsightDay.model");
const ExchangeRate = require("../../models/exchangeRate.model");
const { rateOn, convertMinor, toMoney } = require("./metaMoney");

const SHOP_ZONE = "Africa/Cairo";
const NUMBER_KEYS = ["egpMinor", "missingRateMinor", "impressions", "reach", "clicks", "linkClicks"];

const emptyFold = () => ({ egpMinor: 0, missingRateMinor: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, originals: {}, missing: {}, perDay: new Map() });

const addTo = (target, key, amount) => { target[key] = (target[key] || 0) + amount; };

/** Adds `source` (a fold) into `target` (a fold). */
const mergeFold = (target, source) => {
  for (const key of NUMBER_KEYS) target[key] += source[key];
  for (const [currency, minor] of Object.entries(source.originals)) addTo(target.originals, currency, minor);
  for (const [currency, minor] of Object.entries(source.missing)) addTo(target.missing, currency, minor);
  for (const [day, value] of source.perDay) {
    const current = target.perDay.get(day) || { egpMinor: 0, missingRate: false };
    current.egpMinor += value.egpMinor;
    current.missingRate = current.missingRate || value.missingRate;
    target.perDay.set(day, current);
  }
  return target;
};

/**
 * Days of one Meta campaign -> a fold. `ratesByCurrency` is { USD: [{rate, effectiveFrom}], ... }; a row's own `currency` decides how it
 * converts (`fallbackCurrency` for old rows that have none).
 */
const foldDays = (days, ratesByCurrency, fallbackCurrency = "EGP") => {
  const out = emptyFold();
  for (const row of days) {
    const currency = String(row.currency || fallbackCurrency || "EGP").toUpperCase();
    const rate = currency === "EGP" ? { rate: 1 } : rateOn((ratesByCurrency || {})[currency], row.day);
    const egp = rate ? convertMinor(row.spendMinor, rate.rate) : 0;
    addTo(out.originals, currency, row.spendMinor);
    if (rate) out.egpMinor += egp; else { out.missingRateMinor += row.spendMinor; addTo(out.missing, currency, row.spendMinor); }
    out.impressions += row.impressions; out.reach += row.reach; out.clicks += row.clicks; out.linkClicks += row.linkClicks;
    const perDay = out.perDay.get(row.day) || { egpMinor: 0, missingRate: false };
    if (rate) perDay.egpMinor += egp; else perDay.missingRate = true;
    out.perDay.set(row.day, perDay);
  }
  return out;
};

/**
 * The original (not converted) amount to show next to a figure: the currency that still lacks a rate first, else the account's current
 * currency when present, else any. `originals`/`missing` are { CUR: minor }.
 */
const pickOriginal = (originals, missing, currentCurrency) => {
  const missingCurrency = Object.keys(missing || {}).find((currency) => missing[currency] > 0);
  const currency = missingCurrency || (originals && originals[currentCurrency] !== undefined ? currentCurrency : Object.keys(originals || {})[0]) || currentCurrency;
  return { currency, amount: toMoney((originals || {})[currency] || 0) };
};

/** The set of non-EGP currencies the shop may need a rate for: those of its synced insights and of the current account. */
const rateCurrencies = async () => {
  const connection = await MetaConnection.findById("default").select("account.currency").lean();
  const found = await MetaInsightDay.distinct("currency");
  const set = new Set(found.filter(Boolean).map((currency) => String(currency).toUpperCase()));
  if (connection && connection.account && connection.account.currency) set.add(String(connection.account.currency).toUpperCase());
  set.delete("EGP");
  return [...set].sort();
};

/** A filter for Meta campaigns of the CURRENT ad account (rows without an account id count as current). null = no filter. */
const currentAccountFilter = (connection) => (connection && connection.adAccountId ? { $or: [{ adAccountId: connection.adAccountId }, { adAccountId: null }] } : {});

/**
 * @param {{from:string,to:string}} range  Meta days are compared as plain strings
 * @param {{campaignIds:string[], withUnlinked:boolean}} scope
 * @returns {null | {state, linked: Map<string, figures>, unlinked: object[]}}  null when Meta was never connected
 */
const metaFigures = async (range, { campaignIds, withUnlinked }) => {
  const connection = await MetaConnection.findById("default").lean();
  const anyCampaign = connection ? true : await MetaCampaign.exists({});
  if (!connection && !anyCampaign) return null;

  const currency = connection && connection.account && connection.account.currency ? String(connection.account.currency).toUpperCase() : "EGP";
  const [metaCampaigns, insights] = await Promise.all([
    MetaCampaign.find({}).select("metaId name status effectiveStatus campaignId adAccountId").lean(),
    MetaInsightDay.find({ day: { $gte: range.from, $lte: range.to } }).lean(),
  ]);
  const currencies = new Set(insights.map((row) => String(row.currency || currency).toUpperCase()));
  currencies.delete("EGP");
  const rateRows = currencies.size ? await ExchangeRate.find({ currency: { $in: [...currencies] } }).select("currency rate effectiveFrom").lean() : [];
  const ratesByCurrency = {};
  for (const row of rateRows) (ratesByCurrency[row.currency] = ratesByCurrency[row.currency] || []).push(row);

  const daysByMeta = new Map();
  for (const row of insights) {
    if (!daysByMeta.has(row.metaId)) daysByMeta.set(row.metaId, []);
    daysByMeta.get(row.metaId).push(row);
  }

  const wanted = new Set(campaignIds.map(String));
  const linked = new Map();
  const unlinked = [];
  const accountId = connection && connection.adAccountId;
  for (const meta of metaCampaigns) {
    const days = daysByMeta.get(meta.metaId) || [];
    const owner = meta.campaignId ? String(meta.campaignId) : null;
    if (owner) {
      // A campaign of an OLD ad account that is still linked keeps counting in its Nota campaign.
      if (!wanted.has(owner)) continue;
      if (!linked.has(owner)) linked.set(owner, { ...emptyFold(), metaIds: [] });
      const total = linked.get(owner);
      mergeFold(total, foldDays(days, ratesByCurrency, currency));
      total.metaIds.push(meta.metaId);
    } else if (withUnlinked && days.length && (!accountId || !meta.adAccountId || meta.adAccountId === accountId)) {
      const fold = foldDays(days, ratesByCurrency, currency);
      const original = pickOriginal(fold.originals, fold.missing, currency);
      unlinked.push({
        metaId: meta.metaId, name: meta.name, status: meta.effectiveStatus || meta.status || "",
        spend: toMoney(fold.egpMinor), originalSpend: original.amount, originalCurrency: original.currency, needsRate: fold.missingRateMinor > 0,
        impressions: fold.impressions, linkClicks: fold.linkClicks,
      });
    }
  }
  unlinked.sort((a, b) => b.originalSpend - a.originalSpend);

  const zone = connection && connection.account ? connection.account.timezoneName : "";
  const state = {
    connected: Boolean(connection && connection.connected),
    currency,
    timezoneName: zone || "",
    timezoneNote: Boolean(zone && zone !== SHOP_ZONE),
    accountStatus: connection && connection.account ? connection.account.accountStatus : null,
    lastSyncAt: connection ? connection.lastSyncAt || null : null,
    lastSyncOkAt: connection ? connection.lastSyncOkAt || null : null,
    lastError: connection && connection.lastError && connection.lastError.code ? { code: connection.lastError.code, message: connection.lastError.message, at: connection.lastError.at } : null,
    paused: Boolean(connection && connection.paused),
    needsRate: [...linked.values()].some((figures) => figures.missingRateMinor > 0),
  };
  return { state, linked, unlinked };
};

module.exports = { metaFigures, foldDays, mergeFold, pickOriginal, rateCurrencies, currentAccountFilter };
