/** Product name shown in the UI. Arabic is the primary name. */
export const BRAND = { nameAr: 'نوتة', nameEn: 'Nota' } as const;

/** Product name for the given UI language ('ar' or 'en'). */
export function brandName(lang: string | null | undefined): string {
  return lang === 'ar' ? BRAND.nameAr : BRAND.nameEn;
}
