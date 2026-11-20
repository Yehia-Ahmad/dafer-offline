import { ServerApi } from './api-client';
import { isPrivatePath, robotsTxt, sitemapXml } from './seo-files';

const apiWith = (routes: Record<string, unknown>): ServerApi =>
  new ServerApi({
    base: 'http://api.test',
    fetchImpl: (async (url: string) => {
      const path = url.replace('http://api.test/api/store', '');
      const body = routes[path] ?? routes[path.split('?')[0]];
      return new Response(JSON.stringify(body), { status: body === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });

describe('sitemap and robots (Online Stage 7C: /privacy)', () => {
  const routes = {
    '/settings': { enabled: true },
    '/categories': { data: [{ id: 'c1', name: 'أدوات' }] },
    '/products': { data: [{ id: 'p1', slug: 'مفك' }], pagination: { totalPages: 1 } },
  };

  it('lists /privacy next to the other public pages', async () => {
    const xml = (await sitemapXml('https://shop-nota.com', apiWith(routes))) as string;
    expect(xml).toContain('<loc>https://shop-nota.com/privacy</loc>');
    expect(xml).toContain('<loc>https://shop-nota.com/policies/terms</loc>');
    expect(xml).toContain('<loc>https://shop-nota.com/delivery</loc>');
  });

  it('a closed website has no sitemap', async () => {
    expect(await sitemapXml('https://shop-nota.com', apiWith({ ...routes, '/settings': { enabled: false } }))).toBeNull();
  });

  it('/privacy is public: not disallowed in robots.txt and not noindex', () => {
    expect(robotsTxt('https://shop-nota.com')).not.toContain('/privacy');
    expect(isPrivatePath('/privacy')).toBeFalse();
  });
});
