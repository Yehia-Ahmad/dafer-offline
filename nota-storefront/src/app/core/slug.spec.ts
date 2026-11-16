import { ServerApi, UpstreamError } from '../../server/api-client';
import { slugRedirectFor } from '../../server/slug-redirect';
import { isPrivatePath, robotsTxt, sitemapXml } from '../../server/seo-files';
import { canonicalSlugPath, categoryPath, productPath, storeSlug } from './slug';

const ID = 'a'.repeat(24);
const fakeApi = (routes: Record<string, unknown>): ServerApi => ({
  get: async (path: string) => { if (!(path in routes)) throw new UpstreamError(404); return routes[path]; },
}) as unknown as ServerApi;

describe('storeSlug (same rule as the backend)', () => {
  it('gives exactly what the backend storeSlug gives (pairs computed with nota-backend/src/utils/storeSlug.js)', () => {
    const pairs: [string, string][] = [
      ['لمبة LED ١٨ وات', 'لمبة-led-١٨-وات'],
      ['  A / B -- C  ', 'a-b-c'],
      ['مَـرْحَبًا', 'مرحبا'],
      ['!!!', 'product'],
      ['أدوات كهربائية', 'أدوات-كهربائية'],
      ['كشاف ليد ٥٠ وات للحوائط', 'كشاف-ليد-٥٠-وات-للحوائط'],
      ['سلك ٢ مم · لفة ١٠٠ متر', 'سلك-٢-مم-لفة-١٠٠-متر'],
      ['Café Ünï', 'café-ünï'],
    ];
    for (const [name, slug] of pairs) expect(storeSlug(name)).withContext(name).toBe(slug);
  });
  it('falls back to "product" and caps at 80 characters', () => {
    expect(storeSlug('!!!')).toBe('product');
    expect(storeSlug('')).toBe('product');
    expect(storeSlug('a'.repeat(200)).length).toBe(80);
  });
  it('builds the link paths with the id first', () => {
    expect(productPath({ id: ID, slug: 'x' })).toEqual(['/p', ID, 'x']);
    expect(categoryPath({ id: ID, name: 'أدوات كهربائية' })).toEqual(['/c', ID, 'أدوات-كهربائية']);
  });
  it('canonicalSlugPath is null for the right slug and an encoded path for a wrong one', () => {
    expect(canonicalSlugPath('p', ID, 'abc', 'abc')).toBeNull();
    expect(canonicalSlugPath('p', ID, 'old', 'جديد')).toBe(`/p/${ID}/${encodeURIComponent('جديد')}`);
  });
});

describe('slug redirect (the server 301)', () => {
  const api = fakeApi({
    [`/products/${ID}`]: { slug: 'لمبة' },
    '/categories': { data: [{ id: 'b'.repeat(24), name: 'أدوات كهربائية' }] },
  });

  it('redirects a wrong product slug to the right one, keeping the query string', async () => {
    expect(await slugRedirectFor(`/p/${ID}/wrong`, '?a=1', api)).toBe(`/p/${ID}/${encodeURIComponent('لمبة')}?a=1`);
  });
  it('redirects a missing slug', async () => {
    expect(await slugRedirectFor(`/p/${ID}`, '', api)).toBe(`/p/${ID}/${encodeURIComponent('لمبة')}`);
  });
  it('does nothing for the right slug (even percent-encoded)', async () => {
    expect(await slugRedirectFor(`/p/${ID}/${encodeURIComponent('لمبة')}`, '', api)).toBeNull();
  });
  it('categories use the slug built from the name', async () => {
    const id = 'b'.repeat(24);
    expect(await slugRedirectFor(`/c/${id}/x`, '', api)).toBe(`/c/${id}/${encodeURIComponent('أدوات-كهربائية')}`);
    expect(await slugRedirectFor(`/c/${id}/${encodeURIComponent('أدوات-كهربائية')}`, '', api)).toBeNull();
  });
  it('leaves unknown ids, bad ids, other paths and a failing API to Angular (404 / error page)', async () => {
    expect(await slugRedirectFor(`/p/${'c'.repeat(24)}/x`, '', api)).toBeNull();
    expect(await slugRedirectFor('/p/not-an-id/x', '', api)).toBeNull();
    expect(await slugRedirectFor('/cart', '', api)).toBeNull();
    expect(await slugRedirectFor(`/c/${'d'.repeat(24)}/x`, '', api)).toBeNull();
  });
});

describe('robots, sitemap, private paths', () => {
  it('robots disallows the private paths and points to the sitemap', () => {
    const text = robotsTxt('https://shop.example.com');
    for (const p of ['/cart', '/checkout', '/account', '/order/', '/admin/']) expect(text).toContain(`Disallow: ${p}`);
    expect(text).toContain('Sitemap: https://shop.example.com/sitemap.xml');
  });
  it('knows which paths are the visitor\'s own', () => {
    expect(isPrivatePath('/cart')).toBeTrue();
    expect(isPrivatePath('/account/orders/1')).toBeTrue();
    expect(isPrivatePath('/order/abc')).toBeTrue();
    expect(isPrivatePath('/cartoon')).toBeFalse();
    expect(isPrivatePath('/p/1/x')).toBeFalse();
  });
  it('the sitemap lists home, visible categories and every product page, and is null while the site is closed', async () => {
    const api = fakeApi({
      '/settings': { enabled: true },
      '/categories': { data: [{ id: 'b'.repeat(24), name: 'قسم' }] },
      '/products?limit=48&page=1&sort=newest': { data: [{ id: ID, slug: 'لمبة' }], pagination: { totalPages: 2 } },
      '/products?limit=48&page=2&sort=newest': { data: [{ id: 'c'.repeat(24), slug: 'x&y' }], pagination: { totalPages: 2 } },
    });
    const xml = (await sitemapXml('https://s.example', api))!;
    expect(xml).toContain('<loc>https://s.example/</loc>');
    expect(xml).toContain(`/c/${'b'.repeat(24)}/${encodeURIComponent('قسم')}`);
    expect(xml).toContain(`/p/${ID}/${encodeURIComponent('لمبة')}`);
    expect(xml).toContain(`/p/${'c'.repeat(24)}/x%26y`);
    expect(await sitemapXml('https://s.example', fakeApi({ '/settings': { enabled: false } }))).toBeNull();
  });
});
