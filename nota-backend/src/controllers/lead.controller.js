// Online Stage 7A: leads (العملاء المحتملين). Reads: leads.manage or marketing.view. Writes and import: leads.manage.
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const Lead = require("../models/lead.model");
const Campaign = require("../models/campaign.model");
const { httpError } = require("../auth/middleware");
const leads = require("../services/leads.service");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isId = (value) => typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value.toLowerCase();

const campaignNamesOf = async (rows) => {
  const ids = [...new Set(rows.filter((row) => row.campaignId).map((row) => String(row.campaignId)))];
  if (!ids.length) return new Map();
  return new Map((await Campaign.find({ _id: { $in: ids } }).select("name").lean()).map((campaign) => [String(campaign._id), campaign.name]));
};

const checkCampaign = async (campaignId) => {
  if (campaignId && !(await Campaign.exists({ _id: campaignId }))) throw httpError(400, "INVALID_CAMPAIGN", "الحملة غير موجودة");
};

// GET /api/leads?search=&status=&source=&campaign=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) {
    if (!Lead.STATUSES.includes(req.query.status)) throw httpError(400, "INVALID_STATUS", "الحالة غير صالحة");
    filter.status = req.query.status;
  }
  if (req.query.source) {
    if (!Lead.SOURCES.includes(req.query.source)) throw httpError(400, "INVALID_SOURCE", "المصدر غير صالح");
    filter.source = req.query.source;
  }
  if (req.query.campaign) {
    if (!isId(req.query.campaign)) throw httpError(400, "INVALID_CAMPAIGN", "الحملة غير صالحة");
    filter.campaignId = req.query.campaign;
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 60) : "";
  if (search) {
    const phone = require("../utils/storePhone").normalizeStorePhone(search);
    filter.$or = [{ name: { $regex: escapeRegex(search), $options: "i" } }, ...(phone ? [{ phone }] : [{ phone: { $regex: escapeRegex(search) } }])];
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const [rows, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select("-noteLog").lean(),
    Lead.countDocuments(filter),
  ]);
  const names = await campaignNamesOf(rows);
  res.json({ data: rows.map((row) => leads.leadView(row, names)), pagination: { page, limit, totalItems: total, totalPages: Math.ceil(total / limit) } });
});

const loadOr404 = async (id) => {
  if (!isId(id)) throw httpError(404, "LEAD_NOT_FOUND", "العميل المحتمل غير موجود");
  const lead = await Lead.findById(id).lean();
  if (!lead) throw httpError(404, "LEAD_NOT_FOUND", "العميل المحتمل غير موجود");
  return lead;
};

// GET /api/leads/:id: the lead, the "bought?" lookup and the WhatsApp / call links.
const get = asyncHandler(async (req, res) => {
  const lead = await loadOr404(req.params.id);
  const names = await campaignNamesOf([lead]);
  const purchases = await leads.purchasesOf(lead);
  const national = lead.phone ? lead.phone.replace(/^0/, "") : "";
  res.json({ ...leads.leadView(lead, names), purchases, whatsappLink: national ? `https://wa.me/20${national}` : null, callLink: lead.phone ? `tel:${lead.phone}` : null });
});

// POST /api/leads
const create = asyncHandler(async (req, res) => {
  const input = leads.readLeadInput(req.body);
  await checkCampaign(input.campaignId);
  if (input.phone) {
    const existing = await Lead.findOne({ phone: input.phone }).select("name").lean();
    if (existing) throw leads.duplicateError(existing);
  }
  if (!input.phone) delete input.phone;
  let created;
  try {
    created = await Lead.create({ ...input, createdBy: req.user && req.user._id, createdByName: req.user && req.user.name });
  } catch (error) {
    if (error && error.code === 11000) throw leads.duplicateError((await Lead.findOne({ phone: input.phone }).select("name").lean()) || { _id: "", name: "" });
    throw error;
  }
  res.status(201).json(created.toObject());
});

// PUT /api/leads/:id
const update = asyncHandler(async (req, res) => {
  const lead = await loadOr404(req.params.id);
  const input = leads.readLeadInput(req.body, { partial: true });
  await checkCampaign(input.campaignId);
  const unset = {};
  if (input.phone === null) { delete input.phone; unset.phone = ""; }
  if (input.profileLink === null) { delete input.profileLink; unset.profileLink = ""; }
  const after = { phone: unset.phone !== undefined ? null : (input.phone || lead.phone), profileLink: unset.profileLink !== undefined ? null : (input.profileLink || lead.profileLink) };
  if (!after.phone && !after.profileLink) throw httpError(400, "CONTACT_REQUIRED", "اكتب رقم الموبايل أو رابط الحساب");
  if (input.phone && input.phone !== lead.phone) {
    const existing = await Lead.findOne({ phone: input.phone, _id: { $ne: lead._id } }).select("name").lean();
    if (existing) throw leads.duplicateError(existing);
  }
  let saved;
  try {
    saved = await Lead.findByIdAndUpdate(lead._id, { ...(Object.keys(input).length ? { $set: input } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true, runValidators: true }).lean();
  } catch (error) {
    if (error && error.code === 11000) throw leads.duplicateError((await Lead.findOne({ phone: input.phone }).select("name").lean()) || { _id: "", name: "" });
    throw error;
  }
  res.json(saved);
});

// POST /api/leads/:id/notes { text }: appends to the notes history.
const addNote = asyncHandler(async (req, res) => {
  const lead = await loadOr404(req.params.id);
  const text = typeof (req.body && req.body.text) === "string" ? req.body.text.trim().slice(0, 1000) : "";
  if (!text) throw httpError(400, "INVALID_NOTE", "اكتب الملاحظة");
  const saved = await Lead.findByIdAndUpdate(lead._id, { $push: { noteLog: { at: new Date(), byName: req.user && req.user.name, text } } }, { new: true }).lean();
  res.status(201).json({ _id: saved._id, noteLog: saved.noteLog });
});

// POST /api/leads/import/mapping { headers }: the suggested column mapping.
const importMapping = asyncHandler(async (req, res) => {
  res.json({ mapping: leads.suggestMapping(req.body && req.body.headers), maxRows: leads.MAX_IMPORT_ROWS });
});

const plan = (req) => leads.planImport({ rows: req.body && req.body.rows, mapping: req.body && req.body.mapping, mode: (req.body && req.body.mode) || "skip", source: (req.body && req.body.source) || "other" });

// POST /api/leads/import/preview { rows, mapping, mode, source }: nothing is written. The first 200 rows are listed.
const importPreview = asyncHandler(async (req, res) => {
  const planned = await plan(req);
  res.json({ summary: planned.summary, rows: planned.rows.slice(0, 200).map((row) => ({ index: row.index, status: row.status, reason: row.reason, name: row.name, phone: row.phone })) });
});

// POST /api/leads/import { rows, mapping, mode, source, campaignId? }
const importCommit = asyncHandler(async (req, res) => {
  const campaignId = req.body && req.body.campaignId ? String(req.body.campaignId) : null;
  if (campaignId && !isId(campaignId)) throw httpError(400, "INVALID_CAMPAIGN", "الحملة غير صالحة");
  const planned = await plan(req);
  const summary = await leads.commitImport(planned, { campaignId, user: req.user });
  res.json({ ...summary, invalidRows: planned.rows.filter((row) => row.status === "invalid").slice(0, 200).map((row) => ({ index: row.index, reason: row.reason, name: row.name })) });
});

module.exports = { list, get, create, update, addNote, importMapping, importPreview, importCommit };
