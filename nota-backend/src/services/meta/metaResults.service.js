// Online Stage 7B: the synced Meta numbers shaped for the marketing results. Read-only: it only reads MetaConnection, MetaCampaign,
// MetaInsightDay and ExchangeRate. Nothing is posted and no price changes.
//
// Money: insights are integer minor units of the ad account's currency. Each day converts with the rate effective that day
// (exchange rates are in EGP per 1 unit). A day with no rate keeps its original amount and marks the figures "needs a rate".
const MetaConnection = require("../../models/metaConnection.model");
const MetaCampaign = require("../../models/metaCampaign.model");
const MetaInsightDay = require("../../models/metaInsightDay.model");
const ExchangeRate = require("../../models/exchangeRate.model");
const { rateOn, convertMinor, toMoney } = require("./metaMoney");

const SHOP_ZONE = "Africa/Cairo";

/** Days of one Meta campaign -> { egpMinor, originalMinor, missingRateMinor, impressions, reach, clicks, linkClicks, perDay }. */
const foldDays = (days, rates, isEgp) => {
  const out = { egpMinor: 0, originalMinor: 0, missingRateMinor: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, perDay: new Map() };
  for (const row of days) {
    const rate = isEgp ? { rate: 1 } : rateOn(rates, row.day);
    const egp = rate ? convertMinor(row.spendMinor, rate.rate) : 0;
    out.originalMinor += row.spendMinor;
    if (rate) out.egpMinor += egp; else out.missingRateMinor += row.spendMinor;
    out.impressions += row.impressions;
    out.reach += row.reach;
    out.clicks += row.clicks;
    out.linkClicks += row.linkClicks;
    const day = out.perDay.get(row.day) || { egpMinor: 0, missingRate: false };
    if (rate) day.egpMinor += egp; else day.missingRate = true;
    out.perDay.set(row.day, day);
  }
  return out;
};

/**
 * @param {{from:string,to:string}} range  Meta days are compared as plain strings
 * @param {{campaignIds:string[], withUnlinked:boolean}} scope
 * @returns {null | {state, linked: Map<string, figures>, unlinked: object[]}}  null when Meta was never connected
 */
const metaFigures = async (range, { campaignIds, withUnlinked }) => {
  const connection = await MetaConnection.findById("default").lean();
  const anyCampaign = connection ? true : await MetaCampaign.exists({});
  if (!connection && !anyCampaign) return null;

  const currency = connection && connection.account && connection.account.currency ? connection.account.currency : "EGP";
  const isEgp = currency === "EGP";
  const [metaCampaigns, rates] = await Promise.all([
    MetaCampaign.find({}).select("metaId name status effectiveStatus campaignId").lean(),
    isEgp ? [] : ExchangeRate.find({ currency }).select("rate effectiveFrom").lean(),
  ]);
  const insights = await MetaInsightDay.find({ day: { $gte: range.from, $lte: range.to } }).lean();
  const daysByMeta = new Map();
  for (const row of insights) {
    if (!daysByMeta.has(row.metaId)) daysByMeta.set(row.metaId, []);
    daysByMeta.get(row.metaId).push(row);
  }

  const wanted = new Set(campaignIds.map(String));
  const linked = new Map();
  const unlinked = [];
  for (const meta of metaCampaigns) {
    const days = daysByMeta.get(meta.metaId) || [];
    const owner = meta.campaignId ? String(meta.campaignId) : null;
    if (owner) {
      if (!wanted.has(owner)) continue;
      const fold = foldDays(days, rates, isEgp);
      if (!linked.has(owner)) linked.set(owner, { egpMinor: 0, originalMinor: 0, missingRateMinor: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, perDay: new Map(), metaIds: [] });
      const total = linked.get(owner);
      for (const key of ["egpMinor", "originalMinor", "missingRateMinor", "impressions", "reach", "clicks", "linkClicks"]) total[key] += fold[key];
      for (const [day, value] of fold.perDay) {
        const current = total.perDay.get(day) || { egpMinor: 0, missingRate: false };
        current.egpMinor += value.egpMinor;
        current.missingRate = current.missingRate || value.missingRate;
        total.perDay.set(day, current);
      }
      total.metaIds.push(meta.metaId);
    } else if (withUnlinked && days.length) {
      const fold = foldDays(days, rates, isEgp);
      unlinked.push({
        metaId: meta.metaId, name: meta.name, status: meta.effectiveStatus || meta.status || "",
        spend: toMoney(fold.egpMinor), originalSpend: toMoney(fold.originalMinor), originalCurrency: currency, needsRate: fold.missingRateMinor > 0,
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
    needsRate: !isEgp && [...linked.values()].some((figures) => figures.missingRateMinor > 0),
  };
  return { state, linked, unlinked };
};

module.exports = { metaFigures, foldDays };
