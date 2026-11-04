#!/usr/bin/env node
// End-to-end smoke test for the offline edition's backend (npm run smoke:offline).
//
// Starts a throwaway mongod from vendor/mongodb on port 27099 with a fresh dbpath under the
// OS temp folder, starts nota-backend in LAN mode against it on port 5099, runs the core
// shop scenarios (sales, edits, returns, credit sales, payments, exports) over HTTP, then stops
// everything and deletes the temp folder. It never touches the real database or port 27017.
//
// Development tool only: stage.js does not copy scripts/ into the installer.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Routes that earlier cleanup stages removed. Each must answer 404 (with a valid LAN key).
// Add to this list in every stage.
const REMOVED_ROUTES = [
  // Stage 1: push notifications (was notification.routes.js: router.post("/devices"), mounted at /api/notifications).
  { method: 'POST', path: '/api/notifications/devices', body: { token: 'smoke-device-token' } },
  // Stage 2: website code. One representative path per removed route file.
  { method: 'POST', path: '/api/cart/checkout', body: {} }, // cart.routes.js
  { method: 'GET', path: '/api/website-orders/pending' }, // websiteOrder.routes.js
  { method: 'GET', path: '/api/website-images/active' }, // websiteImage.routes.js
  { method: 'GET', path: '/api/header' }, // publicPage.routes.js (was mounted at /api)
  { method: 'GET', path: '/api/public/seo/sitemap/pages' }, // publicSeo.routes.js
  { method: 'GET', path: '/api/seo/slug-availability?entityType=product&language=ar&slug=smoke' }, // seo.routes.js
  // Stage 3: website settings (was ecommerceSetting.routes.js, mounted at /api/ecommerce-settings).
  { method: 'GET', path: '/api/ecommerce-settings' },
];

const ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.resolve(process.env.NOTA_BACKEND_DIR || path.join(ROOT, '..', 'nota-backend'));
// NOTA_MONGOD_PATH (development only): use another mongod binary, e.g. a Linux build on a dev machine,
// instead of the bundled Windows one in vendor/mongodb.
const MONGOD_OVERRIDE = process.env.NOTA_MONGOD_PATH ? path.resolve(process.env.NOTA_MONGOD_PATH) : null;
const MONGOD_PATH = MONGOD_OVERRIDE || path.join(ROOT, 'vendor', 'mongodb', 'bin', process.platform === 'win32' ? 'mongod.exe' : 'mongod');

const MONGO_PORT = 27099;
const BACKEND_PORT = 5099;
const DB_NAME = 'dafer_smoke';
const MONGO_URI = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}`;
const LAN_SECRET = 'smoke-secret-123';
const LAN_KEY_HEADER = 'x-nota-lan-key';
const BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const STARTUP_TIMEOUT_MS = 60000;
const REQUEST_TIMEOUT_MS = 30000;

if (MONGO_PORT === 27017 || !MONGO_URI.includes(`:${MONGO_PORT}/`)) {
  console.error('[smoke] refusing to run: the smoke test must never use port 27017');
  process.exit(1);
}

const results = [];
const children = [];
let tempDir = null;
let cleanedUp = false;

const log = (message) => console.log(`[smoke] ${message}`);

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Local calendar date as yyyy-MM-dd, the format the sales screens send. Not toISOString(): that is
// the UTC date, which is still yesterday just after local midnight in a zone ahead of UTC.
function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

async function waitFor(label, check, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`${label} exited early with code ${child.exitCode}`);
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`${label} did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

function tail(file, lines = 30) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function ensureMongod() {
  if (fs.existsSync(MONGOD_PATH)) return;
  if (MONGOD_OVERRIDE) throw new Error(`NOTA_MONGOD_PATH does not exist: ${MONGOD_OVERRIDE}`);
  log('vendor/mongodb is missing; running npm run offline:vendor');
  const result = spawnSync('npm', ['run', 'offline:vendor'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0 || !fs.existsSync(MONGOD_PATH)) {
    throw new Error(`npm run offline:vendor failed; ${path.relative(ROOT, MONGOD_PATH)} still missing`);
  }
}

function startChild(command, args, options, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  children.push(child);
  return child;
}

async function startMongod() {
  const dbPath = path.join(tempDir, 'db');
  fs.mkdirSync(dbPath, { recursive: true });
  const logFile = path.join(tempDir, 'mongod.log');
  const child = startChild(
    MONGOD_PATH,
    ['--dbpath', dbPath, '--port', String(MONGO_PORT), '--bind_ip', '127.0.0.1', '--logpath', logFile, '--wiredTigerCacheSizeGB', '0.25'],
    {},
    path.join(tempDir, 'mongod.stdout.log')
  );
  try {
    await waitFor('mongod', () => isPortOpen(MONGO_PORT), child);
  } catch (error) {
    throw new Error(`${error.message}\n--- mongod log ---\n${tail(logFile)}`);
  }
  log(`mongod ready on 127.0.0.1:${MONGO_PORT} (dbpath ${dbPath})`);
}

async function startBackend() {
  const logFile = path.join(tempDir, 'backend.log');
  const child = startChild(
    process.execPath,
    ['src/server.js'],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PORT: String(BACKEND_PORT),
        MONGO_URI,
        NOTA_LAN_MODE: '1',
        NOTA_LAN_SECRET: LAN_SECRET,
        // Keep the test server off the shop network.
        NOTA_LISTEN_HOST: '127.0.0.1',
      },
    },
    logFile
  );
  const responds = async () => {
    try {
      const response = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  };
  try {
    await waitFor('backend', responds, child);
  } catch (error) {
    throw new Error(`${error.message}\n--- backend log ---\n${tail(logFile)}`);
  }
  log(`backend ready on ${BASE_URL} (LAN mode, ${MONGO_URI})`);
}

async function request(method, urlPath, { body, withKey = true, binary = false } = {}) {
  const headers = {};
  if (withKey) headers[LAN_KEY_HEADER] = LAN_SECRET;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (binary) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, buffer };
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, json, text };
}

const describe = (response) => {
  const message = response.json && (response.json.message || response.json.code);
  return `HTTP ${response.status}${message ? ` "${message}"` : ''}`;
};

// Runs one scenario step. A step throws (or calls fail) to report ✗; otherwise it returns a detail string.
async function step(name, fn) {
  try {
    const detail = await fn();
    record(true, name, detail);
    return true;
  } catch (error) {
    record(false, name, error.message);
    return false;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectStatus(response, expected, what) {
  const list = Array.isArray(expected) ? expected : [expected];
  expect(list.includes(response.status), `${what}: expected HTTP ${list.join(' or ')}, got ${describe(response)}`);
}

function requireCtx(ctx, ...keys) {
  const missing = keys.filter((key) => !ctx[key]);
  if (missing.length) throw new Error(`skipped: earlier step did not produce ${missing.join(', ')}`);
}

async function getStock(productId) {
  const response = await request('GET', `/api/products/${productId}`);
  expectStatus(response, 200, 'GET product');
  return Number(response.json.inventoryCount);
}

async function expectStock(ctx, expected) {
  const actual = await getStock(ctx.productId);
  expect(actual === expected, `stock expected ${expected}, got ${actual}`);
  return `stock ${actual}`;
}

async function runScenarios() {
  const ctx = {};
  const today = localDay(); // sellingDate of every sale below

  await step('Request without LAN key is rejected', async () => {
    const response = await request('GET', '/api/products', { withKey: false });
    expectStatus(response, [401, 403], 'GET /api/products without key');
    return describe(response);
  });

  await step('Create category', async () => {
    const response = await request('POST', '/api/categories', { body: { name: 'Smoke Category' } });
    expectStatus(response, 201, 'POST /api/categories');
    ctx.categoryId = response.json && response.json._id;
    expect(ctx.categoryId, 'response has no _id');
    return `id ${ctx.categoryId}`;
  });

  await step('Create product (stock 10, purchase 50, selling 100)', async () => {
    requireCtx(ctx, 'categoryId');
    const response = await request('POST', '/api/products', {
      body: {
        name: 'Smoke Product',
        code: 'SMOKE-001',
        categoryId: ctx.categoryId,
        inventoryCount: 10,
        purchasePrice: 50,
        wholesalePrice: 100,
        retailPrice: 100,
      },
    });
    expectStatus(response, 201, 'POST /api/products');
    ctx.productId = response.json && response.json._id;
    expect(ctx.productId, 'response has no _id');
    return `id ${ctx.productId}, ${await expectStock(ctx, 10)}`;
  });

  await step('Cash sale, quantity 2 → stock 8', async () => {
    requireCtx(ctx, 'productId');
    const response = await request('POST', '/api/sellings', {
      body: {
        customerName: 'Smoke Cash Customer',
        customerPhone: '01000000001',
        sellingDate: today,
        items: [{ productId: ctx.productId, quantity: 2, price: 100 }],
      },
    });
    expectStatus(response, 201, 'POST /api/sellings');
    ctx.cashInvoiceId = response.json && response.json._id;
    expect(ctx.cashInvoiceId, 'response has no _id');
    expect(Number(response.json.totalPrice) === 200, `totalPrice expected 200, got ${response.json.totalPrice}`);
    return `invoice ${ctx.cashInvoiceId}, ${await expectStock(ctx, 8)}`;
  });

  await step('Sale below purchase price is rejected', async () => {
    requireCtx(ctx, 'productId');
    const response = await request('POST', '/api/sellings', {
      body: {
        customerName: 'Smoke Cash Customer',
        customerPhone: '01000000001',
        sellingDate: today,
        items: [{ productId: ctx.productId, quantity: 1, price: 40 }],
      },
    });
    expectStatus(response, 400, 'POST /api/sellings at price 40');
    return `${describe(response)}, ${await expectStock(ctx, 8)}`;
  });

  await step('Edit cash invoice to quantity 3 → stock 7', async () => {
    requireCtx(ctx, 'cashInvoiceId');
    const response = await request('PUT', `/api/sellings/${ctx.cashInvoiceId}`, {
      body: { items: [{ productId: ctx.productId, quantity: 3, price: 100 }] },
    });
    expectStatus(response, 200, 'PUT /api/sellings/:id');
    expect(Number(response.json.totalQuantity) === 3, `totalQuantity expected 3, got ${response.json.totalQuantity}`);
    return await expectStock(ctx, 7);
  });

  await step('Cash return, quantity 1 → stock 8, listed in /api/returns', async () => {
    requireCtx(ctx, 'cashInvoiceId');
    const response = await request('POST', '/api/returns', {
      body: {
        returnType: 'cash',
        invoiceId: ctx.cashInvoiceId,
        items: [{ productId: ctx.productId, quantity: 1, returnReason: 'smoke test' }],
      },
    });
    expectStatus(response, 201, 'POST /api/returns (cash)');
    const stock = await expectStock(ctx, 8);
    const list = await request('GET', `/api/returns?returnType=cash&invoiceId=${ctx.cashInvoiceId}`);
    expectStatus(list, 200, 'GET /api/returns');
    const logs = (list.json && list.json.data) || [];
    const found = logs.find((entry) => (entry.items || []).some((item) => String(item.productId) === ctx.productId && Number(item.quantity) === 1));
    expect(found, `return not found in /api/returns (got ${logs.length} entries)`);
    return `${stock}, return log ${found._id}`;
  });

  await step('Credit sale to a new customer, quantity 2 → stock 6, customer created', async () => {
    requireCtx(ctx, 'productId');
    const phone = '01000000002';
    const before = await request('GET', `/api/customers?phone=${phone}`);
    expectStatus(before, 200, 'GET /api/customers?phone');
    expect(!before.text.includes(phone), 'customer already existed before the credit sale');
    const response = await request('POST', '/api/credit-sales', {
      body: {
        customerName: 'Smoke Credit Customer',
        customerPhone: phone,
        sellingDate: today,
        items: [{ productId: ctx.productId, quantity: 2, price: 100 }],
      },
    });
    expectStatus(response, 201, 'POST /api/credit-sales');
    ctx.creditInvoiceId = response.json && response.json._id;
    ctx.customerId = response.json && response.json.customerId && String(response.json.customerId);
    expect(ctx.creditInvoiceId, 'response has no _id');
    expect(ctx.customerId, 'response has no customerId');
    expect(Number(response.json.remainingAmount) === 200, `remainingAmount expected 200, got ${response.json.remainingAmount}`);
    const stock = await expectStock(ctx, 6);
    const customer = await request('GET', `/api/customers/${ctx.customerId}`);
    expectStatus(customer, 200, 'GET /api/customers/:id');
    expect(customer.text.includes(phone), 'created customer does not have the expected phone');
    return `invoice ${ctx.creditInvoiceId}, customer ${ctx.customerId}, ${stock}`;
  });

  await step('Payment on credit sale (50) → remainingAmount 150', async () => {
    requireCtx(ctx, 'creditInvoiceId');
    const response = await request('POST', `/api/credit-sales/${ctx.creditInvoiceId}/payments`, {
      body: { amount: 50, note: 'smoke payment' },
    });
    expectStatus(response, 201, 'POST /api/credit-sales/:id/payments');
    expect(Number(response.json.paidAmount) === 50, `paidAmount expected 50, got ${response.json.paidAmount}`);
    expect(Number(response.json.remainingAmount) === 150, `remainingAmount expected 150, got ${response.json.remainingAmount}`);
    return `paid 50, remaining ${response.json.remainingAmount}, status ${response.json.status}`;
  });

  await step('Payment via /api/customers/:id/payments (30) → remainingAmount 120', async () => {
    requireCtx(ctx, 'customerId', 'creditInvoiceId');
    const response = await request('POST', `/api/customers/${ctx.customerId}/payments`, {
      body: { amount: 30, lastInvoice: true, note: 'smoke customer payment' },
    });
    expectStatus(response, 201, 'POST /api/customers/:id/payments');
    const invoice = await request('GET', `/api/credit-sales/${ctx.creditInvoiceId}`);
    expectStatus(invoice, 200, 'GET /api/credit-sales/:id');
    expect(Number(invoice.json.paidAmount) === 80, `paidAmount expected 80, got ${invoice.json.paidAmount}`);
    expect(Number(invoice.json.remainingAmount) === 120, `remainingAmount expected 120, got ${invoice.json.remainingAmount}`);
    return `paid 80, remaining ${invoice.json.remainingAmount}`;
  });

  await step('Credit return, quantity 1 → stock 7', async () => {
    requireCtx(ctx, 'creditInvoiceId');
    const response = await request('POST', '/api/returns', {
      body: {
        returnType: 'credit',
        invoiceId: ctx.creditInvoiceId,
        items: [{ productId: ctx.productId, quantity: 1, returnReason: 'smoke test' }],
      },
    });
    expectStatus(response, 201, 'POST /api/returns (credit)');
    return `${await expectStock(ctx, 7)}, invoice total ${response.json.totalPrice}, remaining ${response.json.remainingAmount}`;
  });

  // Stage 12: dashboard summary, low-stock threshold, category product counts, all-products list.
  // Runs before the deletes below, while the cash and credit invoices of this run still exist.
  await step('Dashboard summary: today\'s cash and credit sales, credit outstanding', async () => {
    requireCtx(ctx, 'cashInvoiceId', 'creditInvoiceId');
    const cashInvoice = await request('GET', `/api/sellings/${ctx.cashInvoiceId}`);
    const creditInvoice = await request('GET', `/api/credit-sales/${ctx.creditInvoiceId}`);
    expectStatus(cashInvoice, 200, 'GET /api/sellings/:id');
    expectStatus(creditInvoice, 200, 'GET /api/credit-sales/:id');
    const response = await request('GET', '/api/dashboard/summary');
    expectStatus(response, 200, 'GET /api/dashboard/summary');
    const summary = response.json;
    const cashTotal = Number(cashInvoice.json.totalPrice);
    const creditTotal = Number(creditInvoice.json.totalPrice);
    const remaining = Number(creditInvoice.json.remainingAmount);
    expect(summary.today.cash.count === 1 && summary.today.cash.total === cashTotal,
      `today cash expected 1 × ${cashTotal}, got ${summary.today.cash.count} × ${summary.today.cash.total}`);
    expect(summary.today.credit.count === 1 && summary.today.credit.total === creditTotal,
      `today credit expected 1 × ${creditTotal}, got ${summary.today.credit.count} × ${summary.today.credit.total}`);
    expect(summary.credit.outstanding === remaining, `outstanding expected ${remaining}, got ${summary.credit.outstanding}`);
    expect(summary.credit.customersWithBalance === (remaining > 0 ? 1 : 0), `customersWithBalance got ${summary.credit.customersWithBalance}`);
    expect(summary.last7Days.length === 7 && summary.last7Days[6].cash === cashTotal, 'last 7 days do not end with today\'s cash total');
    expect(summary.recentInvoices.length === 2, `recentInvoices expected 2, got ${summary.recentInvoices.length}`);
    expect(!summary.lowStock.some((row) => row.id === ctx.productId), 'stock 7 is above the default threshold 5 but is listed as low');
    return `date ${summary.date} (${summary.timeZone}), cash ${cashTotal}, credit ${creditTotal}, outstanding ${remaining}`;
  });

  await step('Product with lowStockThreshold 20 (stock 15) appears in dashboard low stock', async () => {
    requireCtx(ctx, 'categoryId');
    const created = await request('POST', '/api/products', {
      body: { name: 'Smoke Low Stock', code: 'SMOKE-LOW', categoryId: ctx.categoryId, inventoryCount: 15,
        purchasePrice: 10, wholesalePrice: 20, retailPrice: 20, lowStockThreshold: 20 },
    });
    expectStatus(created, 201, 'POST /api/products with lowStockThreshold');
    expect(created.json.lowStockThreshold === 20, `lowStockThreshold expected 20, got ${created.json.lowStockThreshold}`);
    ctx.lowStockProductId = created.json._id;
    const response = await request('GET', '/api/dashboard/summary');
    const row = (response.json.lowStock || []).find((entry) => entry.id === ctx.lowStockProductId);
    expect(row && row.threshold === 20 && row.inventoryCount === 15, `not in lowStock as expected (${JSON.stringify(response.json.lowStock)})`);
    return `low stock: ${response.json.lowStock.map((entry) => `${entry.code} ${entry.inventoryCount}/${entry.threshold}`).join(', ')}`;
  });

  await step('GET /api/categories → productCount 2 for the smoke category', async () => {
    requireCtx(ctx, 'categoryId', 'lowStockProductId');
    const response = await request('GET', '/api/categories');
    expectStatus(response, 200, 'GET /api/categories');
    const category = (response.json || []).find((entry) => entry._id === ctx.categoryId);
    expect(category && category.productCount === 2, `productCount expected 2, got ${category && category.productCount}`);
    expect(category.name === 'Smoke Category', 'category fields changed');
    return `productCount ${category.productCount}`;
  });

  await step('GET /api/products without categoryId → all products, paginated', async () => {
    requireCtx(ctx, 'productId', 'lowStockProductId');
    const response = await request('GET', '/api/products?page=1&limit=10');
    expectStatus(response, 200, 'GET /api/products');
    const ids = (response.json.data || []).map((entry) => entry._id);
    expect(response.json.pagination && response.json.pagination.totalItems === 2, `totalItems expected 2, got ${JSON.stringify(response.json.pagination)}`);
    expect(ids.includes(ctx.productId) && ids.includes(ctx.lowStockProductId), 'not every product is listed');
    return `totalItems ${response.json.pagination.totalItems}`;
  });

  await step('Delete cash invoice → stock unchanged (7)', async () => {
    requireCtx(ctx, 'cashInvoiceId');
    // Intended behavior: delete removes only the invoice record and does not restore stock.
    // The UI warns about this before deleting (i18n invoiceHistoryPage.messages.deleteInventoryWarning:
    // "use Return Items to restore inventory"). See docs/OFFLINE_PLAN.md, Accounting.
    const response = await request('DELETE', `/api/sellings/${ctx.cashInvoiceId}`);
    expectStatus(response, 200, 'DELETE /api/sellings/:id');
    const gone = await request('GET', `/api/sellings/${ctx.cashInvoiceId}`);
    expect(gone.status === 404, `invoice still readable after delete (${describe(gone)})`);
    return await expectStock(ctx, 7);
  });

  await step('Delete credit invoice → stock unchanged (7)', async () => {
    requireCtx(ctx, 'creditInvoiceId');
    // Intended behavior, same as the cash delete: delete removes only the invoice record and does not
    // restore stock. The UI warns users to process returns first. See docs/OFFLINE_PLAN.md, Accounting.
    const response = await request('DELETE', `/api/credit-sales/${ctx.creditInvoiceId}`);
    expectStatus(response, 200, 'DELETE /api/credit-sales/:id');
    const gone = await request('GET', `/api/credit-sales/${ctx.creditInvoiceId}`);
    expect(gone.status === 404, `invoice still readable after delete (${describe(gone)})`);
    return await expectStock(ctx, 7);
  });

  // GET /api/products with a categoryId (the per-category list; without one, see the Stage 12 step above).
  const productsList = `/api/products?categoryId=${ctx.categoryId || 'missing-category'}`;
  for (const urlPath of ['/api/sellings', '/api/credit-sales', '/api/customers', productsList, '/api/products/profit-report', '/api/dashboard/summary']) {
    await step(`GET ${urlPath.split('?')[0]} → 200`, async () => {
      const response = await request('GET', urlPath);
      expectStatus(response, 200, `GET ${urlPath}`);
      return describe(response);
    });
  }

  await step('Products Excel export → 200, non-empty file', async () => {
    const response = await request('GET', '/api/products/export/excel', { binary: true });
    expectStatus(response, 200, 'GET /api/products/export/excel');
    expect(response.buffer.length > 0, 'export file is empty');
    return `${response.buffer.length} bytes, ${response.headers.get('content-type')}`;
  });

  const shopProfile = {
    name: 'Smoke Shop',
    address: '10 Smoke Street',
    phones: ['01000000010', '01000000011'],
    taxNumber: 'TAX-123',
    invoiceFooter: 'Thank you for shopping with us',
  };
  const expectShopProfile = (profile, expected, what) => {
    expect(profile, `${what}: response has no body`);
    for (const [key, value] of Object.entries(expected)) {
      expect(JSON.stringify(profile[key]) === JSON.stringify(value), `${what}: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(profile[key])}`);
    }
  };

  await step('Shop profile before saving → 200, empty name', async () => {
    const response = await request('GET', '/api/shop-profile');
    expectStatus(response, 200, 'GET /api/shop-profile');
    expectShopProfile(response.json, { name: '', phones: [], logo: null }, 'GET /api/shop-profile');
    return describe(response);
  });

  await step('Save shop profile (name, address, phones, tax number, footer) → 200', async () => {
    const response = await request('PUT', '/api/shop-profile', { body: shopProfile });
    expectStatus(response, 200, 'PUT /api/shop-profile');
    expectShopProfile(response.json, shopProfile, 'PUT /api/shop-profile');
    return describe(response);
  });

  await step('Shop profile returns the saved values', async () => {
    const response = await request('GET', '/api/shop-profile');
    expectStatus(response, 200, 'GET /api/shop-profile');
    expectShopProfile(response.json, shopProfile, 'GET /api/shop-profile');
    return `name "${response.json.name}", ${response.json.phones.length} phones`;
  });

  await step('Save shop profile without name → 400', async () => {
    const response = await request('PUT', '/api/shop-profile', { body: { address: 'No name street' } });
    expectStatus(response, 400, 'PUT /api/shop-profile without name');
    return describe(response);
  });

  await step('Save shop profile with an invalid logo → 400, saved values unchanged', async () => {
    const response = await request('PUT', '/api/shop-profile', { body: { ...shopProfile, logo: 'not-an-image' } });
    expectStatus(response, 400, 'PUT /api/shop-profile with invalid logo');
    const after = await request('GET', '/api/shop-profile');
    expectStatus(after, 200, 'GET /api/shop-profile');
    expectShopProfile(after.json, { ...shopProfile, logo: null }, 'GET /api/shop-profile after rejected saves');
    return describe(response);
  });

  for (const route of REMOVED_ROUTES) {
    await step(`Removed route ${route.method} ${route.path} → 404`, async () => {
      const response = await request(route.method, route.path, { body: route.body });
      expectStatus(response, 404, `${route.method} ${route.path}`);
      return describe(response);
    });
  }
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  // Backend first, then mongod.
  for (const child of [...children].reverse()) await stopChild(child);
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      log(`stopped backend and mongod, removed ${tempDir}`);
    } catch (error) {
      log(`stopped backend and mongod, but could not remove ${tempDir}: ${error.message}`);
    }
  }
}

function summarize() {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log('');
  console.log(`[smoke] summary: ${passed} ✓ / ${failed} ✗`);
  for (const result of results.filter((entry) => !entry.ok)) console.log(`  ✗ ${result.name} — ${result.detail}`);
  return failed;
}

async function main() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await cleanup();
      process.exit(1);
    });
  }

  try {
    for (const [label, port] of [['mongod', MONGO_PORT], ['backend', BACKEND_PORT]]) {
      if (await isPortOpen(port)) throw new Error(`port ${port} (${label}) is already in use; stop whatever is listening there and retry`);
    }
    if (!fs.existsSync(path.join(BACKEND_DIR, 'src', 'server.js'))) {
      throw new Error(`backend not found at ${BACKEND_DIR}; set NOTA_BACKEND_DIR`);
    }
    ensureMongod();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-smoke-'));
    await startMongod();
    await startBackend();
    await runScenarios();
  } catch (error) {
    record(false, 'Smoke test setup', error.message);
  } finally {
    await cleanup();
  }

  process.exit(summarize() > 0 ? 1 : 0);
}

main();
