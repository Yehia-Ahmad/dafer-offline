// Online Stage 7A: campaigns (marketing.view reads, marketing.manage writes), their results and the ad-spend list/category.
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const Campaign = require("../models/campaign.model");
const Product = require("../models/product.model");
const Category = require("../models/category.model");
const Account = require("../models/account.model");
const Expense = require("../models/expense.model");
const boxes = require("../cashbox/boxes");
const { withTransaction } = require("../utils/transaction");
const { audit } = require("../auth/audit");
const { httpError, hasPermission } = require("../auth/middleware");
const clock = require("../utils/clock");
const campaigns = require("../services/campaigns.service");
const { campaignResults, rangeOf } = require("../services/marketingResults.service");

const AD_CATEGORY_NAME = "دعاية وإعلان";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const originOf = (req) => (process.env.NOTA_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const dayDate = (value, label) => {
  if (!DAY.test(String(value)) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) throw httpError(400, "INVALID_DATE", `${label} غير صالح`);
  return new Date(`${value}T00:00:00Z`);
};

const view = async (campaign, req) => ({
  ...campaign,
  ...campaigns.links(campaign, originOf(req)),
  codeEditable: !(await campaigns.codeInUse(campaign)),
});

const readLanding = async (input) => {
  const landing = input && typeof input === "object" ? input : { kind: "home" };
  const kind = landing.kind || "home";
  if (!Campaign.LANDING_KINDS.includes(kind)) throw httpError(400, "INVALID_LANDING", "صفحة الوصول غير صالحة");
  if (kind === "home") return { kind };
  if (kind === "path") {
    if (!campaigns.validLandingPath(landing.path)) throw httpError(400, "INVALID_LANDING", "المسار لازم يبدأ بعلامة / ويكون جوه الموقع");
    return { kind, path: landing.path.trim() };
  }
  if (!campaigns.isId(landing.ref)) throw httpError(400, "INVALID_LANDING", "اختار المنتج أو القسم");
  const found = kind === "product" ? await Product.exists({ _id: landing.ref }) : await Category.exists({ _id: landing.ref });
  if (!found) throw httpError(400, "INVALID_LANDING", "المنتج أو القسم غير موجود");
  return { kind, ref: landing.ref };
};

const readInput = async (body, { partial }) => {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  const has = (key) => input[key] !== undefined;
  if (!partial || has("name")) {
    const name = str(input.name, 120);
    if (!name) throw httpError(400, "INVALID_NAME", "اسم الحملة مطلوب");
    out.name = name;
  }
  if (!partial || has("platform")) {
    if (!Campaign.PLATFORMS.includes(input.platform)) throw httpError(400, "INVALID_PLATFORM", "المنصة غير صالحة");
    out.platform = input.platform;
  }
  if (!partial || has("type")) {
    if (!Campaign.TYPES.includes(input.type)) throw httpError(400, "INVALID_TYPE", "نوع الحملة غير صالح");
    out.type = input.type;
  }
  if (!partial || has("landing")) out.landing = await readLanding(input.landing);
  if (!partial || has("startDate")) out.startDate = has("startDate") && input.startDate ? dayDate(input.startDate, "تاريخ البداية") : dayDate(clock.localDayString(clock.now()), "تاريخ البداية");
  if (has("endDate")) out.endDate = input.endDate ? dayDate(input.endDate, "تاريخ النهاية") : null;
  if (has("plannedBudget")) {
    if (input.plannedBudget === null || input.plannedBudget === "") out.plannedBudget = null;
    else {
      const budget = Number(input.plannedBudget);
      if (!Number.isFinite(budget) || budget < 0 || budget > 1e9) throw httpError(400, "INVALID_BUDGET", "الميزانية غير صالحة");
      out.plannedBudget = Math.round(budget * 100) / 100;
    }
  }
  if (has("notes")) out.notes = str(input.notes, 1000);
  if (has("status")) {
    if (!Campaign.STATUSES.includes(input.status)) throw httpError(400, "INVALID_STATUS", "حالة الحملة غير صالحة");
    out.status = input.status;
  }
  if (has("code")) {
    const code = str(input.code, 40).toLowerCase();
    if (!campaigns.CODE_PATTERN.test(code)) throw httpError(400, "INVALID_CODE", "الكود حروف إنجليزي صغيرة وأرقام وشرطة (3 إلى 32)");
    out.code = code;
  }
  return out;
};

const finalize = (out) => {
  if (out.startDate && out.endDate && out.endDate < out.startDate) throw httpError(400, "INVALID_DATE", "تاريخ النهاية قبل تاريخ البداية");
};

const canSeeProfit = (req) => hasPermission(req.user, "products.viewCost");

// GET /api/campaigns?status=&platform=&from=&to=  (rows with their KPIs for the range; default last 30 local days)
const list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) {
    if (!Campaign.STATUSES.includes(req.query.status)) throw httpError(400, "INVALID_STATUS", "الحالة غير صالحة");
    filter.status = req.query.status;
  }
  if (req.query.platform) {
    if (!Campaign.PLATFORMS.includes(req.query.platform)) throw httpError(400, "INVALID_PLATFORM", "المنصة غير صالحة");
    filter.platform = req.query.platform;
  }
  const rows = await Campaign.find(filter).sort({ createdAt: -1 }).lean();
  const results = await campaignResults({ from: req.query.from, to: req.query.to }, { includeProfit: canSeeProfit(req) });
  if (!results) throw httpError(400, "INVALID_RANGE", "الفترة غير صالحة");
  const kpis = new Map(results.campaigns.map((row) => [String(row.campaignId), row]));
  res.json({ range: results.range, data: await Promise.all(rows.map(async (row) => ({ ...(await view(row, req)), kpis: kpis.get(String(row._id)) || null }))) });
});

const loadOr404 = async (id) => {
  if (!campaigns.isId(id)) throw httpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة");
  const campaign = await Campaign.findById(id).lean();
  if (!campaign) throw httpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة");
  return campaign;
};

const get = asyncHandler(async (req, res) => res.json(await view(await loadOr404(req.params.id), req)));

// POST /api/campaigns (marketing.manage)
const create = asyncHandler(async (req, res) => {
  const input = await readInput(req.body, { partial: false });
  finalize(input);
  if (input.code && (await Campaign.exists({ code: input.code }))) throw httpError(409, "CODE_TAKEN", "الكود مستخدم في حملة تانية");
  const code = input.code || (await campaigns.generateCode());
  let created;
  try {
    created = await Campaign.create({ ...input, code, status: "active", createdBy: req.user && req.user._id, createdByName: req.user && req.user.name });
  } catch (error) {
    if (error && error.code === 11000) throw httpError(409, "CODE_TAKEN", "الكود مستخدم في حملة تانية");
    throw error;
  }
  res.status(201).json(await view(created.toObject(), req));
});

// PUT /api/campaigns/:id (marketing.manage). The code can only change before anything used it.
const update = asyncHandler(async (req, res) => {
  const campaign = await loadOr404(req.params.id);
  const input = await readInput(req.body, { partial: true });
  finalize({ startDate: input.startDate || campaign.startDate, endDate: input.endDate === undefined ? campaign.endDate : input.endDate });
  if (input.code && input.code !== campaign.code) {
    if (await campaigns.codeInUse(campaign)) throw httpError(409, "CODE_LOCKED", "الكود اتستخدم قبل كده ومينفعش يتغير");
    if (await Campaign.exists({ code: input.code, _id: { $ne: campaign._id } })) throw httpError(409, "CODE_TAKEN", "الكود مستخدم في حملة تانية");
  }
  let saved;
  try {
    saved = await Campaign.findByIdAndUpdate(campaign._id, { $set: input }, { new: true, runValidators: true }).lean();
  } catch (error) {
    if (error && error.code === 11000) throw httpError(409, "CODE_TAKEN", "الكود مستخدم في حملة تانية");
    throw error;
  }
  res.json(await view(saved, req));
});

// GET /api/campaigns/results?from=&to=  (every campaign, platforms, direct, "heard from", daily)
const results = asyncHandler(async (req, res) => {
  const data = await campaignResults({ from: req.query.from, to: req.query.to }, { includeProfit: canSeeProfit(req) });
  if (!data) throw httpError(400, "INVALID_RANGE", "الفترة غير صالحة");
  res.json(data);
});

// GET /api/campaigns/:id/results?from=&to=
const campaignOnlyResults = asyncHandler(async (req, res) => {
  const campaign = await loadOr404(req.params.id);
  const data = await campaignResults({ from: req.query.from, to: req.query.to, campaignId: String(campaign._id) }, { includeProfit: canSeeProfit(req) });
  if (!data) throw httpError(400, "INVALID_RANGE", "الفترة غير صالحة");
  res.json({ range: data.range, includeProfit: data.includeProfit, campaign: data.campaigns[0] || null, daily: data.daily });
});

// GET /api/campaigns/:id/spend?from=&to=  (the expenses linked to the campaign, cancelled ones marked)
const spendList = asyncHandler(async (req, res) => {
  const campaign = await loadOr404(req.params.id);
  const range = rangeOf(req.query || {});
  if (!range) throw httpError(400, "INVALID_RANGE", "الفترة غير صالحة");
  const rows = await Expense.find({ campaignId: campaign._id, date: { $gte: range.start, $lte: range.end } }).sort({ date: -1, createdAt: -1 }).lean();
  res.json({
    range: { from: range.from, to: range.to },
    data: rows.map((row) => ({ _id: row._id, number: row.number, date: row.date, amount: row.amount, vatAmount: row.vatAmount || 0, net: Math.round((row.amount - (row.vatAmount || 0)) * 100) / 100, note: row.note || "", status: row.status })),
    total: Math.round(rows.filter((row) => row.status === "posted").reduce((sum, row) => sum + row.amount - (row.vatAmount || 0), 0) * 100) / 100,
  });
});

// GET /api/campaigns/ad-category (expenses.create + marketing.view): the «دعاية وإعلان» category, created as a normal expense category
// under 520 when missing. The same account creation as POST /api/expenses/categories; nothing is posted.
const adCategory = asyncHandler(async (req, res) => {
  const account = await withTransaction(async (session) => {
    const parent = await Account.findOne({ code: "520" }).session(session).lean();
    if (!parent) throw httpError(409, "NO_EXPENSE_PARENT", "حسابات المصروفات غير متاحة");
    const found = await Account.findOne({ parentId: parent._id, isGroup: false, nameAr: AD_CATEGORY_NAME }).session(session).lean();
    if (found) {
      if (found.isActive === false) throw httpError(409, "AD_CATEGORY_INACTIVE", "بند «دعاية وإعلان» موقوف. فعّله من بنود المصروفات");
      return found;
    }
    const { code } = await boxes.nextLeafCode("520", 52000, session);
    const [created] = await Account.create([{ code, nameAr: AD_CATEGORY_NAME, nameEn: "Advertising", type: "expense", normalSide: "debit", parentId: parent._id, isGroup: false, isSystem: false, isActive: true }], { session });
    await audit(req, { action: "expense.category.created", entity: "Account", entityId: created._id, details: { code, nameAr: AD_CATEGORY_NAME }, session, strict: true });
    return created.toObject();
  });
  res.json({ accountId: account._id, code: account.code, nameAr: account.nameAr, nameEn: account.nameEn });
});

module.exports = { list, get, create, update, results, campaignOnlyResults, spendList, adCategory, AD_CATEGORY_NAME };
