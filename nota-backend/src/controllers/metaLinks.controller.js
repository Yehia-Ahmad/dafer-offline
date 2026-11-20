// Online Stage 7B: linking synced Meta campaigns to Nota campaigns. A Nota campaign may link to several Meta campaigns; a Meta
// campaign links to at most one Nota campaign. A name containing the Nota campaign's code is only SUGGESTED, never linked by itself.
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const { httpError } = require("../auth/middleware");
const Campaign = require("../models/campaign.model");
const MetaCampaign = require("../models/metaCampaign.model");
const clock = require("../utils/clock");

const LINKABLE_PLATFORMS = ["facebook", "instagram"];
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rowView = (row, campaign) => ({
  metaId: row.metaId, name: row.name, status: row.effectiveStatus || row.status || "", objective: row.objective || "",
  campaignId: row.campaignId || null, linkedAt: row.linkedAt || null,
  suggested: Boolean(campaign && !row.campaignId && String(row.name || "").toLowerCase().includes(campaign.code)),
});

const loadCampaign = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة");
  const campaign = await Campaign.findById(id).select("name code platform").lean();
  if (!campaign) throw httpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة");
  return campaign;
};

// GET /api/campaigns/meta-campaigns?campaignId=&search=&status=&unlinked=1  (marketing.manage): the picker of the link dialog.
// Suggested ones come first. Linked ones are shown too (marked), so the owner sees why they cannot be taken.
const listMeta = asyncHandler(async (req, res) => {
  const campaign = req.query.campaignId ? await loadCampaign(req.query.campaignId) : null;
  const filter = {};
  const search = String(req.query.search || "").trim().slice(0, 80);
  if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
  if (req.query.status) filter.effectiveStatus = String(req.query.status).toUpperCase().slice(0, 30);
  if (req.query.unlinked === "1") filter.campaignId = null;
  const rows = await MetaCampaign.find(filter).sort({ createdTime: -1 }).limit(300).lean();
  const data = rows.map((row) => rowView(row, campaign));
  data.sort((a, b) => Number(b.suggested) - Number(a.suggested));
  res.json({ data });
});

// GET /api/campaigns/:id/meta-links  (marketing.view)
const listLinks = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  const rows = await MetaCampaign.find({ campaignId: campaign._id }).sort({ name: 1 }).lean();
  res.json({ data: rows.map((row) => rowView(row, campaign)) });
});

// POST /api/campaigns/:id/meta-links  { metaId }  (marketing.manage)
const link = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  if (!LINKABLE_PLATFORMS.includes(campaign.platform)) throw httpError(409, "PLATFORM_NOT_LINKABLE", "الربط متاح لحملات فيسبوك وإنستجرام بس");
  const metaId = String((req.body && req.body.metaId) || "").trim();
  if (!/^\d{1,30}$/.test(metaId)) throw httpError(400, "INVALID_META_CAMPAIGN", "حملة فيسبوك غير صالحة");
  // One atomic step: only a Meta campaign that has no Nota campaign yet (or already this one) can be taken.
  const taken = await MetaCampaign.findOneAndUpdate(
    { metaId, $or: [{ campaignId: null }, { campaignId: { $exists: false } }, { campaignId: campaign._id }] },
    { $set: { campaignId: campaign._id, linkedAt: clock.now(), linkedByName: req.user && req.user.name } },
    { new: true }
  ).lean();
  if (!taken) {
    if (!(await MetaCampaign.exists({ metaId }))) throw httpError(404, "META_CAMPAIGN_NOT_FOUND", "حملة فيسبوك غير موجودة (اعمل مزامنة)");
    throw httpError(409, "ALREADY_LINKED", "حملة فيسبوك دي مربوطة بحملة تانية");
  }
  res.status(201).json(rowView(taken, campaign));
});

// DELETE /api/campaigns/:id/meta-links/:metaId  (marketing.manage)
const unlink = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req.params.id);
  const done = await MetaCampaign.updateOne({ metaId: String(req.params.metaId), campaignId: campaign._id }, { $unset: { campaignId: "", linkedAt: "", linkedByName: "" } });
  if (!done.modifiedCount) throw httpError(404, "LINK_NOT_FOUND", "الربط غير موجود");
  res.json({ ok: true });
});

module.exports = { listMeta, listLinks, link, unlink };
