// Dev script (not part of the build): one phone screenshot of a route after some clicks, to review sheets and detail states.
//   node scripts/mobile-shot.mjs <route> <out.png> [selector ...]
// Clicks each selector in order ( "selector::text" types text instead), then saves a viewport shot at 390x844. Needs the same env as mobile-audit.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const DESKTOP = process.argv.includes('--desktop'); // 1280x800 instead of the phone
const FULL = process.argv.includes('--full'); // a full-page shot (the tab bar and floating button made static)
const [route, out, ...clicks] = process.argv.slice(2).filter((a) => a !== '--full' && a !== '--desktop');
const URL_BASE = (process.env.AUDIT_URL || 'http://localhost:4200').replace(/\/$/, '');
const API = (process.env.AUDIT_API || 'http://localhost:5000').replace(/\/$/, '');
const login = await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nota-Device-Id': 'mobile-audit-device' }, body: JSON.stringify({ username: process.env.AUDIT_USER || 'owner', password: process.env.AUDIT_PASS || '' }) })).json();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: DESKTOP ? { width: 1280, height: 800 } : { width: 390, height: 844 }, locale: 'ar-EG', ...(DESKTOP ? {} : { hasTouch: true, isMobile: true }) });
await context.addInitScript((t) => { localStorage.setItem('nota.deviceId', 'mobile-audit-device'); localStorage.setItem('nota.deviceName', 'mobile-audit'); sessionStorage.setItem('nota.session', t); }, login.token);
const page = await context.newPage();
await page.goto(`${URL_BASE}${route}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
for (const step of clicks) { // "selector" clicks; "selector::text" types text
  const [selector, text] = step.split("::");
  if (text !== undefined) await page.locator(selector).first().fill(text); else await page.locator(selector).first().click();
  await page.waitForTimeout(700);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
if (FULL) await page.addStyleTag({ content: '.m-tabs{position:static!important}.m-fab{position:static!important;margin:12px}.m-form .m-actions{position:static!important}' });
await page.screenshot({ path: out, fullPage: FULL });
console.log('saved', out);
await browser.close();
