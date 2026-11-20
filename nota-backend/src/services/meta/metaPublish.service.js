// Online Stage 7C: creating a Facebook/Instagram campaign from Nota, and managing what Nota created.
// THIS IS THE FIRST CODE THAT CAN MAKE THE SHOP SPEND MONEY. The rules that keep it safe:
//  - nothing runs until the owner switches the campaign on (everything is created PAUSED at the campaign; ad set and ads are ACTIVE
//    under it, so one switch starts or stops all of it);
//  - budgets have a ceiling (marketing settings, EGP) that the server enforces, also for budget changes;
//  - Nota only ever touches objects it created (MetaPublish records), see metaWriter's allowlist;
//  - each Meta id is saved the moment Meta returns it, so a retry continues and never re-creates (unknown results are searched by the
//    hidden tag [nota:<publishId>] before anything is sent again).
// Meta never takes money from Nota: no payment data, no billing endpoint. The card of the ad account is charged in Ads Manager.
const crypto = require("node:crypto");
const os = require("node:os");
const MetaConnection = require("../../models/metaConnection.model");
const MetaCampaign = require("../../models/metaCampaign.model");
const MetaPublish = require("../../models/metaPublish.model");
const MetaPublishImage = require("../../models/metaPublishImage.model");
const ExchangeRate = require("../../models/exchangeRate.model");
const Campaign = require("../../models/campaign.model");
const Product = require("../../models/product.model");
const WebsiteSettings = require("../../models/websiteSettings.model");
const clock = require("../../utils/clock");
const { httpError } = require("../../auth/middleware");
const { effectiveSettings } = require("../../store/catalog");
const { fullPath } = require("../campaigns.service");
const { createClient, MetaError } = require("./metaClient");
const { createWriter } = require("./metaWriter");
const { rateOn, convertMinor } = require("./metaMoney");
const sync = require("./metaSync.service");

// ---------------------------------------------------------------------------------------------------------------------
// constants

/** The four token permissions publishing needs (Meta's "Ads that click to Instagram" guide). ads_read alone keeps 7B working, publishing off. */
const PUBLISH_SCOPES = ["ads_management", "pages_manage_ads", "pages_read_engagement", "pages_show_list"];
const LEASE_MS = 10 * 60 * 1000;
const MAX_ADS = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_SIDE = 600;
const GOOD_IMAGE_SIDE = 1080;
const CTAS = ["SHOP_NOW", "ORDER_NOW", "LEARN_MORE", "CONTACT_US", "GET_OFFER"];
const GOALS = { traffic: { objective: "OUTCOME_TRAFFIC", optimization_goal: "LINK_CLICKS" }, sales: { objective: "OUTCOME_SALES", optimization_goal: "OFFSITE_CONVERSIONS" } };
const ACCOUNT_OK_STATUSES = new Set([1, 9]); // ACTIVE, IN_GRACE_PERIOD

// Currencies whose Meta offset is 100 (two decimals). v1 supports only these; any other account currency disables publishing.
const OFFSET_100 = new Set(["EGP", "USD", "EUR", "GBP", "SAR", "AED", "QAR", "CAD", "AUD", "TRY", "MAD", "ILS", "PLN", "CHF", "SEK", "NOK", "DKK", "MXN", "BRL", "INR", "ZAR", "SGD", "HKD", "NZD", "THB", "MYR", "PHP", "RON", "BGN", "CZK"]);

/**
 * Creative enhancements opted out on EVERY creative. product_extensions: v27 may switch Product showcase on by itself and it cannot be
 * changed later on that creative (v27.0 changelog; the shape is the changelog's own). The others are the features whose names say they act
 * on the ad TEXT (the shop's text is Egyptian Arabic and must stay word for word): opt-out shape {enroll_status: OPT_OUT} from Meta's
 * AdCreativeFeaturesSpec reference (checked 2026-11-20). Meta's docs do not say which features rewrite text: this is by name, and validate_only
 * runs on each creative first, so a wrong shape stops the publish before anything is created. Visual features stay at Meta's default.
 */
const CREATIVE_OPT_OUT = Object.freeze({
  product_extensions: { enroll_status: "OPT_OUT", action_metadata: { type: "MANUAL" } },
  text_optimizations: { enroll_status: "OPT_OUT" },
  description_automation: { enroll_status: "OPT_OUT" },
  text_translation: { enroll_status: "OPT_OUT" },
});

// ---------------------------------------------------------------------------------------------------------------------
// small helpers

const bad = (message, code = "INVALID_VALUE") => httpError(400, code, message);
const conflict = (code, message) => httpError(409, code, message);
const text = (value, max) => String(value === undefined || value === null ? "" : value).trim().slice(0, max);
const ownerId = () => `${os.hostname()}:${process.pid}`;
const newPublishId = () => crypto.randomBytes(6).toString("hex");
const tagOf = (publishId) => `[nota:${publishId}]`;
const isPublishId = (value) => /^[a-f0-9]{12}$/.test(String(value || ""));

const hasPublishScopes = (scopes) => PUBLISH_SCOPES.every((scope) => (scopes || []).includes(scope));
const missingScopes = (scopes) => PUBLISH_SCOPES.filter((scope) => !(scopes || []).includes(scope));
const currencySupported = (currency) => OFFSET_100.has(String(currency || "").toUpperCase());

/** The site's public base URL: NOTA_PUBLIC_URL, https, a real host name (never localhost, an IP or an internal name). */
const publicSiteBase = () => {
  const raw = String(process.env.NOTA_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return null;
  if (!host.includes(".") || host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/\.(local|localhost|internal|test|lan|home|invalid|example)$/.test(host)) return null;
  return `${url.protocol}//${url.host}`;
};

/** "2026-11-25T10:00" read in the ad account's time zone -> a UTC Date (null when invalid). */
const zonedLocalToDate = (local, timeZone) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ""));
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(guess)) return null;
  let offset = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((part) => part.type === type).value);
    offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - guess;
  } catch { offset = 0; }
  return new Date(guess - offset);
};

// ----- images -----

const stripDataUri = (value) => {
  const raw = String(value || "").trim();
  const at = raw.indexOf(";base64,");
  return raw.startsWith("data:") && at !== -1 ? raw.slice(at + ";base64,".length) : raw;
};

/** { mime, width, height } of a jpg or png buffer, or null. Only the headers are read. */
const imageInfo = (buffer) => {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
    return { mime: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at += 1; continue; }
      const marker = buffer[at + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const length = buffer.readUInt16BE(at + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
  }
  return null;
};

/** Checks an image buffer for the rules of the brief. Returns { warnings } or throws a 400. */
const checkImage = (buffer, label) => {
  if (!buffer || !buffer.length) throw bad(`${label}: الصورة فاضية`, "IMAGE_INVALID");
  if (buffer.length > MAX_IMAGE_BYTES) throw bad(`${label}: الصورة أكبر من 8 ميجا`, "IMAGE_INVALID");
  const info = imageInfo(buffer);
  if (!info) throw bad(`${label}: الصورة لازم تكون jpg أو png`, "IMAGE_INVALID");
  if (info.width < MIN_IMAGE_SIDE || info.height < MIN_IMAGE_SIDE) throw bad(`${label}: الصورة أصغر من ${MIN_IMAGE_SIDE}×${MIN_IMAGE_SIDE}`, "IMAGE_INVALID");
  const warnings = [];
  if (info.width < GOOD_IMAGE_SIDE || info.height < GOOD_IMAGE_SIDE) warnings.push(`${label}: الصورة أقل من ${GOOD_IMAGE_SIDE}×${GOOD_IMAGE_SIDE} وممكن تطلع أقل وضوح`);
  return { info, warnings };
};

const productImageBase64 = async (productId, index) => {
  if (!/^[a-f0-9]{24}$/i.test(String(productId))) return null;
  const product = await Product.findById(productId).select("image website.images").lean();
  if (!product) return null;
  const list = [product.image, ...((product.website && product.website.images) || [])].filter(Boolean);
  const value = list[Number(index) || 0];
  return value ? stripDataUri(value) : null;
};

// ----- money -----

const minorOf = (amount) => Math.round(Number(amount) * 100);

/** Minor units of the ad account currency -> minor units of EGP with the 7B rate. null when there is no rate. */
const toEgpMinor = async (minor, currency) => {
  if (String(currency).toUpperCase() === "EGP") return minor;
  const rates = await ExchangeRate.find({ currency: String(currency).toUpperCase() }).select("rate effectiveFrom").lean();
  const rate = rateOn(rates, clock.localDayString(clock.now()));
  return rate ? convertMinor(minor, rate.rate) : null;
};

/** Refuses an amount above the ceiling (or when there is no rate). `kind` is "daily" or "total". */
const checkCeiling = async ({ minor, currency, kind }) => {
  const rules = effectiveSettings(await WebsiteSettings.findOne({ key: "default" }).lean()).marketing;
  const ceilingEgp = kind === "daily" ? rules.maxDailyBudgetEgp : rules.maxTotalBudgetEgp;
  const egpMinor = await toEgpMinor(minor, currency);
  if (egpMinor === null) throw conflict("RATE_REQUIRED", "محتاج سعر صرف للعملة عشان نراجع أقصى ميزانية. ضيف السعر في ربط حساب الإعلانات");
  if (egpMinor > Math.round(ceilingEgp * 100)) {
    throw conflict("BUDGET_OVER_CEILING", `الميزانية أعلى من أقصى ميزانية ${kind === "daily" ? "يومية" : "إجمالية"} (${ceilingEgp} جنيه). ارفع الحد من إعدادات التسويق لو عايز.`);
  }
  return { egpMinor, ceilingEgp };
};

// ---------------------------------------------------------------------------------------------------------------------
// context: the connection, readiness and the Meta clients

const credentialsOf = (connection) => sync.credentialsOf(connection);

const ownsObject = async (id) => {
  const value = String(id);
  return Boolean(await MetaPublish.exists({ $or: [{ metaCampaignId: value }, { adSetId: value }, { "ads.adId": value }] }));
};

/** The connection with everything publishing needs, or an httpError that says what is missing. */
const publishContext = async () => {
  const connection = await MetaConnection.findById("default").lean();
  if (!connection || !connection.connected || !connection.tokenSealed) throw conflict("NOT_CONNECTED", "حساب الإعلانات غير مربوط");
  if (!hasPublishScopes(connection.scopes)) throw conflict("PUBLISH_PERMISSION_MISSING", `التوكن ناقصه صلاحيات النشر: ${missingScopes(connection.scopes).join("، ")}`);
  if (!connection.pageId) throw conflict("PAGE_REQUIRED", "اختار صفحة فيسبوك في ربط حساب الإعلانات الأول");
  const currency = String((connection.account && connection.account.currency) || "").toUpperCase();
  if (!currencySupported(currency)) throw conflict("CURRENCY_NOT_SUPPORTED", `عملة حساب الإعلانات (${currency || "؟"}) مش مدعومة للنشر من نوتا حاليًا`);
  const status = connection.account && connection.account.accountStatus;
  if (Number.isFinite(status) && !ACCOUNT_OK_STATUSES.has(status)) throw conflict("PAYMENT_REQUIRED", new MetaError("PAYMENT_REQUIRED").message);
  const credentials = credentialsOf(connection);
  return {
    connection, currency, credentials,
    reader: createClient(credentials),
    writer: createWriter({ ...credentials, ownsObject }),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// the spec the owner confirms

/** What the wizard needs before it opens: readiness, ceiling, pixel, currency. Calls Meta (GET) only for the pixel list. */
const options = async ({ checkPixel = true } = {}) => {
  const connection = await MetaConnection.findById("default").lean();
  const settings = effectiveSettings(await WebsiteSettings.findOne({ key: "default" }).lean()).marketing;
  const scopes = (connection && connection.scopes) || [];
  const currency = connection && connection.account ? String(connection.account.currency || "").toUpperCase() : "";
  const blockers = [];
  if (!connection || !connection.connected) blockers.push({ code: "NOT_CONNECTED", help: "meta-connection" });
  else {
    if (!hasPublishScopes(scopes)) blockers.push({ code: "PUBLISH_PERMISSION_MISSING", missing: missingScopes(scopes), help: "meta-connection" });
    if (!connection.pageId) blockers.push({ code: "PAGE_REQUIRED", help: "meta-connection" });
    if (!currencySupported(currency)) blockers.push({ code: "CURRENCY_NOT_SUPPORTED", currency, help: "meta-connection" });
    const status = connection.account && connection.account.accountStatus;
    if (Number.isFinite(status) && !ACCOUNT_OK_STATUSES.has(status)) blockers.push({ code: "PAYMENT_REQUIRED", help: "meta-connection" });
  }
  if (!publicSiteBase()) blockers.push({ code: "SITE_NOT_PUBLIC", help: "campaigns" });
  let pixel = { configured: Boolean(settings.metaPixelId), visible: false, lastFiredTime: null };
  if (checkPixel && settings.metaPixelId && connection && connection.connected && connection.tokenSealed) {
    try {
      const rows = await createClient(credentialsOf(connection)).pixels();
      const found = rows.find((row) => String(row.id) === settings.metaPixelId);
      pixel = { configured: true, visible: Boolean(found), lastFiredTime: found && found.last_fired_time ? found.last_fired_time : null };
    } catch { /* the wizard shows the sales goal as unavailable */ }
  }
  const needsRate = Boolean(currency && currency !== "EGP");
  const rates = needsRate ? await ExchangeRate.find({ currency }).select("rate effectiveFrom").lean() : [];
  const rate = needsRate ? rateOn(rates, clock.localDayString(clock.now())) : null;
  return {
    ready: blockers.length === 0,
    blockers,
    mode: hasPublishScopes(scopes) ? "readwrite" : "read",
    currency, timezoneName: connection && connection.account ? connection.account.timezoneName || "" : "",
    page: connection && connection.pageId ? { id: connection.pageId, name: connection.pageName || "" } : null,
    instagram: connection && connection.instagramId ? { id: connection.instagramId, name: connection.instagramName || "" } : null,
    ceiling: { dailyEgp: settings.maxDailyBudgetEgp, totalEgp: settings.maxTotalBudgetEgp },
    rate: rate ? rate.rate : null, needsRate,
    minDailyBudgetMinor: connection && connection.minDailyBudgetMinor ? connection.minDailyBudgetMinor : null,
    pixel,
    salesAllowed: Boolean(pixel.configured && pixel.visible),
    ctas: CTAS,
  };
};

/**
 * Validates and normalises the wizard's input into the spec stored on the publish record. Throws a 400/409 with a fixed Arabic message.
 * Returns { spec, uploads: [{ index, imageId }], warnings }.
 */
const normalizeSpec = async (input, { campaign, connection, pixelOk }) => {
  const body = input && typeof input === "object" ? input : {};
  const currency = String((connection.account && connection.account.currency) || "").toUpperCase();
  const warnings = [];

  const goal = text(body.goal, 10);
  if (!GOALS[goal]) throw bad("اختار هدف الحملة: زيارات للموقع أو مبيعات من الموقع", "INVALID_GOAL");
  if (goal === "sales" && !pixelOk) throw conflict("PIXEL_REQUIRED", "هدف المبيعات محتاج بكسل ميتا مظبوط في إعدادات التسويق ومرئي لحساب الإعلانات");

  // ----- budget
  const budget = body.budget && typeof body.budget === "object" ? body.budget : {};
  const type = budget.type === "lifetime" ? "lifetime" : budget.type === "daily" ? "daily" : "";
  if (!type) throw bad("اختار نوع الميزانية: يومية أو إجمالية لفترة", "INVALID_BUDGET");
  const amount = Number(budget.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) / 100 !== amount) throw bad("الميزانية لازم تكون رقم موجب (لحد خانتين عشريتين)", "INVALID_BUDGET");
  const amountMinor = minorOf(amount);
  const tz = (connection.account && connection.account.timezoneName) || "UTC";
  let startTime = null;
  if (budget.startTime) {
    const start = zonedLocalToDate(budget.startTime, tz);
    if (!start) throw bad("وقت البداية غير صالح", "INVALID_DATE");
    if (start.getTime() < clock.now().getTime() - 5 * 60 * 1000) throw bad("وقت البداية في الماضي", "INVALID_DATE");
    startTime = start;
  }
  let endTime = null;
  if (type === "lifetime") {
    endTime = zonedLocalToDate(budget.endTime, tz);
    if (!endTime) throw bad("الميزانية الإجمالية محتاجة تاريخ نهاية", "INVALID_DATE");
    const from = startTime || clock.now();
    if (endTime.getTime() < from.getTime() + 24 * 60 * 60 * 1000) throw bad("تاريخ النهاية لازم يكون بعد البداية بيوم على الأقل", "INVALID_DATE");
  } else if (budget.endTime) {
    endTime = zonedLocalToDate(budget.endTime, tz);
    if (!endTime || endTime.getTime() <= (startTime || clock.now()).getTime()) throw bad("تاريخ النهاية غير صالح", "INVALID_DATE");
  }
  if (type === "daily" && connection.minDailyBudgetMinor && amountMinor < connection.minDailyBudgetMinor) throw bad(new MetaError("BUDGET_TOO_LOW").message, "BUDGET_TOO_LOW");
  const { egpMinor, ceilingEgp } = await checkCeiling({ minor: amountMinor, currency, kind: type === "daily" ? "daily" : "total" });

  // ----- audience
  const audience = body.audience && typeof body.audience === "object" ? body.audience : {};
  const advantage = audience.advantage !== false;
  const locations = [];
  for (const place of Array.isArray(audience.locations) ? audience.locations.slice(0, 30) : []) {
    const key = text(place && place.key, 20);
    const kind = place && place.type === "city" ? "city" : "region";
    if (!/^\d{1,12}$/.test(key)) throw bad("مكان غير صالح في الجمهور", "INVALID_AUDIENCE");
    locations.push({ key, type: kind, name: text(place.name, 80) });
  }
  let ageMin = 18; let ageMax; let gender = "all";
  if (advantage) {
    ageMin = audience.ageMin === undefined ? 18 : Number(audience.ageMin);
    if (!Number.isInteger(ageMin) || ageMin < 18 || ageMin > 25) throw bad("مع الجمهور المقترح (Advantage+) أقل سن من 18 لحد 25", "INVALID_AUDIENCE");
  } else {
    ageMin = Number(audience.ageMin === undefined ? 18 : audience.ageMin);
    ageMax = Number(audience.ageMax === undefined ? 65 : audience.ageMax);
    if (!Number.isInteger(ageMin) || !Number.isInteger(ageMax) || ageMin < 18 || ageMax > 65 || ageMin > ageMax) throw bad("السن من 18 لحد 65", "INVALID_AUDIENCE");
    gender = ["all", "male", "female"].includes(audience.gender) ? audience.gender : "all";
  }

  // ----- ads
  const ads = Array.isArray(body.ads) ? body.ads : [];
  if (ads.length < 1 || ads.length > MAX_ADS) throw bad(`عدد الإعلانات من 1 لحد ${MAX_ADS}`, "INVALID_ADS");
  const outAds = [];
  const uploads = [];
  for (let i = 0; i < ads.length; i += 1) {
    const ad = ads[i] && typeof ads[i] === "object" ? ads[i] : {};
    const label = `إعلان ${i + 1}`;
    const message = text(ad.primaryText, 600);
    if (!message) throw bad(`${label}: النص الأساسي مطلوب`, "INVALID_ADS");
    if (message.length > 500) throw bad(`${label}: النص الأساسي أطول من 500 حرف`, "INVALID_ADS");
    const headline = text(ad.headline, 200);
    if (headline.length > 40) warnings.push(`${label}: العنوان أطول من 40 حرف وممكن يتقص`);
    const description = text(ad.description, 200);
    const cta = CTAS.includes(ad.cta) ? ad.cta : "SHOP_NOW";
    const image = ad.image && typeof ad.image === "object" ? ad.image : {};
    let imageSpec;
    let buffer;
    if (image.kind === "product") {
      const base64 = await productImageBase64(image.productId, image.index);
      if (!base64) throw bad(`${label}: صورة المنتج غير موجودة`, "IMAGE_INVALID");
      buffer = Buffer.from(base64, "base64");
      imageSpec = { kind: "product", productId: String(image.productId), index: Number(image.index) || 0 };
    } else if (image.kind === "upload") {
      // Uploaded on its own first (POST .../publish/images, one request per image): the draft only names it.
      const staged = /^[a-f0-9]{32}$/.test(String(image.imageId))
        ? await MetaPublishImage.findOne({ imageId: String(image.imageId), campaignId: campaign._id, publishId: { $regex: "^stage-" } }).lean()
        : null;
      if (!staged) throw bad(`${label}: الصورة لازم تترفع الأول`, "IMAGE_INVALID");
      buffer = Buffer.from(staged.bytesBase64, "base64");
      imageSpec = { kind: "upload", imageId: staged.imageId };
    } else {
      throw bad(`${label}: اختار صورة`, "IMAGE_INVALID");
    }
    const checked = checkImage(buffer, label);
    warnings.push(...checked.warnings);
    if (imageSpec.kind === "upload") uploads.push({ index: i, imageId: imageSpec.imageId });
    let landing = { kind: "campaign" };
    if (ad.landing && ad.landing.kind === "product") {
      if (!/^[a-f0-9]{24}$/i.test(String(ad.landing.productId))) throw bad(`${label}: منتج الصفحة غير صالح`, "INVALID_ADS");
      landing = { kind: "product", productId: String(ad.landing.productId) };
    }
    outAds.push({ primaryText: message, headline, description, cta, image: imageSpec, landing });
  }

  return {
    spec: {
      goal, currency,
      budget: { type, amountMinor, amount, startTime, endTime, egpMinor, ceilingEgp },
      audience: { advantage, locations, ageMin, ...(ageMax ? { ageMax } : {}), gender },
      ads: outAds,
      pageId: connection.pageId, instagramId: connection.instagramId || undefined,
      pixelId: goal === "sales" ? campaign.pixelId : undefined,
    },
    uploads, warnings,
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// the request bodies

const metaName = (publish, campaign, suffix = "") => `${text(campaign.name, 120)} · ${campaign.code}${suffix} ${tagOf(publish.publishId)}`;

const campaignBody = (publish, campaign) => {
  const { spec } = publish;
  return {
    name: metaName(publish, campaign),
    objective: GOALS[spec.goal].objective,
    status: "PAUSED",
    special_ad_categories: [],
    buying_type: "AUCTION",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    // Advantage+ campaign budget: the budget lives on the campaign.
    ...(spec.budget.type === "daily" ? { daily_budget: spec.budget.amountMinor } : { lifetime_budget: spec.budget.amountMinor }),
  };
};

const targetingOf = (spec) => {
  const geo = { countries: ["EG"] };
  const regions = spec.audience.locations.filter((place) => place.type === "region").map((place) => ({ key: place.key }));
  const cities = spec.audience.locations.filter((place) => place.type === "city").map((place) => ({ key: place.key }));
  if (regions.length) geo.regions = regions;
  if (cities.length) geo.cities = cities;
  // No device or OS targeting in v1 (no user_device / user_os / individual_setting.device), so v27's "reach more people across other
  // mobile devices" expansion does not apply to these ad sets. A later stage that adds device targeting MUST send device: 0 itself.
  const targeting = { geo_locations: geo, age_min: spec.audience.ageMin, targeting_automation: { advantage_audience: spec.audience.advantage ? 1 : 0 } };
  if (!spec.audience.advantage) {
    // With Advantage+ audience on, Meta fixes the maximum age at 65 and only age_min (18-25) may be sent; off, the owner sets the range.
    targeting.age_max = spec.audience.ageMax;
    if (spec.audience.gender === "male") targeting.genders = [1];
    if (spec.audience.gender === "female") targeting.genders = [2];
  }
  return targeting; // placements: Advantage+ placements (nothing sent)
};

const adSetBody = (publish, campaign) => {
  const { spec } = publish;
  const body = {
    name: metaName(publish, campaign, " · مجموعة"),
    campaign_id: publish.metaCampaignId,
    status: "ACTIVE",
    billing_event: "IMPRESSIONS",
    optimization_goal: GOALS[spec.goal].optimization_goal,
    destination_type: "WEBSITE",
    targeting: targetingOf(spec),
  };
  if (spec.budget.startTime) body.start_time = new Date(spec.budget.startTime).toISOString();
  else if (spec.budget.type === "lifetime") body.start_time = clock.now().toISOString();
  if (spec.budget.endTime) body.end_time = new Date(spec.budget.endTime).toISOString();
  if (spec.goal === "sales") body.promoted_object = { pixel_id: spec.pixelId, custom_event_type: "PURCHASE" };
  return body;
};

const landingLink = (publish, campaign, ad) => {
  const base = publicSiteBase();
  if (!base) throw conflict("SITE_NOT_PUBLIC", SITE_NOT_PUBLIC_MESSAGE);
  // The UTM link, never the /go/ short link: Meta's crawler would inflate the click counter.
  const landing = ad.landing && ad.landing.kind === "product" ? { kind: "product", ref: ad.landing.productId } : campaign.landing;
  return `${base}${fullPath({ platform: campaign.platform, type: campaign.type, code: campaign.code, landing })}`;
};

const creativeBody = (publish, campaign, index) => {
  const ad = publish.spec.ads[index];
  const link = landingLink(publish, campaign, ad);
  const hash = publish.ads[index].imageHash;
  const linkData = {
    image_hash: hash, link, message: ad.primaryText,
    ...(ad.headline ? { name: ad.headline } : {}),
    ...(ad.description ? { description: ad.description } : {}),
    call_to_action: { type: ad.cta, value: { link } },
  };
  return {
    name: metaName(publish, campaign, ` · إعلان ${index + 1}`),
    object_story_spec: { page_id: publish.spec.pageId, ...(publish.spec.instagramId ? { instagram_user_id: publish.spec.instagramId } : {}), link_data: linkData },
    degrees_of_freedom_spec: { creative_features_spec: CREATIVE_OPT_OUT },
  };
};

const adBody = (publish, campaign, index) => ({
  name: metaName(publish, campaign, ` · إعلان ${index + 1}`),
  adset_id: publish.adSetId,
  creative: { creative_id: publish.ads[index].creativeId },
  status: "ACTIVE",
});

// ---------------------------------------------------------------------------------------------------------------------
// drafts, preview, run

const loadCampaign = async (id) => {
  if (!/^[a-f0-9]{24}$/i.test(String(id))) throw httpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة");
  const campaign = await Campaign.findById(id).select("name code platform type landing").lean();
  if (!campaign) throw httpError(404, "CAMPAIGN_NOT_FOUND", "الحملة غير موجودة");
  if (!["facebook", "instagram"].includes(campaign.platform)) throw conflict("PLATFORM_NOT_LINKABLE", "النشر متاح لحملات فيسبوك وإنستجرام بس");
  return campaign;
};

const view = (publish) => ({
  publishId: publish.publishId,
  campaignId: publish.campaignId,
  status: publish.status,
  goal: publish.spec && publish.spec.goal,
  steps: Object.fromEntries(Object.entries(publish.steps || {}).map(([name, step]) => [name, { state: step.state, errorCode: step.errorCode || null, errorMessage: step.errorMessage || null }])),
  metaCampaignId: publish.metaCampaignId || null,
  ads: (publish.ads || []).map((ad) => ({ index: ad.index, hasImage: Boolean(ad.imageHash), creativeId: ad.creativeId || null, adId: ad.adId || null, appliedFeatures: ad.appliedFeatures || null })),
  lastError: publish.lastError && publish.lastError.code ? { step: publish.lastError.step, code: publish.lastError.code, message: publish.lastError.message } : null,
  publishedAt: publish.publishedAt || null,
});

/** Step 1 of the wizard's confirm: validates the spec and stores a draft (no call to Meta). */
const SITE_NOT_PUBLIC_MESSAGE = "رابط الموقع مش عام (https باسم موقع حقيقي). مينفعش ننشر إعلان لرابط تجريبي.";

const createDraft = async ({ campaignId, input, user }) => {
  const campaign = await loadCampaign(campaignId);
  if (!publicSiteBase()) throw conflict("SITE_NOT_PUBLIC", SITE_NOT_PUBLIC_MESSAGE);
  const context = await publishContext();
  const pixelId = effectiveSettings(await WebsiteSettings.findOne({ key: "default" }).lean()).marketing.metaPixelId;
  let pixelOk = false;
  if (input && input.goal === "sales" && pixelId) {
    const rows = await context.reader.pixels().catch((error) => { throw metaFailure(error); });
    pixelOk = rows.some((row) => String(row.id) === pixelId);
  }
  const { spec, uploads, warnings } = await normalizeSpec(input, { campaign: { ...campaign, pixelId }, connection: context.connection, pixelOk });
  // An earlier draft of this campaign that was never run (the owner went back and changed something) holds nothing on Meta: drop it
  // together with its uploaded images, so abandoned drafts never pile up (up to 40 MB of images each).
  const stale = await MetaPublish.find({ campaignId: campaign._id, status: "draft", metaCampaignId: { $exists: false } }).select("publishId").lean();
  if (stale.length) {
    const ids = stale.map((row) => row.publishId);
    await MetaPublishImage.deleteMany({ publishId: { $in: ids } });
    await MetaPublish.deleteMany({ publishId: { $in: ids }, status: "draft" });
  }
  const publishId = newPublishId();
  const publish = await MetaPublish.create({
    publishId, campaignId: campaign._id, adAccountId: context.connection.adAccountId, spec,
    status: "draft", ads: spec.ads.map((_ad, index) => ({ index })),
    createdById: user && user._id, createdByName: user && user.name,
  });
  // Claim the staged images: they now belong to this draft (and go with it when it is finished, cancelled or dropped).
  for (const upload of uploads) {
    await MetaPublishImage.updateOne({ imageId: upload.imageId, campaignId: campaign._id }, { $set: { publishId, index: upload.index } });
  }
  return { publish: publish.toObject(), warnings };
};

/** One uploaded image (raw jpg/png bytes, one request each, at most 8 MB): checked, then staged until a draft claims it. */
const STAGED_KEEP_MS = 24 * 60 * 60 * 1000;
const stageImage = async ({ campaignId, buffer }) => {
  const campaign = await loadCampaign(campaignId);
  const checked = checkImage(buffer, "الصورة");
  const stale = new Date(clock.now().getTime() - STAGED_KEEP_MS);
  await MetaPublishImage.deleteMany({ publishId: { $regex: "^stage-" }, createdAt: { $lt: stale } });
  const imageId = crypto.randomBytes(16).toString("hex");
  await MetaPublishImage.create({ publishId: `stage-${imageId}`, index: 0, imageId, campaignId: campaign._id, mime: checked.info.mime, bytesBase64: buffer.toString("base64") });
  return { imageId, mime: checked.info.mime, width: checked.info.width, height: checked.info.height, bytes: buffer.length, warnings: checked.warnings };
};

const metaFailure = (error) => {
  if (error instanceof MetaError) return httpError(error.code === "RATE_LIMITED" ? 429 : 400, error.code, error.message);
  return httpError(502, "META_ERROR", new MetaError("META_ERROR").message);
};

const loadPublish = async (publishId, campaignId) => {
  if (!isPublishId(publishId)) throw httpError(404, "PUBLISH_NOT_FOUND", "عملية النشر غير موجودة");
  const publish = await MetaPublish.findOne({ publishId, ...(campaignId ? { campaignId } : {}) }).lean();
  if (!publish) throw httpError(404, "PUBLISH_NOT_FOUND", "عملية النشر غير موجودة");
  return publish;
};

const adImageBase64 = async (publish, index) => {
  const ad = publish.spec.ads[index];
  if (ad.image.kind === "product") return productImageBase64(ad.image.productId, ad.image.index);
  const row = await MetaPublishImage.findOne({ publishId: publish.publishId, index }).lean();
  return row ? row.bytesBase64 : null;
};

/** Uploads one ad's image once (the same bytes give the same hash) and saves the hash. */
const ensureImageHash = async (publish, index, writer) => {
  const known = publish.ads[index].imageHash;
  if (known) return known;
  const base64 = await adImageBase64(publish, index);
  if (!base64) throw new MetaError("IMAGE_REJECTED");
  const { body } = await writer.uploadImage(base64);
  const images = body && body.images && typeof body.images === "object" ? Object.values(body.images) : [];
  const hash = images[0] && images[0].hash ? String(images[0].hash) : "";
  if (!/^[A-Za-z0-9]{16,64}$/.test(hash)) throw new MetaError("IMAGE_REJECTED");
  await MetaPublish.updateOne({ _id: publish._id }, { $set: { [`ads.${index}.imageHash`]: hash } });
  publish.ads[index].imageHash = hash;
  return hash;
};

/** Meta's own preview of one ad (draft or not): uploads its image if needed (no spend), then GET generatepreviews. */
const preview = async ({ publishId, campaignId, index, format }) => {
  const publish = await loadPublish(publishId, campaignId);
  if (!["draft", "failed"].includes(publish.status)) throw conflict("PUBLISH_FINISHED", "العملية دي خلصت");
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= publish.spec.ads.length) throw bad("إعلان غير موجود", "INVALID_ADS");
  const adFormat = format === "instagram" ? "INSTAGRAM_STANDARD" : format === "mobile" ? "MOBILE_FEED_STANDARD" : "DESKTOP_FEED_STANDARD";
  const campaign = await loadCampaign(publish.campaignId);
  const context = await publishContext();
  try {
    await ensureImageHash(publish, i, context.writer);
    const creative = creativeBody(publish, campaign, i);
    delete creative.name;
    const frames = await context.reader.previews(creative, adFormat);
    return { frames };
  } catch (error) { throw metaFailure(error); }
};

// ----- the run -----

const acquireLease = (publishId) => {
  const now = clock.now();
  return MetaPublish.findOneAndUpdate(
    { publishId, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }, { lockedUntil: { $exists: false } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS), lockOwner: ownerId() } },
    { new: true }
  ).lean();
};
const releaseLease = (publishId) => MetaPublish.updateOne({ publishId, lockOwner: ownerId() }, { $set: { lockedUntil: null, lockOwner: null } });

const KNOWN_STEPS = ["validate", "campaign", "images", "adset", "creatives", "ads", "link"];

/**
 * Looks for an object whose name carries our tag (the unknown-result rule), then falls back to creating it again once.
 * `create()` returns Meta's body; `find()` returns an id or null.
 */
const createOnce = async (create, find) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { body } = await create();
      if (!body || !body.id) throw new MetaError("META_ERROR");
      return String(body.id);
    } catch (error) {
      if (!(error instanceof MetaError) || !error.unknownResult) throw error;
      const found = await find().catch(() => null);
      if (found) return found;
      if (attempt === 1) throw error;
    }
  }
  return null;
};

/**
 * Runs (or continues) a publish: validate, campaign, images, ad set, creatives, ads, link. Each id is saved the moment Meta returns it.
 * A step that fails stops the run: the Meta campaign stays PAUSED (nothing spends) and the owner can retry or cancel.
 */
const run = async ({ publishId, campaignId, user }) => {
  await loadPublish(publishId, campaignId);
  let publish = await acquireLease(publishId);
  if (!publish) throw conflict("PUBLISH_RUNNING", "النشر شغال دلوقتي");
  try {
    if (["published", "cancelled"].includes(publish.status)) { return view(publish); }
    const campaign = await loadCampaign(publish.campaignId);
    if (!publicSiteBase()) throw conflict("SITE_NOT_PUBLIC", SITE_NOT_PUBLIC_MESSAGE);
    const context = await publishContext();
    if (context.connection.adAccountId !== publish.adAccountId) throw conflict("ACCOUNT_CHANGED", "حساب الإعلانات اتغير بعد ما بدأت العملية. اعمل عملية جديدة.");
    publish.steps = publish.steps || {};
    const { reader, writer } = context;
    const mark = async (name, state, error) => {
      const entry = { state, at: clock.now(), ...(error ? { errorCode: error.code, errorMessage: error.message } : {}) };
      publish.steps[name] = entry;
      publish.lastError = error ? { step: name, code: error.code, message: error.message } : null;
      await MetaPublish.updateOne({ _id: publish._id }, { $set: { [`steps.${name}`]: entry, ...(error ? { lastError: { step: name, code: error.code, message: error.message, at: clock.now() } } : { lastError: null }) } });
    };
    const done = (name) => publish.steps[name] && publish.steps[name].state === "done";
    const set = async (fields) => { Object.assign(publish, fields); await MetaPublish.updateOne({ _id: publish._id }, { $set: fields }); };
    const tag = tagOf(publish.publishId);
    const failed = async (name, error) => {
      const known = error instanceof MetaError ? error : new MetaError("META_ERROR");
      await mark(name, "failed", known);
      await set({ status: "failed" });
      return view(publish);
    };

    await set({ status: "running" });
    let current = "validate";
    try {
      // 1. validate: nothing is created.
      if (!done("validate")) {
        await writer.validateCampaign(campaignBody(publish, campaign));
        await mark("validate", "done");
      }
      // 2. the campaign, PAUSED (the one switch of the whole thing).
      current = "campaign";
      if (!publish.metaCampaignId) {
        const id = await createOnce(
          () => writer.createCampaign(campaignBody(publish, campaign)),
          async () => (await reader.findByTag(`${publish.adAccountId}/campaigns`, tag))[0]?.id
        );
        await set({ metaCampaignId: String(id) });
        await mark("campaign", "done");
      } else if (!done("campaign")) await mark("campaign", "done");
      // 3. images (the same bytes always give the same hash, so repeating is safe).
      current = "images";
      if (!done("images")) {
        for (let i = 0; i < publish.spec.ads.length; i += 1) await ensureImageHash(publish, i, writer);
        await mark("images", "done");
      }
      // 4. the ad set: validated first (nothing created), then created, ACTIVE under the PAUSED campaign.
      current = "adset";
      if (!publish.adSetId) {
        await writer.validateAdSet(adSetBody(publish, campaign));
        const id = await createOnce(
          () => writer.createAdSet(adSetBody(publish, campaign)),
          async () => (await reader.findByTag(`${publish.metaCampaignId}/adsets`, tag))[0]?.id
        );
        await set({ adSetId: String(id) });
        await mark("adset", "done");
      } else if (!done("adset")) await mark("adset", "done");
      // 5. the creatives (validated first). After creating one, read back what Meta applied.
      current = "creatives";
      if (!done("creatives")) {
        for (let i = 0; i < publish.spec.ads.length; i += 1) {
          if (publish.ads[i].creativeId) continue;
          await writer.validateCreative(creativeBody(publish, campaign, i));
          const id = await createOnce(
            () => writer.createCreative(creativeBody(publish, campaign, i)),
            async () => (await reader.findByTag(`${publish.adAccountId}/adcreatives`, `${tag}`, "id,name")).find((row) => String(row.name).includes(` · إعلان ${i + 1} `))?.id
          );
          publish.ads[i].creativeId = String(id);
          await MetaPublish.updateOne({ _id: publish._id }, { $set: { [`ads.${i}.creativeId`]: String(id) } });
          try {
            const read = await reader.creative(id);
            const applied = (read && read.degrees_of_freedom_spec) || null;
            await MetaPublish.updateOne({ _id: publish._id }, { $set: { [`ads.${i}.appliedFeatures`]: applied } });
            publish.ads[i].appliedFeatures = applied;
          } catch { /* the read-back is informational: never stops the publish */ }
        }
        await mark("creatives", "done");
      }
      // 6. the ads, ACTIVE.
      current = "ads";
      if (!done("ads")) {
        for (let i = 0; i < publish.spec.ads.length; i += 1) {
          if (publish.ads[i].adId) continue;
          const id = await createOnce(
            () => writer.createAd(adBody(publish, campaign, i)),
            async () => (await reader.findByTag(`${publish.adSetId}/ads`, tag)).find((row) => String(row.name).includes(` · إعلان ${i + 1} `))?.id
          );
          publish.ads[i].adId = String(id);
          await MetaPublish.updateOne({ _id: publish._id }, { $set: { [`ads.${i}.adId`]: String(id) } });
        }
        await mark("ads", "done");
      }
    } catch (error) {
      return await failed(current, error);
    }

    // 7. link to the Nota campaign (the 7B link), then a 7B sync in the background (its 5-minute gap is a button rule, not applied here).
    await MetaCampaign.updateOne(
      { metaId: publish.metaCampaignId },
      {
        $set: {
          adAccountId: publish.adAccountId, name: metaName(publish, campaign), status: "PAUSED", effectiveStatus: "PAUSED", objective: GOALS[publish.spec.goal].objective,
          createdTime: clock.now(), syncedAt: clock.now(), campaignId: publish.campaignId, linkedAt: clock.now(), linkedByName: user && user.name,
          createdByNota: true, publishId: publish.publishId,
          ...(publish.spec.budget.type === "daily" ? { dailyBudgetMinor: publish.spec.budget.amountMinor } : { lifetimeBudgetMinor: publish.spec.budget.amountMinor }),
          ...(publish.spec.budget.endTime ? { endTime: new Date(publish.spec.budget.endTime) } : {}),
        },
      },
      { upsert: true }
    );
    await mark("link", "done");
    await set({ status: "published", publishedAt: clock.now() });
    await MetaPublishImage.deleteMany({ publishId: publish.publishId });
    sync.startInBackground("manual");
    return view(publish);
  } finally {
    await releaseLease(publishId).catch(() => {});
  }
};

/** «إلغاء»: the created Meta campaign (if any) is set to DELETED and the record is marked cancelled. */
const cancel = async ({ publishId, campaignId }) => {
  await loadPublish(publishId, campaignId);
  const publish = await acquireLease(publishId);
  if (!publish) throw conflict("PUBLISH_RUNNING", "النشر شغال دلوقتي");
  try {
    if (publish.status === "published") throw conflict("PUBLISH_FINISHED", "الحملة اتنشرت. استخدم «أرشفة» بدل الإلغاء.");
    if (publish.status === "cancelled") return view(publish);
    if (publish.metaCampaignId) {
      const context = await publishContext();
      try { await context.writer.updateObject(publish.metaCampaignId, { status: "DELETED" }); } catch (error) { await MetaPublish.updateOne({ _id: publish._id }, { $set: { status: "failed" } }); throw metaFailure(error); }
      await MetaCampaign.updateOne({ metaId: publish.metaCampaignId }, { $set: { status: "DELETED", effectiveStatus: "DELETED" } });
    }
    await MetaPublish.updateOne({ _id: publish._id }, { $set: { status: "cancelled", cancelledAt: clock.now() } });
    await MetaPublishImage.deleteMany({ publishId: publish.publishId });
    return view({ ...publish, status: "cancelled" });
  } finally {
    await releaseLease(publishId).catch(() => {});
  }
};

const getPublish = async ({ publishId, campaignId }) => view(await loadPublish(publishId, campaignId));

// ---------------------------------------------------------------------------------------------------------------------
// managing what Nota created

const loadOwned = async (campaignId, metaId) => {
  const row = await MetaCampaign.findOne({ metaId: String(metaId), campaignId, createdByNota: true }).lean();
  if (!row) throw conflict("NOT_CREATED_BY_NOTA", "الحملة دي مش من اللي نوتا عملته. إدارتها من Ads Manager.");
  const publish = await MetaPublish.findOne({ metaCampaignId: row.metaId, status: "published" }).lean();
  if (!publish) throw conflict("NOT_CREATED_BY_NOTA", "الحملة دي مش من اللي نوتا عملته. إدارتها من Ads Manager.");
  return { row, publish };
};

/** After any change: refresh the status and budget from Meta (GET) and record it. */
const refreshOne = async (metaId, reader) => {
  const body = await reader.object(metaId, "id,name,status,effective_status,daily_budget,lifetime_budget");
  const set = { status: body.status, effectiveStatus: body.effective_status || body.status, syncedAt: clock.now() };
  const daily = Number(body.daily_budget); const lifetime = Number(body.lifetime_budget);
  if (Number.isFinite(daily) && daily > 0) set.dailyBudgetMinor = daily;
  if (Number.isFinite(lifetime) && lifetime > 0) set.lifetimeBudgetMinor = lifetime;
  await MetaCampaign.updateOne({ metaId: String(metaId) }, { $set: set });
  return set;
};

const afterChange = async (metaId, reader) => { try { await refreshOne(metaId, reader); } catch { /* the change itself succeeded */ } };

/** What switching on will spend, in words (the confirmation dialog shows the same numbers; the server needs confirmSpend: true). */
const spendSummary = (row, publish) => {
  const budget = publish.spec.budget;
  const currency = publish.spec.currency;
  const daily = row.dailyBudgetMinor || (budget.type === "daily" ? budget.amountMinor : 0);
  const total = row.lifetimeBudgetMinor || (budget.type === "lifetime" ? budget.amountMinor : 0);
  return { type: daily ? "daily" : "lifetime", amountMinor: daily || total, currency, endTime: row.endTime || budget.endTime || null };
};

const setStatus = async ({ campaignId, metaId, status, confirmSpend }) => {
  if (!["ACTIVE", "PAUSED"].includes(status)) throw bad("حالة غير صالحة", "INVALID_STATUS");
  const { row, publish } = await loadOwned(campaignId, metaId);
  if (["DELETED", "ARCHIVED"].includes(row.status)) throw conflict("CAMPAIGN_CLOSED", "الحملة دي اتأرشفت أو اتحذفت");
  const context = await publishContext();
  let summary;
  if (status === "ACTIVE") {
    if (confirmSpend !== true) throw conflict("CONFIRM_REQUIRED", "لازم تأكد إنك فاهم إن الحملة هتبدأ تصرف");
    summary = spendSummary(row, publish);
    // Re-check the ceiling at the moment of switching on (the ceiling may have been lowered since publishing).
    await checkCeiling({ minor: summary.amountMinor, currency: summary.currency, kind: summary.type === "daily" ? "daily" : "total" });
  }
  try { await context.writer.updateObject(row.metaId, { status }); } catch (error) { throw metaFailure(error); }
  await afterChange(row.metaId, context.reader);
  return { status, summary: summary || null };
};

const setBudget = async ({ campaignId, metaId, amount }) => {
  const { row, publish } = await loadOwned(campaignId, metaId);
  if (["DELETED", "ARCHIVED"].includes(row.status)) throw conflict("CAMPAIGN_CLOSED", "الحملة دي اتأرشفت أو اتحذفت");
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || Math.round(value * 100) / 100 !== value) throw bad("الميزانية لازم تكون رقم موجب (لحد خانتين عشريتين)", "INVALID_BUDGET");
  const context = await publishContext();
  const minor = minorOf(value);
  const daily = row.dailyBudgetMinor ? true : row.lifetimeBudgetMinor ? false : publish.spec.budget.type === "daily";
  if (daily && context.connection.minDailyBudgetMinor && minor < context.connection.minDailyBudgetMinor) throw bad(new MetaError("BUDGET_TOO_LOW").message, "BUDGET_TOO_LOW");
  await checkCeiling({ minor, currency: context.currency, kind: daily ? "daily" : "total" });
  const old = daily ? row.dailyBudgetMinor : row.lifetimeBudgetMinor;
  try { await context.writer.updateObject(row.metaId, daily ? { daily_budget: minor } : { lifetime_budget: minor }); } catch (error) { throw metaFailure(error); }
  await MetaCampaign.updateOne({ metaId: row.metaId }, { $set: daily ? { dailyBudgetMinor: minor } : { lifetimeBudgetMinor: minor } });
  await afterChange(row.metaId, context.reader);
  return { type: daily ? "daily" : "lifetime", oldMinor: old || null, newMinor: minor };
};

const setEndTime = async ({ campaignId, metaId, endTime }) => {
  const { row, publish } = await loadOwned(campaignId, metaId);
  if (["DELETED", "ARCHIVED"].includes(row.status)) throw conflict("CAMPAIGN_CLOSED", "الحملة دي اتأرشفت أو اتحذفت");
  const context = await publishContext();
  const end = zonedLocalToDate(endTime, (context.connection.account && context.connection.account.timezoneName) || "UTC");
  if (!end || end.getTime() <= clock.now().getTime() + 60 * 60 * 1000) throw bad("تاريخ النهاية لازم يكون في المستقبل", "INVALID_DATE");
  // The end date lives on the ad set (Meta's rule for a campaign budget).
  try { await context.writer.updateObject(publish.adSetId, { end_time: end.toISOString() }); } catch (error) { throw metaFailure(error); }
  await MetaCampaign.updateOne({ metaId: row.metaId }, { $set: { endTime: end } });
  await afterChange(row.metaId, context.reader);
  return { oldEndTime: row.endTime || null, newEndTime: end };
};

const archive = async ({ campaignId, metaId }) => {
  const { row } = await loadOwned(campaignId, metaId);
  const context = await publishContext();
  try { await context.writer.updateObject(row.metaId, { status: "ARCHIVED" }); } catch (error) { throw metaFailure(error); }
  await afterChange(row.metaId, context.reader);
  return { status: "ARCHIVED" };
};

const refresh = async ({ campaignId, metaId }) => {
  const { row } = await loadOwned(campaignId, metaId);
  const context = await publishContext();
  try { return await refreshOne(row.metaId, context.reader); } catch (error) { throw metaFailure(error); }
};

module.exports = {
  PUBLISH_SCOPES, CTAS, CREATIVE_OPT_OUT, OFFSET_100,
  hasPublishScopes, missingScopes, currencySupported, publicSiteBase, zonedLocalToDate, imageInfo, checkImage,
  checkCeiling, options, createDraft, stageImage, preview, run, cancel, getPublish, view,
  setStatus, setBudget, setEndTime, archive, refresh, ownsObject, spendSummary,
  campaignBody, adSetBody, creativeBody, adBody, targetingOf,
};
