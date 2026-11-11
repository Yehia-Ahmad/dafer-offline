#!/usr/bin/env node
// Development tool (not shipped): takes the Stage 22 review screenshots into ../nota-review/stage-22/.
//
// Starts a throwaway mongod (port 27109) and nota-backend (port 5109) on a fresh temp folder, seeds the design's October through the
// API (sales 37,450, discount 650, COGS 25,300, expenses 9,400), serves dist-offline/browser on port 5110 (adding the LAN key to /api
// calls, like the desktop app does) and drives headless Chrome over the DevTools protocol. It never touches port 27017, the real
// database or C:\ProgramData\Nota, and removes everything it started.
//
//   npm run build:offline && node scripts/offline/screenshots-stage22.js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.resolve(ROOT, '..', 'nota-backend');
const DIST = path.join(ROOT, 'dist-offline', 'browser');
const OUT = path.resolve(ROOT, '..', 'nota-review', 'stage-22');
const MONGOD = path.join(ROOT, 'vendor', 'mongodb', 'bin', process.platform === 'win32' ? 'mongod.exe' : 'mongod');
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { MongoClient } = require(path.join(BACKEND_DIR, 'node_modules', 'mongodb'));

const MONGO_PORT = 27109; const BACKEND_PORT = 5109; const WEB_PORT = 5110; const CDP_PORT = 9335;
const LAN_SECRET = 'shots-secret-123'; const JWT_SECRET = 'shots-jwt-secret-0123456789abcdef-0123456789';
const OWNER = { name: 'أحمد', username: 'shots-owner', password: 'owner-pass-123' };
if ([MONGO_PORT, BACKEND_PORT, WEB_PORT, CDP_PORT].includes(27017)) throw new Error('never port 27017');

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const inLastMonth = (day) => dayKey(new Date(now.getFullYear(), now.getMonth() - 1, day));
const LAST_END = dayKey(new Date(now.getFullYear(), now.getMonth(), 0));
const TODAY = dayKey(now);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[shots] ${message}`);

const children = [];
let temp = null;
const killTree = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
};
const isPortOpen = (port) => new Promise((resolve) => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
const waitFor = async (what, check, timeout = 60000) => { const began = Date.now(); while (Date.now() - began < timeout) { if (await check()) return; await sleep(250); } throw new Error(`timed out waiting for ${what}`); };
const start = (command, args, options = {}) => { const out = fs.openSync(path.join(temp, `${path.basename(command)}-${children.length}.log`), 'a'); const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', out, out] }); children.push(child); return child; };

// ------------------------------------------------------------------ backend and data
let token = null;
const api = async (method, route, body, { binary = false } = {}) => {
  const response = await fetch(`http://127.0.0.1:${BACKEND_PORT}${route}`, {
    method, headers: { 'x-nota-lan-key': LAN_SECRET, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  if (binary) return response;
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 200)}`);
  return json;
};

async function startServers() {
  for (const port of [MONGO_PORT, BACKEND_PORT, WEB_PORT, CDP_PORT]) if (await isPortOpen(port)) throw new Error(`port ${port} is in use`);
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist-offline is missing: run npm run build:offline first');
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_BIN)`);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-shots-'));
  fs.mkdirSync(path.join(temp, 'db'));
  const mongod = start(MONGOD, ['--dbpath', path.join(temp, 'db'), '--port', String(MONGO_PORT), '--bind_ip', '127.0.0.1', '--replSet', 'rs0', '--logpath', path.join(temp, 'mongod.log'), '--wiredTigerCacheSizeGB', '0.25']);
  await waitFor('mongod', () => isPortOpen(MONGO_PORT));
  const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { directConnection: true });
  await client.connect();
  try {
    const admin = client.db('admin');
    if (!(await admin.command({ hello: 1 })).setName) await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${MONGO_PORT}` }] } });
    await waitFor('mongod primary', async () => (await admin.command({ hello: 1 })).isWritablePrimary === true);
  } finally { await client.close(); }
  const env = { ...process.env, PORT: String(BACKEND_PORT), MONGO_URI: `mongodb://127.0.0.1:${MONGO_PORT}/nota_shots?replicaSet=rs0&directConnection=true`, NOTA_LAN_MODE: '1', NOTA_LAN_SECRET: LAN_SECRET, NOTA_LISTEN_HOST: '127.0.0.1', NOTA_AUTH: '1', NOTA_JWT_SECRET: JWT_SECRET };
  start(process.execPath, ['src/server.js'], { cwd: BACKEND_DIR, env });
  await waitFor('backend', async () => { try { return (await fetch(`http://127.0.0.1:${BACKEND_PORT}/`)).ok; } catch { return false; } });
  log('mongod and backend are up');
}

async function seed() {
  const owner = await api('POST', '/api/auth/setup-owner', OWNER);
  token = owner.token;
  const ar = (value) => value;
  await api('PUT', '/api/shop-profile', { name: 'النور للأدوات الكهربائية', taxNumber: '', phones: [], address: ar('المنصورة') });
  await api('POST', '/api/accounting/opening', { cash: 50000 });
  const accounts = (await api('GET', '/api/accounting/manual-entries/accounts')).data;
  const id = (code) => accounts.find((row) => row.code === code)._id;
  const category = await api('POST', '/api/categories', { name: 'كهربائيات' });
  const make = (name, code, stock, cost, price) => api('POST', '/api/products', { name, code, categoryId: category._id, inventoryCount: stock, purchasePrice: cost, wholesalePrice: price - 1, retailPrice: price });
  const a = await make('لمبة ليد ١٠٠', 'A100', 400, 70, 100); const b = await make('كابل ٧٤', 'B74', 200, 43, 74.5);
  const customer = await api('POST', '/api/customers', { name: 'م. سامي للمقاولات', phone: '01012345678' });
  await api('POST', '/api/customers', { name: 'متجر الأمل', phone: '01099887766' });
  await api('POST', '/api/sellings', { customerName: 'نقدي', customerPhone: '01017171718', sellingDate: inLastMonth(10), discountAmount: 400, items: [{ productId: a._id, quantity: 300, price: 100 }] });
  await api('POST', '/api/credit-sales', { customerId: customer._id, sellingDate: inLastMonth(12), discountAmount: 250, items: [{ productId: b._id, quantity: 100, price: 74.5 }] });
  for (const [code, amount, day] of [['521', 4500, 25], ['522', 3500, 26], ['523', 650, 27], ['524', 420, 27], ['525', 330, 28]]) await api('POST', '/api/expenses', { accountId: id(code), amount, date: inLastMonth(day) });
  const supplier = await api('POST', '/api/suppliers', { name: 'الشركة المصرية للإضاءة' });
  await api('POST', '/api/purchases', { supplierId: supplier._id, date: inLastMonth(5), items: [{ productId: a._id, qty: 10, unitPrice: 70 }], paidAmount: 0 });
  // an unposted draft dated last month: it blocks the close until it is dealt with
  const draft = await api('POST', '/api/accounting/manual-entries', { date: inLastMonth(28), memo: 'كهرباء مستحقة', lines: [{ accountId: id('523'), debit: 300 }, { accountId: id('23'), credit: 300 }] });
  return { id, customer, draft, accounts };
}

// ------------------------------------------------------------------ the web server (static build + /api proxy with the LAN key)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.txt': 'text/plain' };
function startWeb() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${WEB_PORT}`);
    if (url.pathname.startsWith('/api/')) {
      const upstream = http.request({ host: '127.0.0.1', port: BACKEND_PORT, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}`, 'x-nota-lan-key': LAN_SECRET } }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { res.statusCode = 502; res.end(); });
      req.pipe(upstream);
      return;
    }
    const extension = path.extname(url.pathname).toLowerCase();
    const file = extension && MIME[extension] ? path.join(DIST, ...url.pathname.split('/').slice(1)) : path.join(DIST, 'index.html');
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : (extension ? path.join(DIST, path.basename(url.pathname)) : path.join(DIST, 'index.html'));
    if (!fs.existsSync(target)) { res.statusCode = 404; res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  });
  return new Promise((resolve) => server.listen(WEB_PORT, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------------ Chrome over the DevTools protocol
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.on('message', (data) => { const message = JSON.parse(String(data)); if (message.id && this.pending.has(message.id)) { const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id); if (message.error) reject(new Error(`${message.error.message}`)); else resolve(message.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed'); return result.result.value; }
}

async function openChrome() {
  start(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(temp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1360,900', 'about:blank']);
  await waitFor('chrome', () => isPortOpen(CDP_PORT));
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  return cdp;
}

const bridgeSource = (lang, theme, userToken) => `
  try { localStorage.setItem('lang', ${JSON.stringify(lang)}); localStorage.setItem('theme', ${JSON.stringify(theme)}); sessionStorage.setItem('nota.session', ${JSON.stringify(userToken)}); } catch (e) {}
  window.notaDesktop = { getRuntimeConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:${WEB_PORT}/api/', role: 'main', appVersion: '1.0.0', serverVersion: null, deviceId: 'shots-device-0001', deviceName: 'SHOTS-PC' }) };
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await startServers();
  const data = await seed();
  const web = await startWeb();
  const cdp = await openChrome();
  let scriptId = null;
  const wait = (selector, timeout = 20000) => waitFor(selector, () => cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`), timeout);
  const click = (selector) => cdp.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const setValue = (selector, value, event = 'input') => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  let currentWidth = 1360;
  const setViewport = (width, height) => { currentWidth = width; return cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }); };

  /** A fresh page load (the language and the theme are read at start), then an in-app route (history + popstate: the router listens). */
  const visit = async (route, { lang = 'ar', theme = 'light', width = 1360, height = 900 } = {}) => {
    if (scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    scriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bridgeSource(lang, theme, token) })).identifier;
    await setViewport(width, height);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/` });
    await waitFor('the app', () => cdp.eval('!!document.querySelector("app-root, nota-sidenav, app-side-nav, main")'), 30000);
    await sleep(900);
    await cdp.eval(`(() => { history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate')); })()`);
    await sleep(900);
  };
  const shot = async (name, { fullHeight = 0 } = {}) => {
    await sleep(700);
    if (fullHeight) await setViewport(currentWidth, fullHeight);
    await sleep(300);
    const { data: png } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(png, 'base64'));
    log(`${name}`);
  };
  const tab = async (name) => { await click(`[data-tab="${name}"]`); await sleep(700); };

  try {
    // ---- the reports, last month = the design's October
    for (const [lang, theme] of [['ar', 'light'], ['ar', 'dark'], ['en', 'light'], ['en', 'dark']]) {
      await visit('/accounting/reports', { lang, theme });
      await wait('[data-report="income"] table');
      await click('[data-preset="lastMonth"]'); await sleep(900);
      await wait('[data-row="netProfit"]');
      await shot(`reports-income-${lang}-${theme}.png`, { fullHeight: 1150 });
    }
    await visit('/accounting/reports', { width: 390, height: 1300 });
    await wait('[data-report="income"] table'); await click('[data-preset="lastMonth"]'); await sleep(900); await wait('[data-row="netProfit"]');
    await shot('reports-income-390-ar-light.png', { fullHeight: 2000 }).catch(() => undefined);
    await visit('/accounting/reports');
    await wait('[data-report="income"] table');
    await tab('balance'); await wait('[data-total="assets"]');
    await shot('reports-balance-ar-light.png', { fullHeight: 1150 });
    await tab('trial'); await click('[data-preset="thisYear"]'); await sleep(900); await wait('[data-test="trial-totals"]');
    await shot('reports-trial-ar-light.png', { fullHeight: 1500 });
    await tab('boxes'); await sleep(500); await wait('[data-test="boxes-totals"]');
    await click('[data-box]'); await sleep(500);
    await shot('reports-boxes-ar-light.png', { fullHeight: 900 });
    await tab('parties'); await wait('[data-test="customers-table"]');
    await shot('reports-parties-ar-light.png', { fullHeight: 1000 });

    // ---- a manual entry: a bad debt written off on a customer
    await visit('/accounting/manual-entry');
    await wait('[data-line="2"] [data-field="account"]');
    await setValue('[data-line="1"] [data-field="account"]', data.id('525'), 'change');
    await setValue('[data-line="1"] [data-field="description"]', 'ديون معدومة');
    await setValue('[data-line="1"] [data-field="debit"]', '300');
    await setValue('[data-line="2"] [data-field="account"]', data.id('113'), 'change');
    await wait(`[data-line="2"] [data-field="party"] option[value="${data.customer._id}"]`);
    await setValue('[data-line="2"] [data-field="party"]', data.customer._id, 'change');
    await setValue('[data-line="2"] [data-field="description"]', 'إعدام دين عميل');
    await setValue('[data-line="2"] [data-field="credit"]', '300');
    await setValue('[data-test="memo"]', 'إعدام دين عميل متعثر');
    await shot('manual-entry-ar-light.png', { fullHeight: 1000 });

    // ---- add an account under 520 (an expense category)
    await visit('/accounting/accounts');
    await wait('[data-action="new-account"]');
    await click('[data-action="new-account"]');
    await wait('[data-field="parent"]');
    await setValue('[data-field="parent"]', data.accounts.length ? (await api('GET', '/api/accounting/accounts')).accounts.flatMap(function walk(row) { return [row, ...(row.children || []).flatMap(walk)]; }).find((row) => row.code === '520')._id : '', 'change');
    await waitFor('the automatic code', () => cdp.eval('(document.querySelector("[data-test=auto-code]")||{}).textContent?.includes("52001")'));
    await setValue('[data-field="nameAr"]', 'صيانة وإصلاحات');
    await shot('add-account-ar-light.png', { fullHeight: 900 });

    // ---- the closing screen with a checklist (an unposted draft and the opening not finalized block it)
    await visit('/accounting/closing');
    await wait('[data-test="checklist"]');
    await shot('closing-checklist-ar-light.png', { fullHeight: 1250 });
    await visit('/accounting/closing', { lang: 'en', theme: 'dark' });
    await wait('[data-test="checklist"]');
    await shot('closing-checklist-en-dark.png', { fullHeight: 1250 });

    // ---- close last month, then show the PERIOD_LOCKED banner on a posting form
    await api('DELETE', `/api/accounting/manual-entries/${data.draft._id}`);
    await api('POST', '/api/accounting/opening/finalize', { confirm: true });
    const closed = await api('POST', '/api/accounting/closing/close', { confirm: true, periodEnd: LAST_END });
    log(`closed ${closed.close.label} (locked through ${closed.lockedThrough})`);
    await visit('/accounting/closing');
    await wait('[data-test="locked-through"]');
    await shot('closing-after-close-ar-light.png', { fullHeight: 1100 });
    await visit('/accounting/manual-entry');
    await wait('[data-test="date"]');
    await setValue('[data-test="date"]', inLastMonth(15));
    await setValue('[data-test="memo"]', 'قيد بتاريخ في فترة مقفولة');
    await wait('[data-test="lock-banner"]');
    await shot('period-locked-banner-ar-light.png', { fullHeight: 800 });
    await visit('/accounting/manual-entry', { lang: 'en', theme: 'dark' });
    await wait('[data-test="date"]');
    await setValue('[data-test="date"]', inLastMonth(15));
    await wait('[data-test="lock-banner"]');
    await shot('period-locked-banner-en-dark.png', { fullHeight: 800 });
  } finally {
    web.close();
    try { cdp.ws.close(); } catch { /* closed */ }
  }
}

main().then(() => { log(`done: ${fs.readdirSync(OUT).length} files in ${OUT}`); }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  for (const child of children.reverse()) killTree(child);
  await sleep(2500);
  // Windows keeps a file open for a moment after the process is gone: retry
  if (temp) { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch (error) { console.error(`[shots] could not remove ${temp}: ${error.message}`); } }
});
