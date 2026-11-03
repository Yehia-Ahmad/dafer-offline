import { FormBuilder, Validators } from '@angular/forms';
import {
  EntitySeoData,
  EntityTranslations,
  LanguageSeoFields,
  LocalizedEntityContent,
  SeoDuplicateSlugMatch,
  SeoEditorForm,
  SeoEntityExtension,
  SeoEntityType,
  SeoFormContext,
  SeoKeywordNormalizationResult,
  SeoLanguage,
  SeoNormalizedExtension,
  SeoSearchPreviewData,
  SitemapChangeFrequency
} from '../models/seo.models';
import {
  canonicalUrlValidator,
  keywordsTextValidator,
  metaDescriptionValidator,
  metaTitleValidator,
  sitemapPriorityValidator,
  slugValidator
} from '../validators/seo.validators';

const DEFAULT_CHANGE_FREQUENCY: SitemapChangeFrequency = 'weekly';

export function generateEnglishSlug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateArabicSlug(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeKeywords(value: string | string[] | undefined | null): SeoKeywordNormalizationResult {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const keywords: string[] = [];
  let removedDuplicateCount = 0;
  let removedEmptyCount = 0;
  const seen = new Set<string>();

  source.forEach((item) => {
    const keyword = String(item || '').trim();
    if (!keyword) {
      removedEmptyCount += 1;
      return;
    }

    const key = keyword.toLocaleLowerCase();
    if (seen.has(key)) {
      removedDuplicateCount += 1;
      return;
    }

    seen.add(key);
    keywords.push(keyword);
  });

  return { keywords: keywords.slice(0, 20), removedDuplicateCount, removedEmptyCount };
}

export function defaultSitemapPriority(entityType: SeoEntityType): number {
  return entityType === 'product' ? 0.8 : 0.7;
}

export function buildSeoFormValue(
  fb: FormBuilder,
  entityType: SeoEntityType,
  source: SeoEntityExtension = {},
  context: SeoFormContext = { entityType }
): SeoEditorForm {
  const translations = normalizeTranslationsForForm(source.translations, context);
  const seo = normalizeSeoForForm(source.seo, entityType);

  return fb.group({
    translations: fb.group({
      ar: fb.group({
        name: fb.nonNullable.control(translations.ar.name || ''),
        description: fb.nonNullable.control(translations.ar.description || ''),
        shortDescription: fb.nonNullable.control(translations.ar.shortDescription || ''),
        slug: fb.nonNullable.control(translations.ar.slug || '', [slugValidator()]),
        imageAlt: fb.nonNullable.control(translations.ar.imageAlt || '', [Validators.maxLength(150)])
      }),
      en: fb.group({
        name: fb.nonNullable.control(translations.en.name || ''),
        description: fb.nonNullable.control(translations.en.description || ''),
        shortDescription: fb.nonNullable.control(translations.en.shortDescription || ''),
        slug: fb.nonNullable.control(translations.en.slug || '', [slugValidator()]),
        imageAlt: fb.nonNullable.control(translations.en.imageAlt || '', [Validators.maxLength(150)])
      })
    }),
    seo: fb.group({
      ar: createLanguageSeoGroup(fb, seo.ar),
      en: createLanguageSeoGroup(fb, seo.en),
      ogImage: fb.nonNullable.control(seo.ogImage || ''),
      useEntityImageFallback: fb.nonNullable.control(!seo.ogImage),
      robotsIndex: fb.nonNullable.control(seo.robotsIndex),
      robotsFollow: fb.nonNullable.control(seo.robotsFollow),
      includeInSitemap: fb.nonNullable.control(seo.includeInSitemap),
      sitemapPriority: fb.nonNullable.control(
        seo.sitemapPriority ?? defaultSitemapPriority(entityType),
        [sitemapPriorityValidator()]
      ),
      sitemapChangeFrequency: fb.nonNullable.control(
        seo.sitemapChangeFrequency || DEFAULT_CHANGE_FREQUENCY
      )
    })
  });
}

export function normalizeTranslationsPayload(form: SeoEditorForm): EntityTranslations | undefined {
  const raw = form.getRawValue().translations;
  const translations: EntityTranslations = {
    ar: cleanLocalizedContent(raw.ar),
    en: cleanLocalizedContent(raw.en)
  };

  return hasLocalizedContent(translations.ar) || hasLocalizedContent(translations.en)
    ? translations
    : undefined;
}

export function normalizeSeoPayload(form: SeoEditorForm): EntitySeoData {
  const raw = form.getRawValue().seo;
  const ogImage = raw.useEntityImageFallback ? '' : raw.ogImage;
  const payload: EntitySeoData = {
    ar: cleanLanguageSeo(raw.ar),
    en: cleanLanguageSeo(raw.en),
    robotsIndex: raw.robotsIndex === true,
    robotsFollow: raw.robotsFollow === true,
    includeInSitemap: raw.includeInSitemap === true,
    sitemapPriority: clampPriority(raw.sitemapPriority),
    sitemapChangeFrequency: raw.sitemapChangeFrequency || DEFAULT_CHANGE_FREQUENCY
  };

  const cleanOgImage = cleanString(ogImage);
  if (cleanOgImage) {
    payload.ogImage = cleanOgImage;
  }

  return payload;
}

export function normalizeSeoExtensionPayload(form: SeoEditorForm): SeoNormalizedExtension {
  const translations = normalizeTranslationsPayload(form);
  const seo = normalizeSeoPayload(form);

  return {
    ...(translations ? { translations } : {}),
    seo
  };
}

export function buildSeoPreviewData(
  form: SeoEditorForm,
  context: SeoFormContext,
  language: SeoLanguage
): SeoSearchPreviewData {
  const raw = form.getRawValue();
  const localized = raw.translations[language];
  const seo = raw.seo[language];
  const title = cleanString(seo.metaTitle)
    || fallbackSeoTitle(context.entityType, language, localized.name || context.legacyName || '');
  const description = cleanString(seo.metaDescription)
    || cleanString(localized.shortDescription)
    || cleanString(localized.description)
    || (language === 'ar' ? 'منتجات كابوماتيك المتاحة للطلب.' : 'Kapomatic products available to order.');
  const slug = cleanString(localized.slug) || slugFromName(language, localized.name || context.legacyName || '');
  const urlLanguage = language === 'ar' ? 'ar' : 'en';
  const entityPath = context.entityType === 'product' ? 'products' : 'categories';
  const image = raw.seo.useEntityImageFallback
    ? context.image
    : (raw.seo.ogImage || context.image);

  return {
    brand: language === 'ar' ? 'كابوماتيك' : 'Kapomatic',
    language,
    direction: language === 'ar' ? 'rtl' : 'ltr',
    url: `kapomatic.com/${urlLanguage}/${entityPath}/${slug || 'preview'}`,
    title,
    description,
    thumbnail: cleanString(image),
    price: context.entityType === 'product' ? normalizeOptionalNumber(context.price) : null,
    isProduct: context.entityType === 'product'
  };
}

export function generateSeoSuggestions(
  form: SeoEditorForm,
  context: SeoFormContext,
  overwrite = false
): void {
  fillLanguageSuggestions(form, context, 'ar', overwrite);
  fillLanguageSuggestions(form, context, 'en', overwrite);

  const seoGroup = form.controls.seo;
  if (overwrite || !seoGroup.controls.ogImage.value) {
    seoGroup.controls.ogImage.setValue(context.image || '');
  }
}

export function extractDuplicateSlugMatch(error: unknown): SeoDuplicateSlugMatch | null {
  const payload = extractErrorPayload(error);
  const message = readString(payload, ['message', 'error.message', 'errors.0.message']);
  const field = readString(payload, ['field', 'path', 'errors.0.field', 'errors.0.path']);
  const language = readString(payload, ['language', 'lang', 'errors.0.language']);
  const slug = readString(payload, ['slug', 'value', 'errors.0.slug', 'errors.0.value']);
  const source = `${field} ${language} ${message}`.toLowerCase();

  if (!source.includes('slug')) {
    return null;
  }

  if (source.includes(' ar') || source.includes('.ar') || source.includes('arabic') || source.includes('عرب')) {
    return { language: 'ar', slug, message };
  }

  if (source.includes(' en') || source.includes('.en') || source.includes('english')) {
    return { language: 'en', slug, message };
  }

  return { language: 'ar', slug, message };
}

function createLanguageSeoGroup(fb: FormBuilder, seo: LanguageSeoFields) {
  return fb.group({
    metaTitle: fb.nonNullable.control(seo.metaTitle || '', [metaTitleValidator()]),
    metaDescription: fb.nonNullable.control(seo.metaDescription || '', [metaDescriptionValidator()]),
    keywordsText: fb.nonNullable.control((seo.keywords || []).join(', '), [keywordsTextValidator()]),
    ogTitle: fb.nonNullable.control(seo.ogTitle || '', [Validators.maxLength(70)]),
    ogDescription: fb.nonNullable.control(seo.ogDescription || '', [Validators.maxLength(200)]),
    canonicalOverride: fb.nonNullable.control(seo.canonicalOverride || '', [canonicalUrlValidator()])
  });
}

function normalizeTranslationsForForm(
  source: Partial<EntityTranslations> | undefined,
  context: SeoFormContext
): EntityTranslations {
  const legacyName = cleanString(context.legacyName);
  return {
    ar: {
      name: cleanString(source?.ar?.name) || legacyName,
      description: cleanString(source?.ar?.description),
      shortDescription: cleanString(source?.ar?.shortDescription),
      slug: cleanString(source?.ar?.slug),
      imageAlt: cleanString(source?.ar?.imageAlt)
    },
    en: {
      name: cleanString(source?.en?.name),
      description: cleanString(source?.en?.description),
      shortDescription: cleanString(source?.en?.shortDescription),
      slug: cleanString(source?.en?.slug),
      imageAlt: cleanString(source?.en?.imageAlt)
    }
  };
}

function normalizeSeoForForm(source: Partial<EntitySeoData> | undefined, entityType: SeoEntityType): EntitySeoData {
  return {
    ar: normalizeLanguageSeo(source?.ar),
    en: normalizeLanguageSeo(source?.en),
    ogImage: cleanString(source?.ogImage),
    robotsIndex: source?.robotsIndex ?? true,
    robotsFollow: source?.robotsFollow ?? true,
    includeInSitemap: source?.includeInSitemap ?? true,
    sitemapPriority: source?.sitemapPriority ?? defaultSitemapPriority(entityType),
    sitemapChangeFrequency: source?.sitemapChangeFrequency || DEFAULT_CHANGE_FREQUENCY
  };
}

function normalizeLanguageSeo(source: Partial<LanguageSeoFields> | undefined): LanguageSeoFields {
  return {
    metaTitle: cleanString(source?.metaTitle),
    metaDescription: cleanString(source?.metaDescription),
    keywords: normalizeKeywords(source?.keywords).keywords,
    ogTitle: cleanString(source?.ogTitle),
    ogDescription: cleanString(source?.ogDescription),
    canonicalOverride: cleanString(source?.canonicalOverride)
  };
}

function cleanLocalizedContent(source: LocalizedEntityContent): LocalizedEntityContent {
  return removeEmptyStrings({
    name: cleanString(source.name),
    description: cleanString(source.description),
    shortDescription: cleanString(source.shortDescription),
    slug: cleanString(source.slug),
    imageAlt: cleanString(source.imageAlt)
  });
}

function cleanLanguageSeo(source: LanguageSeoFields & { keywordsText?: string }): LanguageSeoFields {
  const keywords = normalizeKeywords(source.keywordsText ?? source.keywords).keywords;
  return removeEmptyStrings({
    metaTitle: cleanString(source.metaTitle),
    metaDescription: cleanString(source.metaDescription),
    keywords,
    ogTitle: cleanString(source.ogTitle),
    ogDescription: cleanString(source.ogDescription),
    canonicalOverride: cleanString(source.canonicalOverride)
  });
}

function removeEmptyStrings<T extends Record<string, unknown>>(source: T): T {
  const cleaned = { ...source };
  Object.entries(cleaned).forEach(([key, value]) => {
    if (typeof value === 'string' && !value.trim()) {
      delete cleaned[key as keyof T];
    }
    if (Array.isArray(value) && value.length === 0) {
      delete cleaned[key as keyof T];
    }
  });
  return cleaned;
}

function hasLocalizedContent(content: LocalizedEntityContent): boolean {
  return Object.values(content).some((value) => typeof value === 'string' && value.trim());
}

function fillLanguageSuggestions(
  form: SeoEditorForm,
  context: SeoFormContext,
  language: SeoLanguage,
  overwrite: boolean
): void {
  const content = form.controls.translations.controls[language].controls;
  const seo = form.controls.seo.controls[language].controls;
  const localizedName = content.name.value || context.legacyName || '';
  const specifications = (context.specifications || [])
    .map((item) => [item.title || item.name, item.value].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
  const description = [
    content.description.value || content.shortDescription.value,
    context.code ? `${language === 'ar' ? 'كود' : 'Code'} ${context.code}` : '',
    context.categoryName || '',
    specifications
  ].filter(Boolean).join(' - ');

  setIfAllowed(content.slug, slugFromName(language, localizedName), overwrite);
  setIfAllowed(seo.metaTitle, fallbackSeoTitle(context.entityType, language, localizedName), overwrite);
  setIfAllowed(seo.metaDescription, truncate(description || fallbackDescription(language), 160), overwrite);
  setIfAllowed(seo.ogTitle, fallbackSeoTitle(context.entityType, language, localizedName), overwrite);
  setIfAllowed(seo.ogDescription, truncate(description || fallbackDescription(language), 160), overwrite);
  setIfAllowed(content.imageAlt, localizedName ? `${localizedName} ${language === 'ar' ? 'كابوماتيك' : 'Kapomatic'}` : '', overwrite);

  if (overwrite || !seo.keywordsText.value) {
    seo.keywordsText.setValue(
      normalizeKeywords([localizedName, context.categoryName || '', context.code || '']).keywords.join(', ')
    );
  }
}

function setIfAllowed(control: { value: string; setValue: (value: string) => void }, value: string, overwrite: boolean): void {
  if (!value) return;
  if (overwrite || !String(control.value || '').trim()) {
    control.setValue(value);
  }
}

function fallbackSeoTitle(entityType: SeoEntityType, language: SeoLanguage, name: string): string {
  const cleanName = cleanString(name) || (language === 'ar' ? 'كابوماتيك' : 'Kapomatic');
  if (entityType === 'product') {
    return language === 'ar' ? `${cleanName} | كابوماتيك` : `${cleanName} | Kapomatic`;
  }
  return language === 'ar' ? `${cleanName} في مصر | كابوماتيك` : `${cleanName} in Egypt | Kapomatic`;
}

function fallbackDescription(language: SeoLanguage): string {
  return language === 'ar'
    ? 'اكتشف منتجات كابوماتيك المتاحة للطلب في مصر.'
    : 'Discover Kapomatic products available to order in Egypt.';
}

function slugFromName(language: SeoLanguage, name: string): string {
  return language === 'ar' ? generateArabicSlug(name) : generateEnglishSlug(name);
}

function truncate(value: string, maxLength: number): string {
  const trimmed = cleanString(value);
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trim() : trimmed;
}

function cleanString(value: unknown): string {
  return String(value ?? '').trim();
}

function clampPriority(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, Number(parsed.toFixed(1))));
}

function normalizeOptionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractErrorPayload(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { error?: unknown };
  const payload = candidate.error && typeof candidate.error === 'object'
    ? candidate.error
    : error;
  return payload as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, paths: string[]): string {
  for (const path of paths) {
    const value = path.split('.').reduce<unknown>((current, key) => {
      if (Array.isArray(current)) {
        return current[Number(key)];
      }
      if (current && typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, source);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

