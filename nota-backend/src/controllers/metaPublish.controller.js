// Online Stage 7C: creating Facebook/Instagram campaigns from a Nota campaign and managing the ones Nota created. Everything here needs
// marketing.publish (owner only by default). The work is in services/meta/metaPublish.service.js; every write to Meta goes through
// services/meta/metaWriter.js. Audit entries never carry the token, image bytes or the ad text (only its length).
const asyncHandler = require("../utils/asyncHandler");
const { httpError } = require("../auth/middleware");
const { audit } = require("../auth/audit");
const MetaConnection = require("../models/metaConnection.model");
const publish = require("../services/meta/metaPublish.service");
const sync = require("../services/meta/metaSync.service");
const { createClient, MetaError } = require("../services/meta/metaClient");

const metaFailure = (error) => {
  if (error instanceof MetaError) return httpError(error.code === "RATE_LIMITED" ? 429 : 400, error.code, error.message);
  return httpError(502, "META_ERROR", new MetaError("META_ERROR").message);
};

// GET /api/campaigns/:id/publish/options
const options = asyncHandler(async (_req, res) => res.json(await publish.options()));

// POST /api/campaigns/:id/publish  { goal, budget, audience, ads }: validates and stores a draft. Nothing is sent to Meta.
const createDraft = asyncHandler(async (req, res) => {
  const { publish: draft, warnings } = await publish.createDraft({ campaignId: req.params.id, input: req.body, user: req.user });
  res.status(201).json({ ...publish.view(draft), warnings });
});

const getOne = asyncHandler(async (req, res) => res.json(await publish.getPublish({ publishId: req.params.publishId, campaignId: req.params.id })));

// POST /api/campaigns/:id/publish/:publishId/preview  { index, format }
const preview = asyncHandler(async (req, res) => res.json(await publish.preview({ publishId: req.params.publishId, campaignId: req.params.id, index: req.body && req.body.index, format: req.body && req.body.format })));

// POST /api/campaigns/:id/publish/:publishId/run (also «حاول تاني»: it continues from the first unfinished step)
const run = asyncHandler(async (req, res) => {
  const result = await publish.run({ publishId: req.params.publishId, campaignId: req.params.id, user: req.user });
  if (result.status === "published") {
    const draft = await require("../models/metaPublish.model").findOne({ publishId: req.params.publishId }).lean();
    const spec = draft.spec;
    await audit(req, { action: "meta.publish.created", entity: "MetaPublish", entityId: result.publishId, details: { campaignId: draft.campaignId, metaCampaignId: draft.metaCampaignId, goal: spec.goal, budgetType: spec.budget.type, amountMinor: spec.budget.amountMinor, currency: spec.currency, ads: spec.ads.length, textLengths: spec.ads.map((ad) => ad.primaryText.length) } });
  }
  res.json(result);
});

const cancel = asyncHandler(async (req, res) => {
  const result = await publish.cancel({ publishId: req.params.publishId, campaignId: req.params.id });
  await audit(req, { action: "meta.publish.cancelled", entity: "MetaPublish", entityId: result.publishId, details: { campaignId: req.params.id, metaCampaignId: result.metaCampaignId } });
  res.json(result);
});

// GET /api/campaigns/meta-geo?q=  Egyptian governorates and cities (Meta's targeting search), cached for a day.
const geoCache = new Map();
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const geo = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 60);
  if (q.length < 2) return res.json({ data: [] });
  const cached = geoCache.get(q);
  if (cached && Date.now() - cached.at < GEO_TTL_MS) return res.json({ data: cached.data });
  const connection = await MetaConnection.findById("default").lean();
  if (!connection || !connection.connected || !connection.tokenSealed) throw httpError(409, "NOT_CONNECTED", "حساب الإعلانات غير مربوط");
  let rows;
  try { rows = await createClient(sync.credentialsOf(connection)).geoSearch(q); } catch (error) { throw metaFailure(error); }
  const data = rows
    .filter((row) => row && /^\d{1,12}$/.test(String(row.key)) && (row.type === "region" || row.type === "city") && (!row.country_code || row.country_code === "EG"))
    .slice(0, 25)
    .map((row) => ({ key: String(row.key), type: row.type, name: String(row.name || "").slice(0, 80), region: row.region ? String(row.region).slice(0, 80) : "" }));
  geoCache.set(q, { at: Date.now(), data });
  res.json({ data });
});

// ----- managing campaigns Nota created -----
const manage = ({ action, run, details }) => asyncHandler(async (req, res) => {
  const result = await run(req);
  await audit(req, { action, entity: "MetaCampaign", entityId: req.params.metaId, details: { campaignId: req.params.id, ...details(req, result) } });
  res.json(result);
});

const setStatus = manage({
  action: "meta.campaign.status",
  run: (req) => publish.setStatus({ campaignId: req.params.id, metaId: req.params.metaId, status: req.body && req.body.status, confirmSpend: req.body && req.body.confirmSpend }),
  details: (req, result) => ({ status: result.status, ...(result.summary ? { amountMinor: result.summary.amountMinor, currency: result.summary.currency, budgetType: result.summary.type } : {}) }),
});
const setBudget = manage({
  action: "meta.campaign.budget",
  run: (req) => publish.setBudget({ campaignId: req.params.id, metaId: req.params.metaId, amount: req.body && req.body.amount }),
  details: (_req, result) => ({ budgetType: result.type, oldMinor: result.oldMinor, newMinor: result.newMinor }),
});
const setEndTime = manage({
  action: "meta.campaign.end_time",
  run: (req) => publish.setEndTime({ campaignId: req.params.id, metaId: req.params.metaId, endTime: req.body && req.body.endTime }),
  details: (_req, result) => ({ oldEndTime: result.oldEndTime, newEndTime: result.newEndTime }),
});
const archive = manage({
  action: "meta.campaign.archived",
  run: (req) => publish.archive({ campaignId: req.params.id, metaId: req.params.metaId }),
  details: () => ({}),
});
const refresh = asyncHandler(async (req, res) => res.json(await publish.refresh({ campaignId: req.params.id, metaId: req.params.metaId })));

module.exports = { options, createDraft, getOne, preview, run, cancel, geo, setStatus, setBudget, setEndTime, archive, refresh };
