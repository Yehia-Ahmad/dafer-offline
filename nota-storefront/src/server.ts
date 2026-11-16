import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { join } from 'node:path';
import { ServerApi } from './server/api-client';
import { isPrivatePath, robotsTxt, sitemapXml } from './server/seo-files';
import { slugRedirectFor } from './server/slug-redirect';

const browserDistFolder = join(import.meta.dirname, '../browser');

// Rendering is done here, next to the backend: NOTA_API_INTERNAL is the backend's loopback URL.
// Angular refuses a Host it does not know (it would otherwise fall back to client-side rendering, which Google cannot read), and
// '*' is not a wildcard in this Angular version, so the hosts are listed: the shop's domain (NOTA_PUBLIC_URL, written by
// setup-server.sh), anything in NOTA_STOREFRONT_HOSTS (comma separated), and localhost for the health checks.
const hostOf = (url: string | undefined): string[] => { try { return url ? [new URL(url).hostname] : []; } catch { return []; } };
const allowedHosts = [...new Set([
  'localhost', '127.0.0.1',
  ...hostOf(process.env['NOTA_PUBLIC_URL']),
  ...(process.env['NOTA_STOREFRONT_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean),
])];
const app = express();
// nginx adds X-Forwarded-For / -Proto; without trusting them Angular would drop them and render client-side only.
const angularApp = new AngularNodeAppEngine({ allowedHosts, trustProxyHeaders: ['x-forwarded-for', 'x-forwarded-proto'] });
const api = new ServerApi();

app.disable('x-powered-by');

const originOf = (req: Request): string => {
  const fixed = process.env['NOTA_PUBLIC_URL'];
  if (fixed) return fixed.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
  return `${proto}://${req.headers.host}`;
};

// The storefront's own health route (update.sh waits for it). It does not call the backend: the process being up is the point.
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, service: 'nota-storefront' });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsTxt(originOf(req)));
});

const sitemapCache = new Map<string, { exp: number; xml: string | null }>();
app.get('/sitemap.xml', async (req, res) => {
  const origin = originOf(req);
  try {
    let hit = sitemapCache.get(origin);
    if (!hit || hit.exp < Date.now()) {
      hit = { exp: Date.now() + 10 * 60 * 1000, xml: await sitemapXml(origin, api) };
      sitemapCache.set(origin, hit);
    }
    if (hit.xml === null) { res.status(503).set({ 'Retry-After': '3600', 'X-Nota-Closed': '1' }).type('text/plain').send('closed'); return; }
    res.type('application/xml').set('Cache-Control', 'public, max-age=600').send(hit.xml);
  } catch {
    res.status(503).set('Retry-After', '60').type('text/plain').send('unavailable');
  }
});

// The visitor's own pages are never indexed or cached by shared caches; the order page also sends no Referer (its URL holds the tracking token).
app.use((req, res, next) => {
  if (isPrivatePath(req.path)) {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
    if (req.path.startsWith('/order/')) res.set('Referrer-Policy', 'no-referrer');
  }
  next();
});

// Real 301s for a wrong or missing slug (Angular's router can only answer 302 while rendering).
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || !/^\/(p|c)\//.test(req.path)) { next(); return; }
  try {
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const to = await slugRedirectFor(req.path, search, api);
    if (to) { res.redirect(301, to); return; }
  } catch { /* fall through: Angular renders the page or its error */ }
  next();
});

const HASHED = /-[A-Z0-9]{8}\.(js|css|woff2?)$/;
app.use(
  express.static(browserDistFolder, {
    index: false,
    redirect: false,
    setHeaders: (res, path) => {
      res.setHeader('Cache-Control', HASHED.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=86400');
    },
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

// Never show a stack trace; the API being down is handled inside the app (503 page), this is the last resort.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('storefront render failed:', error instanceof Error ? error.message : error);
  res.status(503).set({ 'Retry-After': '30', 'Cache-Control': 'no-store' }).type('text/html; charset=utf-8')
    .send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مشكلة مؤقتة</title><body style="font-family:sans-serif;text-align:center;padding:4rem"><h1>في مشكلة مؤقتة</h1><p>جرّب بعد شوية.</p></body></html>');
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = Number(process.env['NOTA_STOREFRONT_PORT'] || 4000);
  const host = process.env['NOTA_STOREFRONT_HOST'] || '127.0.0.1';
  const server = app.listen(port, host, (error) => {
    if (error) throw error;
    console.log(`Nota storefront listening on http://${host}:${port}`);
  });
  // systemd stops with SIGTERM and waits TimeoutStopSec=20: finish the requests in flight, then leave.
  const shutdown = (): void => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 15000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export const reqHandler = createNodeRequestHandler(app);
