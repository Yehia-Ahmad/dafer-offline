import { FormArray, FormControl, FormGroup } from '@angular/forms';

export type SeoLanguage = 'ar' | 'en';
export type SeoEntityType = 'category' | 'product';
export type SeoPreviewDevice = 'desktop' | 'mobile';

export type SitemapChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

export interface LocalizedEntityContent {
  name?: string;
  description?: string;
  shortDescription?: string;
  slug?: string;
  imageAlt?: string;
}

export interface EntityTranslations {
  ar: LocalizedEntityContent;
  en: LocalizedEntityContent;
}

export interface LanguageSeoFields {
  metaTitle?: string;
  metaDescription?: string;
  keywords?: string[];
  ogTitle?: string;
  ogDescription?: string;
  canonicalOverride?: string;
}

export interface EntitySeoData {
  ar: LanguageSeoFields;
  en: LanguageSeoFields;
  ogImage?: string;
  robotsIndex: boolean;
  robotsFollow: boolean;
  includeInSitemap: boolean;
  sitemapPriority?: number;
  sitemapChangeFrequency?: SitemapChangeFrequency;
}

export interface SeoEntityExtension {
  translations?: Partial<EntityTranslations>;
  seo?: Partial<EntitySeoData>;
}

export interface SeoFormContext {
  entityType: SeoEntityType;
  entityId?: string;
  legacyName?: string;
  categoryName?: string;
  code?: string;
  image?: string;
  price?: number | string | null;
  specifications?: Array<{ title?: string; name?: string; value?: string }>;
}

export interface SeoSearchPreviewData {
  brand: string;
  language: SeoLanguage;
  direction: 'rtl' | 'ltr';
  url: string;
  title: string;
  description: string;
  thumbnail?: string;
  price?: number | null;
  isProduct: boolean;
}

export interface SlugAvailabilityRequest {
  entityType: SeoEntityType;
  language: SeoLanguage;
  slug: string;
  excludeId?: string;
}

export interface SlugAvailabilityResponse {
  available: boolean;
  slug: string;
  language: SeoLanguage;
  entityType: SeoEntityType;
  message?: string;
}

export interface SeoDuplicateSlugMatch {
  language: SeoLanguage;
  slug?: string;
  message?: string;
}

export type LocalizedContentForm = FormGroup<{
  name: FormControl<string>;
  description: FormControl<string>;
  shortDescription: FormControl<string>;
  slug: FormControl<string>;
  imageAlt: FormControl<string>;
}>;

export type LanguageSeoForm = FormGroup<{
  metaTitle: FormControl<string>;
  metaDescription: FormControl<string>;
  keywordsText: FormControl<string>;
  ogTitle: FormControl<string>;
  ogDescription: FormControl<string>;
  canonicalOverride: FormControl<string>;
}>;

export type SeoEditorForm = FormGroup<{
  translations: FormGroup<{
    ar: LocalizedContentForm;
    en: LocalizedContentForm;
  }>;
  seo: FormGroup<{
    ar: LanguageSeoForm;
    en: LanguageSeoForm;
    ogImage: FormControl<string>;
    useEntityImageFallback: FormControl<boolean>;
    robotsIndex: FormControl<boolean>;
    robotsFollow: FormControl<boolean>;
    includeInSitemap: FormControl<boolean>;
    sitemapPriority: FormControl<number>;
    sitemapChangeFrequency: FormControl<SitemapChangeFrequency>;
  }>;
}>;

export interface SeoNormalizedExtension {
  translations?: EntityTranslations;
  seo?: EntitySeoData;
}

export interface SeoKeywordNormalizationResult {
  keywords: string[];
  removedDuplicateCount: number;
  removedEmptyCount: number;
}

