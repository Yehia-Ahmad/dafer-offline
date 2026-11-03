import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

export function slugValidator(): ValidatorFn {
  return (control: AbstractControl<string>): ValidationErrors | null => {
    const value = String(control.value || '').trim();
    if (!value) return null;
    if (value.length > 150) return { slugMaxLength: true };
    if (value.includes('/')) return { slugSlash: true };
    if (value.includes('?')) return { slugQuery: true };
    if (/^https?:\/\//i.test(value)) return { slugProtocol: true };
    if (/^-|-$/.test(value)) return { slugEdgeHyphen: true };
    if (/--/.test(value)) return { slugRepeatedHyphen: true };
    return null;
  };
}

export function metaTitleValidator(): ValidatorFn {
  return (control: AbstractControl<string>): ValidationErrors | null => {
    const value = String(control.value || '').trim();
    return value.length > 70 ? { metaTitleMaxLength: true } : null;
  };
}

export function metaDescriptionValidator(): ValidatorFn {
  return (control: AbstractControl<string>): ValidationErrors | null => {
    const value = String(control.value || '').trim();
    return value.length > 200 ? { metaDescriptionMaxLength: true } : null;
  };
}

export function canonicalUrlValidator(): ValidatorFn {
  return (control: AbstractControl<string>): ValidationErrors | null => {
    const value = String(control.value || '').trim();
    if (!value) return null;
    return /^https?:\/\/\S+$/i.test(value) ? null : { canonicalUrl: true };
  };
}

export function keywordsTextValidator(): ValidatorFn {
  return (control: AbstractControl<string>): ValidationErrors | null => {
    const keywords = String(control.value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (keywords.length > 20) return { keywordsCount: true };
    if (keywords.some((keyword) => keyword.length > 60)) {
      return { keywordMaxLength: true };
    }
    return null;
  };
}

export function sitemapPriorityValidator(): ValidatorFn {
  return (control: AbstractControl<number>): ValidationErrors | null => {
    const value = Number(control.value);
    if (!Number.isFinite(value)) return { sitemapPriority: true };
    return value >= 0 && value <= 1 ? null : { sitemapPriority: true };
  };
}
