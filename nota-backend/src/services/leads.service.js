// Online Stage 7A: leads. "Bought?" is computed when a lead is read (nothing in sales, orders or returns knows about leads).
const mongoose = require("mongoose");
const Lead = require("../models/lead.model");
const Campaign = require("../models/campaign.model");
const WebOrder = require("../models/webOrder.model");
const CreditSale = require("../models/creditSale.model");
const Selling = require("../models/selling.model");
const Customer = require("../models/customer.model");
const { normalizeStorePhone } = require("../utils/storePhone");
const { httpError } = require("../auth/middleware");
const { roundMoney } = require("../utils/invoicePricing");
const clock = require("../utils/clock");

const MAX_IMPORT_ROWS = 5000;
const PROFILE_HOSTS = ["facebook.com", "instagram.com", "tiktok.com", "wa.me", "m.me"];
const FAILED_ORDER_STATUSES = ["cancelled", "rejected", "refused"];

/** A profile link must be https (or http) on facebook.com, instagram.com, tiktok.com, wa.me or m.me (or a subdomain of them). */
const validProfileLink = (value) => {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (!["https:", "http:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  return PROFILE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
};

/** Every spelling the same mobile number may have been saved with in older documents (customers and cash sales are not normalized). */
const phoneVariants = (phone) => {
  const national = String(phone || "").replace(/^0/, "");
  if (!/^1[0125]\d{8}$/.test(national)) return [];
  return [`0${national}`, national, `20${national}`, `+20${national}`, `0020${national}`];
};

/** Meta lead exports write "p:+2010...". */
const cleanPhoneInput = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim().replace(/^p:/i, "") : "");

const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The fields a user may set, validated. `partial` leaves absent fields out (an update). Throws httpError(400). */
const readLeadInput = (body, { partial = false } = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  const has = (key) => input[key] !== undefined;
  if (!partial || has("name")) {
    const name = str(input.name, 120);
    if (!name) throw httpError(400, "INVALID_NAME", "الاسم مطلوب");
    out.name = name;
  }
  if (!partial || has("phone")) {
    const raw = cleanPhoneInput(input.phone);
    if (raw) {
      const phone = normalizeStorePhone(raw);
      if (!phone) throw httpError(400, "INVALID_PHONE", "رقم الموبايل غير صالح");
      out.phone = phone;
    } else {
      out.phone = null;
    }
  }
  if (!partial || has("profileLink")) {
    const link = str(input.profileLink, 300);
    if (link && !validProfileLink(link)) throw httpError(400, "INVALID_PROFILE_LINK", "الرابط لازم يكون من فيسبوك أو إنستجرام أو تيك توك أو واتساب أو ماسنجر");
    out.profileLink = link || null;
  }
  if (!partial || has("source")) {
    if (!Lead.SOURCES.includes(input.source)) throw httpError(400, "INVALID_SOURCE", "مصدر العميل غير صالح");
    out.source = input.source;
  }
  if (has("status")) {
    if (!Lead.STATUSES.includes(input.status)) throw httpError(400, "INVALID_STATUS", "حالة العميل غير صالحة");
    out.status = input.status;
  }
  if (has("campaignId")) {
    if (input.campaignId === null || input.campaignId === "") out.campaignId = null;
    else if (typeof input.campaignId === "string" && mongoose.Types.ObjectId.isValid(input.campaignId)) out.campaignId = input.campaignId;
    else throw httpError(400, "INVALID_CAMPAIGN", "الحملة غير صالحة");
  }
  if (has("notes")) out.notes = str(input.notes, 2000);
  if (has("lastContactDate")) {
    if (input.lastContactDate === null || input.lastContactDate === "") out.lastContactDate = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(input.lastContactDate)) && !Number.isNaN(new Date(`${input.lastContactDate}T00:00:00Z`).getTime())) out.lastContactDate = new Date(`${input.lastContactDate}T00:00:00Z`);
    else throw httpError(400, "INVALID_DATE", "تاريخ آخر تواصل غير صالح");
  }
  if (!partial && !out.phone && !out.profileLink) throw httpError(400, "CONTACT_REQUIRED", "اكتب رقم الموبايل أو رابط الحساب");
  if (partial && (out.phone === null && out.profileLink === null)) throw httpError(400, "CONTACT_REQUIRED", "اكتب رقم الموبايل أو رابط الحساب");
  return out;
};

const duplicateError = (existing) => {
  const error = httpError(409, "DUPLICATE_PHONE", "الرقم ده مسجل قبل كده كعميل محتمل");
  error.responseData.existingLeadId = String(existing._id);
  error.responseData.existingName = existing.name;
  return error;
};

const leadView = (lead, campaignNames = new Map()) => ({
  ...lead,
  campaignName: lead.campaignId ? campaignNames.get(String(lead.campaignId)) || null : null,
});

/**
 * "اشترى؟": the documents found for the lead's phone from the lead's creation day on. Website orders (not cancelled / rejected /
 * refused), credit sales (by the sale's phone or by a customer with that phone) and cash sales with that phone. A sale made for a
 * website order never carries the lead's phone (the credit sale belongs to the courier, the cash sale is a walk-in), so nothing
 * is counted twice. Cancelled invoices are ignored and returns are taken off the total.
 */
const purchasesOf = async (lead) => {
  const variants = phoneVariants(lead.phone);
  if (!variants.length) return { bought: false, count: 0, total: 0, documents: [] };
  const since = lead.createdAt || new Date(0);
  const sinceDay = clock.businessDay(since);
  const customers = await Customer.find({ phone: { $in: variants } }).select("_id").lean();
  const customerIds = customers.map((customer) => customer._id);
  const [orders, credit, cash] = await Promise.all([
    WebOrder.find({ "contact.phone": { $in: variants }, createdAt: { $gte: since }, status: { $nin: FAILED_ORDER_STATUSES } }).select("number total status createdAt").lean(),
    CreditSale.find({ status: { $ne: "cancelled" }, sellingDate: { $gte: sinceDay }, $or: [{ customerPhone: { $in: variants } }, ...(customerIds.length ? [{ customer: { $in: customerIds } }] : [])] })
      .select("number totalPrice refundedAmount sellingDate").lean(),
    Selling.find({ status: { $ne: "cancelled" }, sellingDate: { $gte: sinceDay }, customerPhone: { $in: variants } }).select("number totalPrice refundedAmount sellingDate").lean(),
  ]);
  const documents = [
    ...orders.map((doc) => ({ type: "web_order", id: String(doc._id), number: doc.number, date: doc.createdAt, status: doc.status, total: roundMoney(doc.total) })),
    ...credit.map((doc) => ({ type: "credit_sale", id: String(doc._id), number: doc.number, date: doc.sellingDate, total: roundMoney(Number(doc.totalPrice || 0) - Number(doc.refundedAmount || 0)) })),
    ...cash.map((doc) => ({ type: "cash_sale", id: String(doc._id), number: doc.number, date: doc.sellingDate, total: roundMoney(Number(doc.totalPrice || 0) - Number(doc.refundedAmount || 0)) })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));
  return { bought: documents.length > 0, count: documents.length, total: roundMoney(documents.reduce((sum, doc) => sum + doc.total, 0)), documents };
};

// ---- import -------------------------------------------------------------------------------------------------------------------

const HEADER_ALIASES = {
  name: ["full_name", "name", "fullname", "first_name", "الاسم", "اسم"],
  phone: ["phone_number", "phone", "mobile", "mobile_number", "phonenumber", "رقم الموبايل", "الموبايل", "رقم الهاتف", "تليفون"],
  createdTime: ["created_time", "created", "date", "تاريخ"],
  campaignName: ["campaign_name", "campaign", "الحملة"],
  adName: ["ad_name", "adset_name", "ad", "الإعلان"],
  platform: ["platform", "المنصة"],
  profileLink: ["profile_link", "profile", "link", "الرابط"],
};

const squash = (header) => String(header || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** { name, phone, ... } -> the header of the file that looks like it (or null). */
const suggestMapping = (headers) => {
  const list = Array.isArray(headers) ? headers.map((header) => String(header)) : [];
  const out = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const found = list.find((header) => aliases.includes(squash(header)));
    out[field] = found || null;
  }
  return out;
};

const PLATFORM_SOURCES = { fb: "facebook", facebook: "facebook", ig: "instagram", instagram: "instagram", tiktok: "tiktok", "tik tok": "tiktok", whatsapp: "whatsapp", messenger: "messenger" };

const cell = (row, mapping, field) => (mapping && mapping[field] && row && row[mapping[field]] !== undefined && row[mapping[field]] !== null ? String(row[mapping[field]]).trim() : "");

/**
 * Classifies every row without writing anything. Returns { rows: [{ index, status, reason?, ... }], summary }.
 * status: new | update | skip | invalid. `mode` decides what an existing phone does ("skip" or "update").
 */
const planImport = async ({ rows, mapping, mode = "skip", source = "other" }) => {
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, "NO_ROWS", "الملف فاضي");
  if (rows.length > MAX_IMPORT_ROWS) throw httpError(400, "TOO_MANY_ROWS", `الحد الأقصى ${MAX_IMPORT_ROWS} صف في المرة`);
  if (!["skip", "update"].includes(mode)) throw httpError(400, "INVALID_MODE", "اختار تخطي أو تحديث");
  if (!Lead.SOURCES.includes(source)) throw httpError(400, "INVALID_SOURCE", "مصدر العميل غير صالح");
  if (!mapping || typeof mapping !== "object" || !mapping.name || !mapping.phone) throw httpError(400, "MAPPING_REQUIRED", "اربط عمود الاسم وعمود الموبايل");

  const parsed = rows.map((row, index) => {
    const name = cell(row, mapping, "name").slice(0, 120);
    const rawPhone = cleanPhoneInput(cell(row, mapping, "phone"));
    const phone = rawPhone ? normalizeStorePhone(rawPhone) : null;
    const link = cell(row, mapping, "profileLink");
    const platform = PLATFORM_SOURCES[cell(row, mapping, "platform").toLowerCase()] || source;
    const created = cell(row, mapping, "createdTime");
    const createdAt = created && !Number.isNaN(new Date(created).getTime()) && new Date(created) <= clock.now() ? new Date(created) : null;
    let reason = "";
    if (!name) reason = "NAME_REQUIRED";
    else if (rawPhone && !phone) reason = "INVALID_PHONE";
    else if (!rawPhone && !link) reason = "CONTACT_REQUIRED";
    else if (link && !validProfileLink(link)) reason = "INVALID_PROFILE_LINK";
    return { index, name, phone, profileLink: link || null, source: platform, createdAt, campaignName: cell(row, mapping, "campaignName"), adName: cell(row, mapping, "adName"), invalid: reason };
  });

  const phones = [...new Set(parsed.filter((row) => !row.invalid && row.phone).map((row) => row.phone))];
  const existing = new Map((phones.length ? await Lead.find({ phone: { $in: phones } }).select("_id phone").lean() : []).map((lead) => [lead.phone, lead]));
  const seen = new Set();
  const planned = parsed.map((row) => {
    if (row.invalid) return { ...row, status: "invalid", reason: row.invalid };
    if (row.phone && seen.has(row.phone)) return { ...row, status: "skip", reason: "DUPLICATE_IN_FILE" };
    if (row.phone) seen.add(row.phone);
    const found = row.phone ? existing.get(row.phone) : null;
    if (found) return { ...row, status: mode === "update" ? "update" : "skip", reason: mode === "update" ? undefined : "EXISTS", existingId: found._id };
    return { ...row, status: "new" };
  });
  const count = (status) => planned.filter((row) => row.status === status).length;
  return { rows: planned, summary: { total: planned.length, imported: count("new"), updated: count("update"), skipped: count("skip"), invalid: count("invalid") } };
};

/** Writes what planImport decided. Rows are attached to `campaignId` (a Nota campaign) when given. */
const commitImport = async (plan, { campaignId, user }) => {
  const campaign = campaignId ? await Campaign.findById(campaignId).select("_id").lean() : null;
  if (campaignId && !campaign) throw httpError(400, "INVALID_CAMPAIGN", "الحملة غير موجودة");
  const stamp = { createdBy: user && user._id, createdByName: user && user.name };
  let imported = 0;
  let updated = 0;
  let skipped = plan.summary.skipped;
  for (const row of plan.rows) {
    if (row.status === "new") {
      try {
        await Lead.create({
          name: row.name, phone: row.phone || undefined, profileLink: row.profileLink || undefined, source: row.source,
          ...(campaign ? { campaignId: campaign._id } : {}),
          ...(row.createdAt ? { createdAt: row.createdAt } : {}),
          notes: [row.campaignName && `حملة: ${row.campaignName}`, row.adName && `إعلان: ${row.adName}`].filter(Boolean).join(" | ") || undefined,
          ...stamp,
        });
        imported += 1;
      } catch (error) {
        if (!(error && error.code === 11000)) throw error;
        skipped += 1; // another request saved the same phone in between
      }
    } else if (row.status === "update") {
      const set = { name: row.name, ...(row.profileLink ? { profileLink: row.profileLink } : {}), ...(campaign ? { campaignId: campaign._id } : {}) };
      await Lead.updateOne({ _id: row.existingId }, { $set: set });
      updated += 1;
    }
  }
  return { total: plan.summary.total, imported, updated, skipped, invalid: plan.summary.invalid };
};

module.exports = {
  MAX_IMPORT_ROWS,
  commitImport,
  duplicateError,
  leadView,
  phoneVariants,
  planImport,
  purchasesOf,
  readLeadInput,
  suggestMapping,
  validProfileLink,
};
