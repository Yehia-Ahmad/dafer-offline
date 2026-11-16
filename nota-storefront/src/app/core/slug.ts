// The same rule as nota-backend/src/utils/storeSlug.js. Products carry their slug from the API; categories do not, so the
// storefront builds theirs with this function (and the URL always carries the id, which is what the API looks up).
// Written with explicit code points on purpose: U+064B-U+065F, U+0670 and U+0640 (the tashkeel and the tatweel). A wider range would also eat the Arabic-Indic digits.
const DIACRITICS = new RegExp('[\\u064B-\\u065F\\u0670\\u0640]', 'g');

export const storeSlug = (name: string | null | undefined): string => {
  const slug = String(name || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(DIACRITICS, '') // Arabic diacritics and tatweel
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'product';
};

export const productPath = (p: { id: string; slug?: string; name?: string }): string[] => ['/p', p.id, p.slug || storeSlug(p.name)];
export const categoryPath = (c: { id: string; name: string }): string[] => ['/c', c.id, storeSlug(c.name)];

/** The path a wrong-slug request should be redirected to, or null when the slug is right. */
export const canonicalSlugPath = (kind: 'p' | 'c', id: string, requestedSlug: string, correctSlug: string): string | null =>
  requestedSlug === correctSlug ? null : `/${kind}/${id}/${encodeURIComponent(correctSlug)}`;
