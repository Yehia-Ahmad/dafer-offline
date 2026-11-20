// Online Stage 7A: campaign codes, tracking links, landing validation and the attribution snapshot stored on a website order.
// Nothing here touches sales, returns, payments or stock.
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Campaign = require("../models/campaign.model");
const { CampaignClick, CampaignVisit } = require("../models/campaignStat.model");
const WebOrder = require("../models/webOrder.model");
const Expense = require("../models/expense.model");
const Lead = require("../models/lead.model");

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i l o 0 1)
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const randomCode = (length = 6) => {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
};

const generateCode = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomCode(6 + (attempt > 4 ? 1 : 0));
    if (!(await Campaign.exists({ code }))) return code;
  }
  return randomCode(10);
};

/** A custom landing path must stay on the shop's own site: one leading "/", no scheme, no "//", no backslash, no control chars. */
const validLandingPath = (value) => {
  if (typeof value !== "string") return false;
  const path = value.trim();
  if (path.length < 1 || path.length > 300) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  if (/^\/[^?#]*:\/\//.test(path) || /^\/\/|^\/https?:/i.test(path)) return false;
  return true;
};

const landingPath = (campaign) => {
  const landing = campaign.landing || {};
  if (landing.kind === "product" && landing.ref) return `/p/${landing.ref}`;
  if (landing.kind === "category" && landing.ref) return `/c/${landing.ref}`;
  if (landing.kind === "path" && validLandingPath(landing.path)) return landing.path.trim();
  return "/";
};

const withQuery = (path, params) => {
  const hashAt = path.indexOf("#");
  const base = hashAt === -1 ? path : path.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : path.slice(hashAt);
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${query}${hash}`;
};

/** The landing path with the three utm parameters. */
const fullPath = (campaign) => withQuery(landingPath(campaign), { utm_source: campaign.platform, utm_medium: campaign.type, utm_campaign: campaign.code });

const links = (campaign, origin) => {
  const base = String(origin || "").replace(/\/+$/, "");
  return { fullLink: `${base}${fullPath(campaign)}`, shortLink: `${base}/go/${campaign.code}` };
};

/** True once anything refers to the code: a click, a visit, an attributed order or a lead. Then the code can no longer change. */
const codeInUse = async (campaign) => {
  const id = campaign._id;
  const checks = await Promise.all([
    CampaignClick.exists({ campaignId: id }),
    CampaignVisit.exists({ campaignId: id }),
    WebOrder.exists({ "attribution.campaignId": id }),
    Expense.exists({ campaignId: id }),
    Lead.exists({ campaignId: id }),
  ]);
  return checks.some(Boolean);
};

/**
 * The attribution snapshot for an order: { code, campaignId, source, medium, landedAt } or null (a direct order).
 * Never throws for bad input: an unknown, archived, future or expired attribution simply makes the order "direct".
 * source/medium come from the Campaign, never from the browser.
 */
const resolveAttribution = async (input, { windowDays, now = new Date(), session = null } = {}) => {
  if (!input || typeof input !== "object") return null;
  const code = typeof input.code === "string" ? input.code.trim().toLowerCase() : "";
  if (!CODE_PATTERN.test(code)) return null;
  const landedAt = new Date(input.landedAt);
  if (Number.isNaN(landedAt.getTime())) return null;
  if (landedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) return null;
  if (now.getTime() - landedAt.getTime() > Number(windowDays || 7) * DAY_MS) return null;
  const campaign = await Campaign.findOne({ code, status: { $ne: "archived" } }).session(session).select("code platform type").lean();
  if (!campaign) return null;
  return { code: campaign.code, campaignId: campaign._id, source: campaign.platform, medium: campaign.type, landedAt };
};

const deviceOf = (userAgent) => {
  const ua = String(userAgent || "");
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android/i.test(ua)) return "mobile";
  if (/windows|macintosh|linux|cros/i.test(ua)) return "desktop";
  return "other";
};

const isId = (value) => typeof value === "string" && mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === value.toLowerCase();

module.exports = {
  CODE_PATTERN,
  codeInUse,
  deviceOf,
  fullPath,
  generateCode,
  isId,
  landingPath,
  links,
  resolveAttribution,
  validLandingPath,
};
