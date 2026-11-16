// Dev script (not part of the build). Phone audit of every admin route, at 390x844 and 1280x800.
//   node scripts/mobile-audit.mjs [--label final] [--only 390|1280] [--baseline-diff baseline]
// Needs: a running local backend with seed data (scripts/mobile-audit-seed.mjs wrote mobile-audit/ids.json) and the admin app
// served (ng serve) at AUDIT_URL. Uses the installed Chrome (channel 'chrome'): no browser download.
// 390:  fails on horizontal page scroll, any console error, or a missing phone shell (tab bar); full-page screenshot per route.
// 1280: fails if the phone shell appears; one screenshot per route (desktop regressions stay visible).
// Screenshots: mobile-audit/<label>-390/*.png and mobile-audit/<label>-1280/*.png (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const LABEL = arg('label', 'final');
const ONLY = arg('only', '');
const FAIL_ON_EDGE = process.argv.includes('--fail-on-edge'); // edge-hugging is a warning unless asked
const ROUTE_FILTER = arg('route', ''); // comma-separated substrings (a route is audited when it contains any of them), for quick runs while building
const URL_BASE = (process.env.AUDIT_URL || 'http://localhost:4200').replace(/\/$/, '');
const API = (process.env.AUDIT_API || 'http://localhost:5000').replace(/\/$/, '');
const USER = process.env.AUDIT_USER || 'owner';
const PASS = process.env.AUDIT_PASS || '';
const ROOT = path.resolve('mobile-audit');
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'ids.json'), 'utf8')).ids;
const FAKE = '000000000000000000000000';
const id = (key) => ids[key] || FAKE;

// Routes with no tab bar by design (no app frame): login, no-access, ui-kit.
const NO_SHELL = new Set(['/login', '/no-access']);
const routes = [
  '/login', '/no-access', '/home', '/more',
  '/customers', `/customers/${id('customer')}`,
  '/selling', '/credit-sales', '/credit-sales/new', '/invoice-history', '/returns',
  '/products', '/products/new', `/products/edit/${id('product')}`, '/products/profit-report',
  '/accounting/accounts', '/accounting/opening', '/accounting/vat', '/accounting/reports',
  '/accounting/manual-entry', `/accounting/manual-entry/${id('manualEntry')}`, '/accounting/closing',
  '/accounting/journal', `/accounting/journal/${id('journal')}`, `/accounting/accounts/${id('account')}/ledger`,
  '/suppliers', '/suppliers/new', `/suppliers/edit/${id('supplier')}`,
  '/purchases', '/purchases/new', `/purchases/${id('purchase')}`,
  '/cashbox', `/cashbox/${id('box')}`, '/expenses',
  '/shop-profile', '/website/settings', '/orders', `/orders/${id('order')}`,
  '/website/couriers', `/website/couriers/${id('courier')}`, '/website/customers',
  '/users', '/audit',
];
// Elements inside these are meant to scroll sideways (and may extend past the screen): the clip check skips their descendants.
const SCROLLERS = '.mob-hscroll, .m-chips, .m-scroll';
// Online Stage 6B: scrollWidth misses content clipped on the left in RTL, so every visible element's rect must lie inside 0..innerWidth.
async function clipped(page) {
  return page.evaluate((scrollers) => {
    const w = window.innerWidth;
    const bad = [];
    const label = (el) => {
      const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + ' "' + text + '"';
    };
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest(scrollers) && !el.matches(scrollers)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      if (el.closest('[aria-hidden="true"], .nota-sr-only, .cdk-visually-hidden, .p-hidden-accessible')) continue;
      if (r.left < -1 || r.right > w + 1) bad.push(el);
    }
    const set = new Set(bad); // only the outermost offenders
    return bad.filter((el) => !set.has(el.parentElement)).map(label);
  }, SCROLLERS);
}
// Online Stage 6B: text, buttons, inputs and selects closer than 8 px to the left / right screen edge (outside full-bleed shell parts) are
// reported as warnings. Text is measured with a Range, so it is the glyphs' own box, not the card around them.
const FULL_BLEED = '.m-top, .m-tabs, .m-actions, .m-sheet, .m-sheet__scrim, .m-pwa, .p-dialog, .p-dialog-mask, .p-overlay, .m-fab, .m-form .m-actions';
async function edgeHug(page) {
  return page.evaluate(([scrollers, bleed]) => {
    const w = window.innerWidth; const out = new Map();
    const label = (el) => {
      const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + ' "' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20) + '"';
    };
    const visible = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
    const skip = (el) => el.closest(bleed) || el.closest(scrollers) || el.closest('[aria-hidden="true"], .nota-sr-only, .cdk-visually-hidden, .p-hidden-accessible');
    const hug = (r) => r.width >= 1 && r.height >= 1 && (r.left < 8 || r.right > w - 8) && r.left > -1 && r.right < w + 1; // beyond the screen = the clip check's job
    for (const el of document.body.querySelectorAll('button, a, input, select, textarea')) {
      if (skip(el) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (hug(r)) out.set(el, label(el));
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode; const parent = node.parentElement;
      if (!parent || !node.textContent.trim() || skip(parent) || !visible(parent) || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (hug(r)) out.set(parent, label(parent));
    }
    return [...new Set(out.values())];
  }, [SCROLLERS, FULL_BLEED]);
}
const fileName = (route) => (route.replace(/^\//, '').replace(/[\/:]/g, '_') || 'root') + '.png';

async function signIn() {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nota-Device-Id': 'mobile-audit-device', 'X-Nota-Device-Name': 'mobile-audit' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return (await response.json()).token;
}

async function run(browser, size, token) {
  const [width, height] = size === '390' ? [390, 844] : [1280, 800];
  const dir = path.join(ROOT, `${LABEL}-${size}`);
  fs.mkdirSync(dir, { recursive: true });
  const results = [];
  for (const route of routes.filter((r) => !ROUTE_FILTER || ROUTE_FILTER.split(",").some((f) => r.includes(f)))) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'ar-EG', deviceScaleFactor: 1, ...(size === '390' ? { hasTouch: true, isMobile: true } : {}) });
    // The session token lives in sessionStorage ('nota.session'); set it before the app starts (login page excepted).
    // The device name is stored too, so the one-time 'name this device' question does not cover the screens.
    await context.addInitScript(({ t, login }) => { try { localStorage.setItem('nota.deviceId', 'mobile-audit-device'); localStorage.setItem('nota.deviceName', 'mobile-audit'); if (!login) sessionStorage.setItem('nota.session', t); } catch { /* ignore */ } }, { t: token, login: route === '/login' });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 160)); });
    page.on('pageerror', (error) => errors.push(`pageerror: ${String(error.message).slice(0, 160)}`));
    const problems = [];
    let clipList = [];
    let edgeList = [];
    try {
      await page.goto(`${URL_BASE}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(600);
      const info = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
        shell: !!document.querySelector('nota-mobile-shell, .m-tabbar, nav.m-tabs'),
        path: location.pathname,
      }));
      if (size === '390') {
        clipList = await clipped(page);
        edgeList = await edgeHug(page);
        const clip = clipList;
        if (clip.length) problems.push(`clipped(${clip.length}): ${clip.slice(0, 4).join(' | ')}`);
        if (info.scrollWidth > info.innerWidth) problems.push(`h-scroll ${info.scrollWidth}>${info.innerWidth}`);
        if (!info.shell && !NO_SHELL.has(route)) problems.push('no phone shell');
        if (errors.length) problems.push(`console: ${errors[0]}`);
      } else if (info.shell) problems.push('phone shell at 1280');
      if (info.path.replace(/^\/admin/, '') !== route && !problems.length) problems.push(`redirected to ${info.path}`);
      if (size === '390') {
        await page.screenshot({ path: path.join(dir, fileName(route).replace('.png', '.viewport.png')), fullPage: false });
        // Full-page shots: the fixed tab bar / floating button would land mid-page, so they are made static (audit only).
        await page.addStyleTag({ content: '.m-tabs{position:static!important}.m-fab{position:static!important;margin:12px}.m-form .m-actions{position:static!important}' });
      }
      await page.screenshot({ path: path.join(dir, fileName(route)), fullPage: true });
    } catch (error) {
      problems.push(`error: ${String(error.message).split('\n')[0]}`);
    }
    if (edgeList.length) problems.push(`edge(${edgeList.length}): ${edgeList.slice(0, 3).join(' | ')}`);
    results.push({ route, ok: problems.filter((p) => !p.startsWith('edge(')).length === 0 && !(FAIL_ON_EDGE && edgeList.length), problems, clipped: clipList, edge: edgeList });
    await context.close();
  }
  return results;
}

const token = await signIn();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const all = {};
try {
  for (const size of ['390', '1280']) {
    if (ONLY && ONLY !== size) continue;
    all[size] = await run(browser, size, token);
  }
} finally { await browser.close(); }

let failed = 0;
for (const size of Object.keys(all)) {
  console.log(`\n=== ${size} ===`);
  for (const r of all[size]) { if (!r.ok) failed++; console.log(`${r.ok ? (r.edge?.length ? 'WARN' : 'PASS') : 'FAIL'}  ${r.route.padEnd(52)} ${r.problems.join('; ')}`); }
}
fs.writeFileSync(path.join(ROOT, `${LABEL}-results.json`), JSON.stringify(all, null, 2));
console.log(`\n${failed} failing route/size combinations`);
process.exitCode = failed ? 1 : 0;
