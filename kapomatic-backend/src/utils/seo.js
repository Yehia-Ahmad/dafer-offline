const mongoose = require("mongoose");
const isBase64Image = require("./isBase64Image");

const LANGUAGES = ["ar", "en"];
const SITEMAP_FREQUENCIES = ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"];
const PUBLIC_CACHE_TTL_MS = Number(process.env.PUBLIC_SEO_CACHE_TTL_MS || 60_000);

const publicCache = new Map();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertLanguage = (language, res) => {
  if (!LANGUAGES.includes(language)) {
    res.status(400);
    throw new Error("قيمة اللغة غير صالحة");
  }
};

const normalizeArabicText = (value) =>
  value
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه");

const normalizeSlug = (value, language) => {
  if (value === undefined || value === null) return undefined;
  const normalizedInput = language === "ar" ? normalizeArabicText(String(value)) : String(value).toLowerCase();

  return normalizedInput
    .trim()
    .replace(/\s+/g, "-")
    .replace(language === "ar" ? /[^\p{Script=Arabic}a-zA-Z0-9-]+/gu : /[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const compactObject = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const compacted = {};

  Object.entries(value).forEach(([key, item]) => {
    if (item === undefined || item === null || item === "") return;
    if (Array.isArray(item) && item.length === 0) return;
    compacted[key] = item;
  });

  return Object.keys(compacted).length > 0 ? compacted : undefined;
};

const normalizeOptionalString = (value, field, res, maxLength) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    res.status(400);
    throwFieldError(field, "غير صالح");
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    res.status(400);
    throwFieldError(field, `يجب ألا يزيد عن ${maxLength} حرف`);
  }
  return trimmed;
};

const throwFieldError = (field, message, statusCode) => {
  const error = new Error(`${field} ${message}`);
  error.responseData = { fieldErrors: [{ field, message }] };
  if (statusCode) error.statusCode = statusCode;
  throw error;
};

const validateHttpUrl = (value, field, res) => {
  const normalized = normalizeOptionalString(value, field, res, 2000);
  if (!normalized) return undefined;

  try {
    const url = new URL(normalized);
    if (url.protocol === "http:" || url.protocol === "https:") return normalized;
  } catch (_error) {}

  res.status(400);
  throwFieldError(field, "يجب أن يكون رابط HTTP/HTTPS مطلق");
};

const normalizeKeywords = (value, field, res) => {
  if (value === undefined || value === null || value === "") return undefined;
  const values = Array.isArray(value) ? value : String(value).split(",");
  const seen = new Set();
  const keywords = [];

  values.forEach((item) => {
    const keyword = String(item || "").trim();
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) return;
    if (keyword.length > 80) {
      res.status(400);
      throwFieldError(field, "يجب ألا تزيد كل كلمة مفتاحية عن 80 حرف");
    }
    seen.add(key);
    keywords.push(keyword);
  });

  return keywords.length > 0 ? keywords : undefined;
};

const normalizeTranslations = (input, legacyName, res) => {
  const translations = {};
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  LANGUAGES.forEach((language) => {
    const langInput = source[language] && typeof source[language] === "object" ? source[language] : {};
    const normalized = compactObject({
      name: normalizeOptionalString(langInput.name, `translations.${language}.name`, res, 200),
      description: normalizeOptionalString(
        langInput.description,
        `translations.${language}.description`,
        res,
        5000
      ),
      shortDescription: normalizeOptionalString(
        langInput.shortDescription,
        `translations.${language}.shortDescription`,
        res,
        500
      ),
      slug: normalizeSlug(langInput.slug, language),
      imageAlt: normalizeOptionalString(
        langInput.imageAlt,
        `translations.${language}.imageAlt`,
        res,
        200
      ),
    });

    if (normalized?.slug && normalized.slug.length > 200) {
      res.status(400);
      throwFieldError(`translations.${language}.slug`, "يجب ألا يزيد عن 200 حرف");
    }
    if (normalized) translations[language] = normalized;
  });

  if (!translations.ar?.name && legacyName) {
    translations.ar = { ...(translations.ar || {}), name: String(legacyName).trim() };
  }

  return Object.keys(translations).length > 0 ? translations : undefined;
};

const normalizeSeo = (input, defaults, res) => {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const seo = {};

  LANGUAGES.forEach((language) => {
    const langInput = source[language] && typeof source[language] === "object" ? source[language] : {};
    const normalized = compactObject({
      metaTitle: normalizeOptionalString(langInput.metaTitle, `seo.${language}.metaTitle`, res, 70),
      metaDescription: normalizeOptionalString(
        langInput.metaDescription,
        `seo.${language}.metaDescription`,
        res,
        170
      ),
      keywords: normalizeKeywords(langInput.keywords, `seo.${language}.keywords`, res),
      ogTitle: normalizeOptionalString(langInput.ogTitle, `seo.${language}.ogTitle`, res, 70),
      ogDescription: normalizeOptionalString(
        langInput.ogDescription,
        `seo.${language}.ogDescription`,
        res,
        170
      ),
      canonicalOverride: validateHttpUrl(
        langInput.canonicalOverride,
        `seo.${language}.canonicalOverride`,
        res
      ),
    });
    if (normalized) seo[language] = normalized;
  });

  const priority = source.sitemapPriority !== undefined ? Number(source.sitemapPriority) : defaults.priority;
  if (!Number.isFinite(priority) || priority < 0 || priority > 1) {
    res.status(400);
    throwFieldError("seo.sitemapPriority", "يجب أن يكون بين 0 و 1");
  }

  const frequency = source.sitemapChangeFrequency || defaults.frequency || "weekly";
  if (!SITEMAP_FREQUENCIES.includes(frequency)) {
    res.status(400);
    throwFieldError("seo.sitemapChangeFrequency", "غير صالح");
  }

  return {
    ...seo,
    ogImage: normalizeOptionalString(source.ogImage, "seo.ogImage", res, 2000),
    robotsIndex: source.robotsIndex !== undefined ? Boolean(source.robotsIndex) : true,
    robotsFollow: source.robotsFollow !== undefined ? Boolean(source.robotsFollow) : true,
    includeInSitemap: source.includeInSitemap !== undefined ? Boolean(source.includeInSitemap) : true,
    sitemapPriority: priority,
    sitemapChangeFrequency: frequency,
  };
};

const normalizeSeoInput = ({ body, legacyName, entityType, existing, res }) => {
  const update = {};
  const priority = entityType === "category" ? 0.7 : 0.8;

  if (body.translations !== undefined || legacyName) {
    const normalizedTranslations = normalizeTranslations(body.translations, legacyName, res);
    if (normalizedTranslations) {
      update.translations = {
        ...(existing?.translations?.toObject?.() || existing?.translations || {}),
        ...normalizedTranslations,
        ar: {
          ...((existing?.translations?.ar?.toObject?.() || existing?.translations?.ar) || {}),
          ...(normalizedTranslations.ar || {}),
        },
        en: {
          ...((existing?.translations?.en?.toObject?.() || existing?.translations?.en) || {}),
          ...(normalizedTranslations.en || {}),
        },
      };
      if (!update.translations.en || Object.keys(compactObject(update.translations.en) || {}).length === 0) {
        delete update.translations.en;
      }
    }
  }

  if (body.seo !== undefined) {
    const existingSeo = existing?.seo?.toObject?.() || existing?.seo || {};
    const normalizedSeo = normalizeSeo(body.seo, {
      priority: existingSeo.sitemapPriority ?? priority,
      frequency: existingSeo.sitemapChangeFrequency || "weekly",
    }, res);

    update.seo = {
      ...existingSeo,
      ...normalizedSeo,
      ar: {
        ...(existingSeo.ar || {}),
        ...(normalizedSeo.ar || {}),
      },
      en: {
        ...(existingSeo.en || {}),
        ...(normalizedSeo.en || {}),
      },
    };
  } else if (!existing) {
    update.seo = normalizeSeo({}, { priority, frequency: "weekly" }, res);
  }

  return update;
};

const checkDuplicateSlug = async ({ Model, entityType, translations, excludeId, res }) => {
  if (!translations) return;
  const or = LANGUAGES.flatMap((language) => {
    const slug = translations[language]?.slug;
    return slug ? [{ [`translations.${language}.slug`]: slug }] : [];
  });

  if (or.length === 0) return;

  const query = { $or: or };
  if (excludeId) query._id = { $ne: excludeId };
  const duplicate = await Model.findOne(query).select("translations").lean();
  if (!duplicate) return;

  const fieldErrors = LANGUAGES.flatMap((language) => {
    const slug = translations[language]?.slug;
    return slug && duplicate.translations?.[language]?.slug === slug
      ? [{ field: `translations.${language}.slug`, message: "slug مستخدم بالفعل" }]
      : [];
  });
  const error = new Error("تم إدخال slug مكرر");
  error.statusCode = 409;
  error.responseData = { entityType, fieldErrors };
  throw error;
};

const addSlugAliasesForChangedSlugs = (document, nextTranslations = {}) => {
  const aliases = [...(document.slugAliases || [])].map((alias) => ({
    language: alias.language,
    slug: alias.slug,
  }));

  LANGUAGES.forEach((language) => {
    const currentSlug = document.translations?.[language]?.slug;
    const nextSlug = nextTranslations?.[language]?.slug;
    if (!currentSlug || !nextSlug || currentSlug === nextSlug) return;
    if (!aliases.some((alias) => alias.language === language && alias.slug === currentSlug)) {
      aliases.push({ language, slug: currentSlug });
    }
  });

  document.slugAliases = aliases.filter((alias) => {
    const finalSlug = nextTranslations?.[alias.language]?.slug;
    return alias.slug !== finalSlug;
  });
};

const DEFAULT_WEBSITE_ORIGIN = "https://kapomatic.com";
const normalizePublicOrigin = (value, fallback) => {
  const origin = String(value || fallback).replace(/\/+$/, "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return fallback;
  return origin;
};
const getWebsiteOrigin = () => normalizePublicOrigin(process.env.WEBSITE_ORIGIN, DEFAULT_WEBSITE_ORIGIN);
const getPublicApiOrigin = () => {
  // Public assets must not inherit a storefront or internal SSR request host.
  const fallback = "https://api.kapomatic.com";
  try {
    const url = new URL(process.env.PUBLIC_API_ORIGIN || fallback);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return fallback;
    return ["http:", "https:"].includes(url.protocol) ? url.origin : fallback;
  } catch (_error) {
    return fallback;
  }
};
const absoluteApiUrl = (req, path) => `${getPublicApiOrigin(req)}${path}`;
const getWebsiteImageAssetUrl = (req, id) =>
  absoluteApiUrl(req, `/api/website-images/${id}/image`);
const getEntityImageAssetUrl = (req, entityType, id) => {
  const imageCollection = entityType === "category" ? "categories" : "products";
  return absoluteApiUrl(req, `/api/public/images/${imageCollection}/${id}`);
};
const getEntityImageUrl = (req, entityType, entity) => {
  const image = typeof entity?.image === "string" ? entity.image.trim() : "";
  if (!image) return undefined;

  try {
    const url = new URL(image);
    if (url.protocol === "http:" || url.protocol === "https:") return image;
  } catch (_error) {
    // Category and product images are normally stored as base64, not URLs.
  }

  return isBase64Image(image)
    ? getEntityImageAssetUrl(req, entityType, entity._id)
    : undefined;
};

const cacheGet = (key) => {
  const item = publicCache.get(key);
  if (!item || item.expiresAt < Date.now()) {
    publicCache.delete(key);
    return undefined;
  }
  return item.value;
};

const cacheSet = (key, value) => {
  if (PUBLIC_CACHE_TTL_MS > 0) {
    publicCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS });
  }
};

const clearPublicSeoCache = () => publicCache.clear();

const sendBase64Image = (entity, res, notFoundMessage) => {
  if (!entity?.image) {
    res.status(404);
    throw new Error(notFoundMessage);
  }
  const dataUriMatch = entity.image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  const contentType = dataUriMatch?.[1] || "image/png";
  const base64Data = dataUriMatch?.[2] || entity.image;
  res.set("Content-Type", contentType);
  res.set("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(base64Data.replace(/\s+/g, ""), "base64"));
};

const hasObjectId = (ids, id) => ids.map((item) => String(item)).includes(String(id));

module.exports = {
  LANGUAGES,
  assertLanguage,
  normalizeSlug,
  normalizeSeoInput,
  checkDuplicateSlug,
  addSlugAliasesForChangedSlugs,
  escapeRegex,
  getWebsiteOrigin,
  getPublicApiOrigin,
  getWebsiteImageAssetUrl,
  absoluteApiUrl,
  getEntityImageAssetUrl,
  getEntityImageUrl,
  cacheGet,
  cacheSet,
  clearPublicSeoCache,
  sendBase64Image,
  hasObjectId,
};
