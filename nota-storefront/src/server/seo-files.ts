import { storeSlug } from '../app/core/slug';
import { ServerApi } from './api-client';

export const PRIVATE_PATHS = ['/cart', '/checkout', '/account', '/order/', '/admin/'];
// Online Stage 7A: tracking redirects and the product feeds are for ad platforms, not for search engines.
const ROBOTS_ONLY = ['/go/', '/feeds/'];

const escapeXml = (value: string): string => value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);

export const robotsTxt = (origin: string): string =>
  ['User-agent: *', ...[...PRIVATE_PATHS, ...ROBOTS_ONLY].map((p) => `Disallow: ${p}`), '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');

/** Is this request path one the visitor owns (cart, checkout, account, order tracking)? They get X-Robots-Tag: noindex. */
export const isPrivatePath = (pathname: string): boolean =>
  PRIVATE_PATHS.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));

interface ProductRow { id: string; slug: string }
interface Pagination { totalPages: number }

/** Home, the categories and every visible product (the API pages at 48; there is no bulk endpoint and no lastmod field). */
export const sitemapXml = async (origin: string, api: ServerApi): Promise<string | null> => {
  const settings = await api.get<{ enabled?: boolean }>('/settings', 30);
  if (settings.enabled === false) return null; // closed website: no sitemap
  const urls: string[] = [`${origin}/`];
  const categories = (await api.get<{ data: { id: string; name: string }[] }>('/categories', 30)).data;
  for (const c of categories) urls.push(`${origin}/c/${c.id}/${encodeURIComponent(storeSlug(c.name))}`);
  let page = 1;
  let pages = 1;
  const MAX_PAGES = 200; // 9,600 products: a safety stop, not a limit anyone should reach
  do {
    const result = await api.get<{ data: ProductRow[]; pagination: Pagination }>(`/products?limit=48&page=${page}&sort=newest`, 60);
    for (const p of result.data) urls.push(`${origin}/p/${p.id}/${encodeURIComponent(p.slug)}`);
    pages = result.pagination.totalPages;
    page += 1;
  } while (page <= pages && page <= MAX_PAGES);
  urls.push(`${origin}/delivery`, `${origin}/policies/returns`, `${origin}/policies/terms`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
};
