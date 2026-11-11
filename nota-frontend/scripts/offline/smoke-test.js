#!/usr/bin/env node
// End-to-end smoke test for the offline edition's backend (npm run smoke:offline).
//
// Starts a throwaway mongod from vendor/mongodb on port 27099 with a fresh dbpath under the
// OS temp folder, starts nota-backend in LAN mode against it on port 5099, runs the core
// shop scenarios (sales, edits, returns, credit sales, payments, exports) over HTTP, then stops
// everything and deletes the temp folder. It never touches the real database or port 27017.
// Stage 13: the backend runs with NOTA_AUTH=1 (the owner is set up first and their token is sent
// on every scenario), then once more with NOTA_AUTH unset on a fresh database to prove the switch.
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
const REPLICA_SET = 'rs0';
const MONGO_URI = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}?replicaSet=${REPLICA_SET}&directConnection=true`;
// Stage 13: the main run is with NOTA_AUTH=1; a short second run (fresh database on the same
// mongod) proves that with NOTA_AUTH unset the backend behaves as before.
const NOAUTH_DB_NAME = 'dafer_smoke_noauth';
// Stage 18: a third, fresh database (auth on) for the opening-balance scenarios, which need a shop with no sale yet.
const OPENING_DB_NAME = 'dafer_smoke_opening';
// Stage 19: a fourth fresh database (auth on) for cash boxes, shifts, expenses, drawings and customer credit.
const STAGE19_DB_NAME = 'dafer_smoke_stage19';
// Stage 20: a fifth fresh database (auth on) for purchases, supplier payments, returns and the supplier statement.
const STAGE20_DB_NAME = 'dafer_smoke_stage20';
// Stage 21: a sixth fresh database (auth on) for VAT: settings, sales, returns, purchases, expenses and the monthly VAT return.
const STAGE21_DB_NAME = 'dafer_smoke_stage21';
// Stage 22: a seventh fresh database (auth on) for the financial reports, manual entries, accounts and period closing.
const STAGE22_DB_NAME = 'dafer_smoke_stage22';
const JWT_SECRET = 'smoke-jwt-secret-0123456789abcdef-0123456789';
const OWNER = { name: 'Smoke Owner', username: 'smoke-owner', password: 'owner-pass-123' };
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
    ['--dbpath', dbPath, '--port', String(MONGO_PORT), '--bind_ip', '127.0.0.1', '--replSet', REPLICA_SET, '--logpath', logFile, '--wiredTigerCacheSizeGB', '0.25'],
    {},
    path.join(tempDir, 'mongod.stdout.log')
  );
  try {
    await waitFor('mongod', () => isPortOpen(MONGO_PORT), child);
    const { MongoClient } = require(path.join(BACKEND_DIR, 'node_modules', 'mongodb'));
    const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}`, { directConnection: true });
    await client.connect();
    try {
      const admin = client.db('admin');
      const hello = await admin.command({ hello: 1 });
      if (!hello.setName) {
        await admin.command({ replSetInitiate: { _id: REPLICA_SET, members: [{ _id: 0, host: `127.0.0.1:${MONGO_PORT}` }] } });
      }
      await waitFor('mongod PRIMARY', async () => (await admin.command({ hello: 1 })).isWritablePrimary === true, child);
    } finally {
      await client.close();
    }
  } catch (error) {
    throw new Error(`${error.message}\n--- mongod log ---\n${tail(logFile)}`);
  }
  log(`mongod ready on 127.0.0.1:${MONGO_PORT} (dbpath ${dbPath})`);
}

async function startBackend({ auth = true, dbName = DB_NAME } = {}) {
  const logFile = path.join(tempDir, `backend-${auth ? 'auth' : 'noauth'}-${dbName}.log`);
  const mongoUri = `mongodb://127.0.0.1:${MONGO_PORT}/${dbName}?replicaSet=${REPLICA_SET}&directConnection=true`;
  const env = {
    ...process.env,
    PORT: String(BACKEND_PORT),
    MONGO_URI: mongoUri,
    NOTA_LAN_MODE: '1',
    NOTA_LAN_SECRET: LAN_SECRET,
    // Keep the test server off the shop network.
    NOTA_LISTEN_HOST: '127.0.0.1',
  };
  delete env.NOTA_AUTH;
  delete env.NOTA_JWT_SECRET;
  if (auth) Object.assign(env, { NOTA_AUTH: '1', NOTA_JWT_SECRET: JWT_SECRET });
  const child = startChild(process.execPath, ['src/server.js'], { cwd: BACKEND_DIR, env }, logFile);
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
  log(`backend ready on ${BASE_URL} (LAN mode, auth ${auth ? 'on (NOTA_AUTH=1)' : 'off'}, ${mongoUri})`);
  return child;
}

// The session token sent by default (the owner's, once setup-owner ran). null: no token.
let authToken = null;

async function request(method, urlPath, { body, withKey = true, binary = false, token = authToken, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (withKey) headers[LAN_KEY_HEADER] = LAN_SECRET;
  if (token) headers.authorization = `Bearer ${token}`;
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

// Stage 14: the same request, sent from another local source address. 127.0.0.2 is not one of
// the main PC's own addresses the backend accepts (127.0.0.1, ::1, ::ffff:127.0.0.1), so it stands
// in for a client PC without the test server ever leaving this machine.
const NON_LOCAL_SOURCE = '127.0.0.2';
function requestFromAddress(localAddress, method, urlPath, { body } = {}) {
  const http = require('node:http');
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE_URL}${urlPath}`,
      {
        method,
        localAddress,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          [LAN_KEY_HEADER]: LAN_SECRET,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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

// Stage 13, before the existing scenarios: the owner is created and their token is then sent on
// every request.
async function runAuthSetup(ctx) {
  await step('Auth: bootstrap before the owner exists → hasOwner false', async () => {
    const response = await request('GET', '/api/auth/bootstrap', { token: null });
    expectStatus(response, 200, 'GET /api/auth/bootstrap');
    expect(response.json.hasOwner === false, `hasOwner expected false, got ${response.json.hasOwner}`);
    return `hasOwner ${response.json.hasOwner}, shop name "${response.json.shop.name}"`;
  });

  await step('Auth: request without a token → 401 SESSION_EXPIRED', async () => {
    const response = await request('GET', '/api/products', { token: null });
    expectStatus(response, 401, 'GET /api/products without a token');
    expect(response.json.code === 'SESSION_EXPIRED', `code expected SESSION_EXPIRED, got ${response.json.code}`);
    return describe(response);
  });

  await step('Auth: bootstrap from the main PC itself → isLocal true', async () => {
    const response = await request('GET', '/api/auth/bootstrap', { token: null });
    expectStatus(response, 200, 'GET /api/auth/bootstrap');
    expect(response.json.isLocal === true, `isLocal expected true, got ${response.json.isLocal}`);
    return `isLocal ${response.json.isLocal}`;
  });

  await step(`Auth: setup-owner from a non-loopback address (${NON_LOCAL_SOURCE}) → 403 LOCAL_ONLY, isLocal false`, async () => {
    const boot = await requestFromAddress(NON_LOCAL_SOURCE, 'GET', '/api/auth/bootstrap');
    expectStatus(boot, 200, 'GET /api/auth/bootstrap from a client address');
    expect(boot.json.isLocal === false, `isLocal expected false, got ${boot.json.isLocal}`);
    const response = await requestFromAddress(NON_LOCAL_SOURCE, 'POST', '/api/auth/setup-owner', { body: OWNER });
    expectStatus(response, 403, 'POST /api/auth/setup-owner from a client address');
    expect(response.json.code === 'LOCAL_ONLY', `code expected LOCAL_ONLY, got ${response.json.code}`);
    const after = await request('GET', '/api/auth/bootstrap', { token: null });
    expect(after.json.hasOwner === false, 'an owner was created anyway');
    return `${describe(response)}; bootstrap isLocal ${boot.json.isLocal}; still no owner`;
  });

  await step('Auth: setup-owner → 201, token and recovery code', async () => {
    const response = await request('POST', '/api/auth/setup-owner', { body: OWNER, token: null });
    expectStatus(response, 201, 'POST /api/auth/setup-owner');
    expect(response.json.token && response.json.user.role === 'owner', 'no owner token');
    expect(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/.test(response.json.recoveryCode), `bad recovery code ${response.json.recoveryCode}`);
    authToken = response.json.token;
    ctx.ownerId = response.json.user._id;
    ctx.recoveryCode = response.json.recoveryCode;
    return `owner ${ctx.ownerId}, ${response.json.permissions.length} permissions`;
  });

  await step('Auth: bootstrap after setup → hasOwner true', async () => {
    const response = await request('GET', '/api/auth/bootstrap', { token: null });
    expectStatus(response, 200, 'GET /api/auth/bootstrap');
    expect(response.json.hasOwner === true, `hasOwner expected true, got ${response.json.hasOwner}`);
    return `hasOwner ${response.json.hasOwner}`;
  });

  await step('Auth: second setup-owner → 409 OWNER_EXISTS', async () => {
    const response = await request('POST', '/api/auth/setup-owner', { body: { ...OWNER, username: 'second-owner' }, token: null });
    expectStatus(response, 409, 'second POST /api/auth/setup-owner');
    expect(response.json.code === 'OWNER_EXISTS', `code expected OWNER_EXISTS, got ${response.json.code}`);
    return describe(response);
  });

  // Used only by "Sale below purchase price is rejected": the owner may sell below cost.
  await step('Auth: owner creates a clerk (cashier, no sales.priceBelowCost) → 201, login 200', async () => {
    const clerk = { name: 'Smoke Clerk', username: 'smoke-clerk', password: 'clerk-pass-1', role: 'cashier' };
    const created = await request('POST', '/api/users', { body: clerk });
    expectStatus(created, 201, 'POST /api/users');
    const login = await request('POST', '/api/auth/login', { body: { username: clerk.username, password: clerk.password }, token: null });
    expectStatus(login, 200, 'clerk login');
    ctx.clerkToken = login.json.token;
    return `clerk ${created.json.user._id}`;
  });
}

// Stage 13, after the existing scenarios: a cashier's rights, disabling, password change, recovery
// and the audit log.
async function runAuthScenarios(ctx) {
  const cashier = { name: 'Smoke Cashier', username: 'smoke-cashier', password: 'cashier-pass-1', role: 'cashier' };

  await step('Auth: owner creates a cashier → 201', async () => {
    const response = await request('POST', '/api/users', { body: cashier });
    expectStatus(response, 201, 'POST /api/users');
    ctx.cashierId = response.json.user._id;
    return `cashier ${ctx.cashierId}, role ${response.json.user.role}`;
  });

  await step('Auth: cashier login → 200 with the cashier permissions', async () => {
    requireCtx(ctx, 'cashierId');
    const response = await request('POST', '/api/auth/login', { body: { username: cashier.username, password: cashier.password }, token: null });
    expectStatus(response, 200, 'POST /api/auth/login');
    expect(!response.json.permissions.includes('products.viewCost'), 'the cashier must not have products.viewCost');
    ctx.cashierToken = response.json.token;
    return `${response.json.permissions.length} permissions`;
  });

  await step('Auth: cashier makes a cash sale → 201, createdBy = cashier', async () => {
    requireCtx(ctx, 'cashierToken', 'productId');
    const response = await request('POST', '/api/sellings', {
      token: ctx.cashierToken,
      body: { customerName: 'Smoke Cashier Customer', customerPhone: '01000000009', sellingDate: localDay(), items: [{ productId: ctx.productId, quantity: 1, price: 100 }] },
    });
    expectStatus(response, 201, 'POST /api/sellings as cashier');
    expect(String(response.json.createdBy) === String(ctx.cashierId), `createdBy expected ${ctx.cashierId}, got ${response.json.createdBy}`);
    expect(response.json.createdByName === cashier.name, `createdByName expected "${cashier.name}", got "${response.json.createdByName}"`);
    expect(!('profitAmount' in response.json.items[0]) && !('totalProfit' in response.json), 'the cashier sees profit in the sale');
    return `invoice ${response.json._id}, createdByName "${response.json.createdByName}"`;
  });

  await step('Auth: cashier deletes a product → 403 FORBIDDEN', async () => {
    requireCtx(ctx, 'cashierToken', 'productId');
    const response = await request('DELETE', `/api/products/${ctx.productId}`, { token: ctx.cashierToken });
    expectStatus(response, 403, 'DELETE /api/products/:id as cashier');
    expect(response.json.code === 'FORBIDDEN', `code expected FORBIDDEN, got ${response.json.code}`);
    return describe(response);
  });

  await step('Auth: cashier opens the profit report → 403 FORBIDDEN', async () => {
    requireCtx(ctx, 'cashierToken');
    const response = await request('GET', '/api/products/profit-report', { token: ctx.cashierToken });
    expectStatus(response, 403, 'GET /api/products/profit-report as cashier');
    return describe(response);
  });

  await step('Auth: cashier gets 403 on every accounting route', async () => {
    requireCtx(ctx, 'cashierToken');
    for (const path of ['/api/accounting/accounts', '/api/accounting/journal', '/api/accounting/health']) {
      const response = await request('GET', path, { token: ctx.cashierToken }); expectStatus(response, 403, `GET ${path} as cashier`);
    }
    return 'accounts, journal and health all forbidden';
  });

  await step('Auth: cashier sees no purchasePrice on products (the owner does)', async () => {
    requireCtx(ctx, 'cashierToken', 'productId');
    const asCashier = await request('GET', `/api/products/${ctx.productId}`, { token: ctx.cashierToken });
    expectStatus(asCashier, 200, 'GET /api/products/:id as cashier');
    expect(!('purchasePrice' in asCashier.json), 'purchasePrice is visible to the cashier');
    const list = await request('GET', '/api/products', { token: ctx.cashierToken });
    expect(!list.text.includes('purchasePrice'), 'purchasePrice in the cashier product list');
    const asOwner = await request('GET', `/api/products/${ctx.productId}`);
    expect(asOwner.json.purchasePrice === 50, `owner purchasePrice expected 50, got ${asOwner.json.purchasePrice}`);
    return `cashier: no purchasePrice; owner: ${asOwner.json.purchasePrice}`;
  });

  await step('Auth: disable the cashier → their token gets 401', async () => {
    requireCtx(ctx, 'cashierId', 'cashierToken');
    const response = await request('PATCH', `/api/users/${ctx.cashierId}/status`, { body: { isActive: false } });
    expectStatus(response, 200, 'PATCH /api/users/:id/status');
    const after = await request('GET', '/api/products', { token: ctx.cashierToken });
    expectStatus(after, 401, 'GET /api/products with the disabled cashier token');
    return describe(after);
  });

  await step('Auth: owner change-password → old token 401, new token works', async () => {
    const oldToken = authToken;
    const response = await request('POST', '/api/auth/change-password', { body: { currentPassword: OWNER.password, newPassword: 'owner-pass-456' } });
    expectStatus(response, 200, 'POST /api/auth/change-password');
    const old = await request('GET', '/api/auth/me', { token: oldToken });
    expectStatus(old, 401, 'GET /api/auth/me with the old token');
    authToken = response.json.token;
    const me = await request('GET', '/api/auth/me');
    expectStatus(me, 200, 'GET /api/auth/me with the new token');
    return 'old token 401, new token 200';
  });

  await step('Auth: recover with the recovery code → new password, new code, old code refused', async () => {
    requireCtx(ctx, 'recoveryCode');
    const response = await request('POST', '/api/auth/recover', {
      body: { username: OWNER.username, recoveryCode: ctx.recoveryCode, newPassword: 'owner-pass-789' },
      token: null,
    });
    expectStatus(response, 200, 'POST /api/auth/recover');
    expect(response.json.recoveryCode && response.json.recoveryCode !== ctx.recoveryCode, 'no new recovery code');
    authToken = response.json.token;
    const again = await request('POST', '/api/auth/recover', {
      body: { username: OWNER.username, recoveryCode: ctx.recoveryCode, newPassword: 'owner-pass-000' },
      token: null,
    });
    expectStatus(again, 401, 'POST /api/auth/recover with the old code');
    const login = await request('POST', '/api/auth/login', { body: { username: OWNER.username, password: 'owner-pass-789' }, token: null });
    expectStatus(login, 200, 'login with the recovered password');
    return 'recovered; old code 401; login 200';
  });

  await step('Auth: audit list contains the expected actions', async () => {
    const response = await request('GET', '/api/audit?limit=100');
    expectStatus(response, 200, 'GET /api/audit');
    const actions = new Set(response.json.data.map((entry) => entry.action));
    const expected = [
      'auth.setup_owner', 'auth.login', 'user.created', 'user.status_changed', 'auth.password_changed',
      'auth.recover', 'auth.recover_failed', 'sale.updated', 'sale.returned', 'sale.cancelled',
      'credit.payment', 'credit.returned', 'credit.cancelled', 'shop.updated',
    ];
    const missing = expected.filter((action) => !actions.has(action));
    expect(missing.length === 0, `missing actions: ${missing.join(', ')}`);
    expect(!response.text.includes(OWNER.password) && !response.text.includes(ctx.recoveryCode), 'a secret is in the audit log');
    return `${response.json.pagination.totalItems} entries, ${actions.size} actions`;
  });
}

// Stage 13: with NOTA_AUTH unset the backend behaves as before (fresh database, no token).
async function runAuthOffCheck() {
  authToken = null;
  await step('Auth off: GET /api/products without a token → 200', async () => {
    const response = await request('GET', '/api/products');
    expectStatus(response, 200, 'GET /api/products');
    return describe(response);
  });

  await step('Auth off: create a category without a token → 201', async () => {
    const response = await request('POST', '/api/categories', { body: { name: 'No Auth Category' } });
    expectStatus(response, 201, 'POST /api/categories');
    expect(!('createdBy' in response.json), 'createdBy is set with auth off');
    return `id ${response.json._id}, no createdBy`;
  });

  await step('Auth off: /api/auth/bootstrap and /api/users are not mounted → 404', async () => {
    const bootstrap = await request('GET', '/api/auth/bootstrap');
    expectStatus(bootstrap, 404, 'GET /api/auth/bootstrap');
    const users = await request('GET', '/api/users');
    expectStatus(users, 404, 'GET /api/users');
    return `${describe(bootstrap)}; ${describe(users)}`;
  });
}

// Stage 18: the opening-balance wizard on a fresh shop (no sale yet), then the rules around it.
async function runOpeningScenarios() {
  const ctx = {};
  const today = localDay();
  authToken = null;
  await step('Opening: setup-owner on a fresh database, then a cashier (no accounting.manage)', async () => {
    const owner = await request('POST', '/api/auth/setup-owner', { body: OWNER, token: null });
    expectStatus(owner, 201, 'POST /api/auth/setup-owner');
    authToken = owner.json.token;
    const clerk = { name: 'Opening Clerk', username: 'opening-clerk', password: 'clerk-pass-1', role: 'cashier' };
    expectStatus(await request('POST', '/api/users', { body: clerk }), 201, 'POST /api/users');
    const login = await request('POST', '/api/auth/login', { body: { username: clerk.username, password: clerk.password }, token: null });
    expectStatus(login, 200, 'clerk login');
    ctx.clerkToken = login.json.token;
    return 'owner and cashier ready';
  });

  await step('Opening: a fresh shop starts in setup mode (status setup, setup mode on)', async () => {
    const response = await request('GET', '/api/accounting/opening');
    expectStatus(response, 200, 'GET /api/accounting/opening');
    expect(response.json.status === 'setup' && response.json.setupMode === true, `expected setup/true, got ${response.json.status}/${response.json.setupMode}`);
    return `status ${response.json.status}, setupMode ${response.json.setupMode}`;
  });

  await step('Opening: a cashier gets 403 on the wizard (read, save and finalize)', async () => {
    const statuses = [];
    for (const [method, route, body] of [['GET', '/api/accounting/opening'], ['POST', '/api/accounting/opening', { cash: 1 }], ['POST', '/api/accounting/opening/finalize', { confirm: true }]]) {
      const response = await request(method, route, { body, token: ctx.clerkToken });
      expectStatus(response, 403, `cashier ${method} ${route}`);
      statuses.push(response.status);
    }
    return `statuses ${statuses.join(', ')}`;
  });

  await step('Opening: owner adds a product with stock in setup mode → opening_inventory posts to capital', async () => {
    const category = await request('POST', '/api/categories', { body: { name: 'Opening Category' } });
    expectStatus(category, 201, 'POST /api/categories');
    ctx.categoryId = category.json._id;
    const product = await request('POST', '/api/products', { body: { name: 'Opening Product', code: 'OPEN-1', categoryId: ctx.categoryId, inventoryCount: 10, purchasePrice: 20, wholesalePrice: 30, retailPrice: 40 } });
    expectStatus(product, 201, 'POST /api/products');
    ctx.productId = product.json._id;
    const journal = await request('GET', `/api/accounting/journal?sourceType=opening_inventory&sourceId=${ctx.productId}`);
    expectStatus(journal, 200, 'GET journal by source');
    const entry = journal.json.data[0];
    expect(entry, 'no opening_inventory entry');
    const byCode = new Map(entry.lines.map((line) => [line.accountCode, line]));
    expect(byCode.get('114')?.debit === 200 && byCode.get('31')?.credit === 200, 'expected Dr inventory 200 / Cr capital 200');
    return 'Dr 114 200 / Cr 31 200';
  });

  await step('Opening: the first sale ends setup mode (written to meta), before the wizard has ever been saved', async () => {
    const sale = await request('POST', '/api/sellings', { body: { customerName: 'First Walk-in', customerPhone: '01099990004', sellingDate: today, items: [{ productId: ctx.productId, quantity: 1, price: 40 }] } });
    expectStatus(sale, 201, 'POST /api/sellings (first sale)');
    const state = await request('GET', '/api/accounting/opening');
    expectStatus(state, 200, 'GET /api/accounting/opening');
    expect(state.json.setupMode === false, 'the first sale should have ended setup mode');
    expect(state.json.figures.inventory.mode === 'carried' && state.json.figures.inventory.amount === 200, `read-only inventory expected 200 (the folded opening stock), got ${state.json.figures.inventory.amount}`);
    return 'setupMode false; the read-only inventory shows the folded opening stock 200';
  });

  await step('Opening: wizard save after a sale — cash 1,000, bank 2,000, customer 500, supplier 300 → capital 3,400 (assets 3,700 − liabilities 300; the typed-in stock 200 folded in)', async () => {
    const customer = await request('POST', '/api/customers', { body: { name: 'Opening Customer', phone: '01099990001' } });
    expectStatus(customer, 201, 'POST /api/customers');
    ctx.customerId = customer.json._id;
    const supplier = await request('POST', '/api/suppliers', { body: { name: 'Opening Supplier', phone: '01099990002', paymentTermsDays: 30 } });
    expectStatus(supplier, 201, 'POST /api/suppliers');
    ctx.supplierId = supplier.json._id;
    const saved = await request('POST', '/api/accounting/opening', { body: {
      cash: 1000, banks: [{ name: 'Smoke Bank', type: 'bank', amount: 2000 }],
      customers: [{ customerId: ctx.customerId, amount: 500 }], suppliers: [{ supplierId: ctx.supplierId, amount: 300 }],
    } });
    expectStatus(saved, 200, 'POST /api/accounting/opening');
    expect(saved.json.totals.capital === 3400, `capital expected 3400 (assets 3700 - liabilities 300), got ${saved.json.totals.capital}`);
    ctx.firstOpening = saved.json.entry.number;
    return `OB ${ctx.firstOpening}, capital ${saved.json.totals.capital}`;
  });

  const healthIsZero = async (label) => {
    const response = await request('GET', '/api/accounting/health');
    expectStatus(response, 200, 'GET /api/accounting/health');
    const details = Object.entries(response.json).map(([name, check]) => `${name}=${check.difference}`);
    for (const [name, check] of Object.entries(response.json)) expect(Number(check.difference) === 0 && check.ok !== false, `${label}: ${name} difference ${check.difference} ok ${check.ok}`);
    return details.join(', ');
  };

  await step('Opening: health is 0 after the wizard save (every check, including suppliers and opening)', () => healthIsZero('after save'));

  await step('Opening: INVENTORY = sum of stock × price after the save (the sale before the wizard did not lose the stock)', async () => {
    const tree = await request('GET', '/api/accounting/accounts');
    expectStatus(tree, 200, 'GET /api/accounting/accounts');
    const flat = []; const walk = (rows) => rows.forEach((row) => { flat.push(row); walk(row.children || []); }); walk(tree.json.accounts);
    const inventory = flat.find((row) => row.systemKey === 'INVENTORY');
    const products = await request('GET', '/api/products?limit=100');
    expectStatus(products, 200, 'GET /api/products');
    const rows = Array.isArray(products.json) ? products.json : products.json.data;
    const worth = rows.reduce((sum, item) => sum + item.inventoryCount * item.purchasePrice, 0);
    expect(inventory.balance === worth && worth === 180, `INVENTORY ${inventory.balance} vs stock × price ${worth} (expected 180)`);
    return `INVENTORY ${inventory.balance} = stock × price ${worth}`;
  });

  await step('Opening: the accounts tree shows capital as a credit balance with side and absBalance', async () => {
    const response = await request('GET', '/api/accounting/accounts');
    expectStatus(response, 200, 'GET /api/accounting/accounts');
    const flat = []; const walk = (rows) => rows.forEach((row) => { flat.push(row); walk(row.children || []); }); walk(response.json.accounts);
    const capital = flat.find((row) => row.systemKey === 'CAPITAL');
    expect(capital.balance === -3400 && capital.side === 'credit' && capital.absBalance === 3400, `capital ${JSON.stringify({ b: capital.balance, s: capital.side, a: capital.absBalance })}`);
    const bank = flat.find((row) => row.code === '11201');
    expect(bank && bank.kind === 'bank' && bank.absBalance === 2000, 'bank account 11201 missing or wrong');
    return 'capital 3,400 credit; bank 11201 2,000 debit';
  });

  await step('Opening: a customer opening is collected by a receipt and the statement shows رصيد أول المدة', async () => {
    const part = await request('POST', `/api/customers/${ctx.customerId}/payments`, { body: { amount: 200, firstInvoice: true } });
    expectStatus(part, 201, 'POST /api/customers/:id/payments');
    expect(part.json.openingCollected === 200, `openingCollected expected 200, got ${part.json.openingCollected}`);
    const statement = await request('GET', `/api/customers/${ctx.customerId}/statement`);
    expectStatus(statement, 200, 'GET statement');
    expect(statement.json.lines[0].description === 'رصيد أول المدة' && statement.json.lines[0].debit === 500, 'the opening line is not first');
    expect(statement.json.totals.balance === 300 && statement.json.outstanding === 300, `balance expected 300, got ${statement.json.totals.balance}`);
    return `balance ${statement.json.totals.balance}, aging total ${statement.json.aging.total}`;
  });

  await step('Opening: a stock edit now posts to the adjustment account, not capital', async () => {
    const edit = await request('PUT', `/api/products/${ctx.productId}`, { body: { inventoryCount: 12 } });
    expectStatus(edit, 200, 'PUT /api/products/:id');
    const adjustment = await request('GET', `/api/accounting/journal?sourceType=inventory_adjustment&sourceId=${ctx.productId}`);
    expect(adjustment.json.data.length === 1, 'no inventory_adjustment entry');
    const opening = await request('GET', `/api/accounting/journal?sourceType=opening_inventory&sourceId=${ctx.productId}`);
    expect(opening.json.data.every((entry) => entry.type !== 'auto' || entry.reversedBy), 'a new opening_inventory entry was posted');
    return 'inventory_adjustment 60 (3 units × 20)';
  });

  await step('Opening: a sale after the opening is not touched by it and health stays 0', async () => {
    const sale = await request('POST', '/api/sellings', { body: { customerName: 'Walk-in', customerPhone: '01099990003', sellingDate: today, items: [{ productId: ctx.productId, quantity: 1, price: 40 }] } });
    expectStatus(sale, 201, 'POST /api/sellings');
    return healthIsZero('after sale');
  });

  await step('Opening: re-save changes cash → the old OB is reversed, a new OB is posted, inventory is carried, health 0', async () => {
    const before = await request('GET', '/api/accounting/opening');
    const saved = await request('POST', '/api/accounting/opening', { body: {
      cash: 1500, banks: [{ accountId: before.json.figures.banks[0].accountId, amount: 2000 }],
      customers: [{ customerId: ctx.customerId, amount: 500 }], suppliers: [{ supplierId: ctx.supplierId, amount: 300 }],
    } });
    expectStatus(saved, 200, 'POST /api/accounting/opening re-save');
    expect(saved.json.entry.number !== ctx.firstOpening, 'the OB number did not change');
    const old = await request('GET', `/api/accounting/journal?number=${ctx.firstOpening}`);
    expect(old.json.data[0].reversedBy, 'the old OB was not reversed');
    expect(saved.json.figures.inventory.mode === 'carried', 'inventory should be carried after the first sale');
    return `new OB ${saved.json.entry.number}; ${await healthIsZero('after re-save')}`;
  });

  await step('Opening: lowering the customer opening below what was collected → 409 OPENING_BELOW_COLLECTED', async () => {
    const response = await request('POST', '/api/accounting/opening', { body: { cash: 1500, customers: [{ customerId: ctx.customerId, amount: 100 }] } });
    expectStatus(response, 409, 'POST /api/accounting/opening below collected');
    expect(response.json.code === 'OPENING_BELOW_COLLECTED' && response.json.collected === 200, `unexpected ${JSON.stringify(response.json)}`);
    return `customer ${response.json.customerName}, collected ${response.json.collected}`;
  });

  await step('Opening: finalize → 200, then a re-save → 409 OPENING_FINALIZED', async () => {
    const finalized = await request('POST', '/api/accounting/opening/finalize', { body: { confirm: true } });
    expectStatus(finalized, 200, 'POST /api/accounting/opening/finalize');
    expect(finalized.json.status === 'finalized', 'status is not finalized');
    const again = await request('POST', '/api/accounting/opening', { body: { cash: 1 } });
    expectStatus(again, 409, 'POST /api/accounting/opening after finalize');
    expect(again.json.code === 'OPENING_FINALIZED', `code expected OPENING_FINALIZED, got ${again.json.code}`);
    return `${describe(again)}`;
  });

  await step('Suppliers: the list shows the ledger balance; deleting a supplier with an opening balance → 409 SUPPLIER_HAS_BALANCE', async () => {
    const list = await request('GET', '/api/suppliers');
    expectStatus(list, 200, 'GET /api/suppliers');
    const row = list.json.find((item) => item._id === ctx.supplierId);
    expect(row && row.balance === 300 && row.openingAmount === 300, `supplier row ${JSON.stringify(row && { b: row.balance, o: row.openingAmount })}`);
    const blocked = await request('DELETE', `/api/suppliers/${ctx.supplierId}`);
    expectStatus(blocked, 409, 'DELETE /api/suppliers/:id');
    expect(blocked.json.code === 'SUPPLIER_HAS_BALANCE', `code ${blocked.json.code}`);
    const clean = await request('POST', '/api/suppliers', { body: { name: 'No balance' } });
    expectStatus(await request('DELETE', `/api/suppliers/${clean.json._id}`), 200, 'DELETE clean supplier');
    return 'balance 300; delete blocked; a clean supplier deletes';
  });

  await step('Suppliers: a cashier cannot list or create suppliers (403)', async () => {
    expectStatus(await request('GET', '/api/suppliers', { token: ctx.clerkToken }), 403, 'cashier GET /api/suppliers');
    expectStatus(await request('POST', '/api/suppliers', { body: { name: 'x' }, token: ctx.clerkToken }), 403, 'cashier POST /api/suppliers');
    return '403, 403';
  });
}

// Stage 19: cash boxes, shifts, transfers, expenses, owner drawings and customer credit, on a fresh database (auth on).
const DEVICE_HEADERS = { 'x-nota-device-id': '0f8fad5b-d9cb-469f-a165-70867728950e', 'x-nota-device-name': encodeURIComponent('Smoke-Cashier-PC') };

async function runStage19Scenarios() {
  const ctx = {};
  authToken = null;
  const asUser = (token) => ({ token });
  const login = async (user) => {
    const response = await request('POST', '/api/auth/login', { body: { username: user.username, password: user.password }, token: null });
    expectStatus(response, 200, `${user.username} login`);
    return response.json.token;
  };

  await step('Stage 19: setup-owner, a cashier and a storekeeper on a fresh database', async () => {
    const owner = await request('POST', '/api/auth/setup-owner', { body: OWNER, token: null });
    expectStatus(owner, 201, 'POST /api/auth/setup-owner');
    authToken = owner.json.token;
    const cashier = { name: 'S19 Cashier', username: 's19-cashier', password: 'clerk-pass-1', role: 'cashier' };
    const keeper = { name: 'S19 Keeper', username: 's19-keeper', password: 'clerk-pass-1', role: 'storekeeper' };
    expectStatus(await request('POST', '/api/users', { body: cashier }), 201, 'POST cashier');
    expectStatus(await request('POST', '/api/users', { body: keeper }), 201, 'POST storekeeper');
    ctx.cashierToken = await login(cashier);
    ctx.keeperToken = await login(keeper);
    return 'owner, cashier, storekeeper';
  });

  await step('Stage 19: opening wizard: cash 20,000, a 5,000 wallet and a customer we owe 300', async () => {
    const category = await request('POST', '/api/categories', { body: { name: 'S19 Category' } });
    expectStatus(category, 201, 'POST /api/categories');
    const product = await request('POST', '/api/products', { body: { name: 'S19 Product', code: 'S19-1', categoryId: category.json._id, inventoryCount: 100, purchasePrice: 20, wholesalePrice: 30, retailPrice: 40 } });
    expectStatus(product, 201, 'POST /api/products');
    ctx.productId = product.json._id;
    const customer = await request('POST', '/api/customers', { body: { name: 'S19 Credit Customer', phone: '01000001919' } });
    expectStatus(customer, 201, 'POST /api/customers');
    ctx.customerId = customer.json._id || customer.json.customer?._id;
    expect(ctx.customerId, 'customer id missing');
    const saved = await request('POST', '/api/accounting/opening', { body: { cash: 20000, banks: [{ name: 'S19 Wallet', type: 'wallet', amount: 5000 }], customers: [{ customerId: ctx.customerId, amount: -300 }] } });
    expectStatus(saved, 200, 'POST /api/accounting/opening');
    return `OB ${saved.json.number}`;
  });

  await step('Stage 19: the boxes exist: the main box (1111) and the wizard wallet (11201) with their balances', async () => {
    const response = await request('GET', '/api/cashbox/boxes');
    expectStatus(response, 200, 'GET /api/cashbox/boxes');
    const main = response.json.data.find((box) => box.isMain);
    const wallet = response.json.data.find((box) => box.type === 'wallet');
    expect(main && main.accountCode === '1111' && main.balance === 20000, `main box ${JSON.stringify(main)}`);
    expect(wallet && wallet.accountCode === '11201' && wallet.balance === 5000, `wallet ${JSON.stringify(wallet)}`);
    ctx.main = main; ctx.wallet = wallet;
    return `main ${main.balance}, wallet ${wallet.balance}, cash total ${response.json.cashTotal}`;
  });

  await step('Stage 19: this PC registers itself (X-Nota-Device-Id / Name) on its first signed-in request', async () => {
    const response = await request('GET', '/api/cashbox/payment-boxes', { token: ctx.cashierToken, headers: DEVICE_HEADERS });
    expectStatus(response, 200, 'cashier GET payment-boxes');
    const devices = await request('GET', '/api/devices');
    expectStatus(devices, 200, 'GET /api/devices');
    const pc = devices.json.data.find((row) => row.deviceId === DEVICE_HEADERS['x-nota-device-id']);
    expect(pc && pc.name === 'Smoke-Cashier-PC' && pc.role === 'client', `device row ${JSON.stringify(pc)}`);
    return `PC "${pc.name}" (${pc.role})`;
  });

  await step('Stage 19: create a cashier drawer bound to this PC, with shifts (code 11102)', async () => {
    const response = await request('POST', '/api/cashbox/boxes', { body: { name: 'S19 Drawer', type: 'cash', deviceId: DEVICE_HEADERS['x-nota-device-id'], shiftsEnabled: true } });
    expectStatus(response, 201, 'POST /api/cashbox/boxes');
    expect(response.json.accountCode === '11102' && response.json.shiftsEnabled === true && response.json.deviceId === DEVICE_HEADERS['x-nota-device-id'], JSON.stringify(response.json));
    ctx.drawer = response.json;
    return `${response.json.name}, account ${response.json.accountCode}`;
  });

  await step('Stage 19: a second box for the same PC → 409 DEVICE_ALREADY_BOUND', async () => {
    const response = await request('POST', '/api/cashbox/boxes', { body: { name: 'S19 Drawer 2', type: 'cash', deviceId: DEVICE_HEADERS['x-nota-device-id'] } });
    expectStatus(response, 409, 'second drawer for the same PC');
    expect(response.json.code === 'DEVICE_ALREADY_BOUND', describe(response));
    return describe(response);
  });

  await step('Stage 19: a cash sale from this PC without a shift → 409 NO_OPEN_SHIFT', async () => {
    requireCtx(ctx, 'drawer', 'productId');
    const response = await request('POST', '/api/sellings', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { customerName: 'Walk-in', customerPhone: '01000001920', sellingDate: localDay(), items: [{ productId: ctx.productId, quantity: 1, price: 500 }] } });
    expectStatus(response, 409, 'sale without a shift');
    expect(response.json.code === 'NO_OPEN_SHIFT', describe(response));
    return describe(response);
  });

  await step('Stage 19: the cashier opens a shift on the drawer (float 0) → SH-000001', async () => {
    requireCtx(ctx, 'drawer');
    const response = await request('POST', '/api/shifts', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { boxId: ctx.drawer._id, openingFloat: 0 } });
    expectStatus(response, 201, 'POST /api/shifts');
    expect(response.json.number === 'SH-000001' && response.json.userName === 'S19 Cashier', JSON.stringify(response.json));
    ctx.shift = response.json;
    return `${response.json.number} by ${response.json.userName}`;
  });

  await step('Stage 19: a cash sale of 500 from this PC goes into the drawer by default', async () => {
    requireCtx(ctx, 'shift');
    const response = await request('POST', '/api/sellings', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { customerName: 'Walk-in', customerPhone: '01000001920', sellingDate: localDay(), items: [{ productId: ctx.productId, quantity: 1, price: 500 }] } });
    expectStatus(response, 201, 'POST /api/sellings');
    expect(String(response.json.boxId) === String(ctx.drawer._id), `sale box ${response.json.boxId}`);
    return `sale ${response.json.invoiceNumber || response.json.number} into the drawer`;
  });

  await step('Stage 19: a credit invoice, then a 100 payment received into the drawer', async () => {
    requireCtx(ctx, 'shift');
    const invoice = await request('POST', '/api/credit-sales', { body: { customerId: ctx.customerId, sellingDate: localDay(), items: [{ productId: ctx.productId, quantity: 1, price: 150 }] } });
    expectStatus(invoice, 201, 'POST /api/credit-sales');
    ctx.creditInvoiceId = invoice.json._id;
    const paid = await request('POST', `/api/credit-sales/${ctx.creditInvoiceId}/payments`, { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { amount: 100 } });
    expectStatus(paid, 201, 'POST payment');
    return `receipt ${paid.json.receiptNumber}`;
  });

  await step('Stage 19: an expense of 50 from the drawer (cashier, expenses.create) → EX-000001', async () => {
    requireCtx(ctx, 'shift');
    const categories = await request('GET', '/api/expenses/categories', { token: ctx.cashierToken });
    expectStatus(categories, 200, 'GET categories');
    const response = await request('POST', '/api/expenses', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { accountId: categories.json.data[0]._id, amount: 50, note: 'smoke expense' } });
    expectStatus(response, 201, 'POST /api/expenses');
    expect(response.json.number === 'EX-000001' && String(response.json.boxId) === String(ctx.drawer._id), JSON.stringify(response.json));
    return `${response.json.number} from the drawer`;
  });

  await step('Stage 19: the shift report from documents: float 0 + sales 500 + receipts 100 − expenses 50 = expected 550', async () => {
    requireCtx(ctx, 'shift');
    const response = await request('GET', `/api/shifts/${ctx.shift._id}`, { token: ctx.cashierToken });
    expectStatus(response, 200, 'GET /api/shifts/:id');
    const lines = Object.fromEntries(response.json.lines.map((row) => [row.key, row.amount]));
    expect(lines.sales === 500 && lines.receipts === 100 && lines.expenses === 50 && response.json.expected === 550, JSON.stringify(response.json));
    return `expected ${response.json.expected}`;
  });

  await step('Stage 19: close without a note while short → 400 NOTE_REQUIRED', async () => {
    requireCtx(ctx, 'shift');
    const response = await request('POST', `/api/shifts/${ctx.shift._id}/close`, { token: ctx.cashierToken, body: { counted: 540 } });
    expectStatus(response, 400, 'close without a note');
    expect(response.json.code === 'NOTE_REQUIRED', describe(response));
    return describe(response);
  });

  await step('Stage 19: close with counted 540 (shortage 10) and a 500 deposit to the main box', async () => {
    requireCtx(ctx, 'shift');
    const response = await request('POST', `/api/shifts/${ctx.shift._id}/close`, { token: ctx.cashierToken, body: { counted: 540, differenceNote: 'smoke shortage', depositBoxId: ctx.main._id, depositAmount: 500 } });
    expectStatus(response, 200, 'POST /api/shifts/:id/close');
    expect(response.json.difference === -10 && response.json.remaining === 40 && response.json.status === 'closed', JSON.stringify(response.json));
    return `expected ${response.json.expected}, counted ${response.json.counted}, difference ${response.json.difference}, stays ${response.json.remaining}`;
  });

  await step('Stage 19: the shortage posted to 530 (Dr cash over/short / Cr drawer) and the balances are 40 and 20,500', async () => {
    requireCtx(ctx, 'shift');
    const journal = await request('GET', `/api/accounting/journal?sourceType=shift&sourceId=${ctx.shift._id}`);
    expectStatus(journal, 200, 'GET journal by shift');
    const entry = journal.json.data[0];
    expect(entry, 'no shift entry');
    const byCode = new Map(entry.lines.map((line) => [line.accountCode, line]));
    expect(byCode.get('530')?.debit === 10 && byCode.get('11102')?.credit === 10, JSON.stringify(entry.lines.map((l) => [l.accountCode, l.debit, l.credit])));
    const boxes = await request('GET', '/api/cashbox/boxes');
    const balance = (id) => boxes.json.data.find((box) => String(box._id) === String(id)).balance;
    expect(balance(ctx.drawer._id) === 40 && balance(ctx.main._id) === 20500, `drawer ${balance(ctx.drawer._id)}, main ${balance(ctx.main._id)}`);
    return 'Dr 530 10 / Cr 11102 10; drawer 40, main 20,500';
  });

  await step('Stage 19: transfer 1,000 from the main box to the wallet → TR-000002 (the deposit was TR-000001)', async () => {
    requireCtx(ctx, 'main', 'wallet');
    const response = await request('POST', '/api/cashbox/transfers', { body: { fromBoxId: ctx.main._id, toBoxId: ctx.wallet._id, amount: 1000, note: 'smoke transfer' } });
    expectStatus(response, 201, 'POST /api/cashbox/transfers');
    expect(response.json.number === 'TR-000002' && response.json.fromAfter === 19500 && response.json.toAfter === 6000, JSON.stringify(response.json));
    return `${response.json.number}: main ${response.json.fromBefore} → ${response.json.fromAfter}, wallet ${response.json.toBefore} → ${response.json.toAfter}`;
  });

  await step('Stage 19: a transfer larger than the balance → 409 INSUFFICIENT_BALANCE', async () => {
    const response = await request('POST', '/api/cashbox/transfers', { body: { fromBoxId: ctx.drawer._id, toBoxId: ctx.main._id, amount: 41 } });
    expectStatus(response, 409, 'overdrawn transfer');
    expect(response.json.code === 'INSUFFICIENT_BALANCE', describe(response));
    return describe(response);
  });

  await step('Stage 19: owner drawing of 200 from the main box → DR-000001; a cashier gets 403', async () => {
    const response = await request('POST', '/api/cashbox/drawings', { body: { boxId: ctx.main._id, amount: 200, note: 'smoke drawing' } });
    expectStatus(response, 201, 'POST /api/cashbox/drawings');
    expect(response.json.number === 'DR-000001', JSON.stringify(response.json));
    expectStatus(await request('POST', '/api/cashbox/drawings', { token: ctx.cashierToken, body: { boxId: ctx.main._id, amount: 1 } }), 403, 'cashier drawing');
    return `${response.json.number}`;
  });

  await step('Stage 19: customer credit 300: a payout of 100 from the main box → CP-000001, statement debit line', async () => {
    requireCtx(ctx, 'customerId');
    const response = await request('POST', `/api/customers/${ctx.customerId}/payouts`, { body: { boxId: ctx.main._id, amount: 100, note: 'smoke payout' } });
    expectStatus(response, 201, 'POST payouts');
    expect(response.json.payout.number === 'CP-000001', JSON.stringify(response.json));
    const statement = await request('GET', `/api/customers/${ctx.customerId}/statement`);
    expectStatus(statement, 200, 'GET statement');
    const line = statement.json.lines.find((row) => row.type === 'payout');
    expect(line && line.debit === 100 && line.description === 'صرف رصيد دائن', JSON.stringify(statement.json.lines));
    return `${response.json.payout.number}, statement balance ${statement.json.totals.balance}`;
  });

  await step('Stage 19: a payout above the credit → 409 EXCEEDS_CREDIT', async () => {
    const response = await request('POST', `/api/customers/${ctx.customerId}/payouts`, { body: { boxId: ctx.main._id, amount: 99999 } });
    expectStatus(response, 409, 'payout above the credit');
    expect(response.json.code === 'EXCEEDS_CREDIT', describe(response));
    return describe(response);
  });

  await step('Stage 19: apply-credit settles the open 50 of the credit invoice (150 − the 100 payment), no entry posted', async () => {
    requireCtx(ctx, 'creditInvoiceId');
    const before = await request('GET', '/api/accounting/journal');
    const response = await request('POST', `/api/customers/${ctx.customerId}/apply-credit`, { body: { amount: 50 } });
    expectStatus(response, 200, 'POST apply-credit');
    const after = await request('GET', '/api/accounting/journal');
    expect(after.json.pagination.totalItems === before.json.pagination.totalItems, 'apply-credit posted a journal entry');
    const invoice = await request('GET', `/api/credit-sales/${ctx.creditInvoiceId}`);
    expect(invoice.json.remainingAmount === 0, `remaining ${invoice.json.remainingAmount}`);
    return `applied ${response.json.applied}, credit left ${response.json.credit.credit}`;
  });

  await step('Stage 19: the expense can be cancelled with a reason (a reversal), and the drawer is restored', async () => {
    const list = await request('GET', '/api/expenses');
    expectStatus(list, 200, 'GET /api/expenses');
    const expense = list.json.data.find((row) => row.number === 'EX-000001');
    const response = await request('POST', `/api/expenses/${expense._id}/cancel`, { body: { reason: 'smoke cancel' } });
    expectStatus(response, 200, 'POST expense cancel');
    const boxes = await request('GET', '/api/cashbox/boxes');
    const drawer = boxes.json.data.find((box) => String(box._id) === String(ctx.drawer._id));
    expect(drawer.balance === 90, `drawer ${drawer.balance}`);
    return `expense ${response.json.status}, drawer ${drawer.balance}`;
  });

  await step('Stage 19 review: a cashier cannot spend from the main box whatever the device header says → 403 BOX_NOT_ALLOWED', async () => {
    const categories = await request('GET', '/api/expenses/categories', { token: ctx.cashierToken });
    const response = await request('POST', '/api/expenses', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { accountId: categories.json.data[0]._id, amount: 1, boxId: ctx.main._id } });
    expectStatus(response, 403, 'cashier expense from the main box');
    expect(response.json.code === 'BOX_NOT_ALLOWED', describe(response));
    return describe(response);
  });

  await step('Stage 19 review: a shift opened on a float that differs from the drawer needs a note, then posts the difference (float 80 against 90)', async () => {
    const refused = await request('POST', '/api/shifts', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { boxId: ctx.drawer._id, openingFloat: 80 } });
    expectStatus(refused, 409, 'float mismatch');
    expect(refused.json.code === 'FLOAT_MISMATCH' && refused.json.balance === 90, JSON.stringify(refused.json));
    const noNote = await request('POST', '/api/shifts', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { boxId: ctx.drawer._id, openingFloat: 80, confirmFloat: true } });
    expectStatus(noNote, 400, 'confirmed without a note');
    expect(noNote.json.code === 'NOTE_REQUIRED', describe(noNote));
    const opened = await request('POST', '/api/shifts', { token: ctx.cashierToken, headers: DEVICE_HEADERS, body: { boxId: ctx.drawer._id, openingFloat: 80, confirmFloat: true, openingNote: 'smoke 10 missing' } });
    expectStatus(opened, 201, 'confirmed with a note');
    expect(opened.json.openingDifference === -10, JSON.stringify(opened.json));
    const journal = await request('GET', `/api/accounting/journal?sourceType=shift_open&sourceId=${opened.json._id}`);
    const entry = journal.json.data[0];
    const byCode = new Map(entry.lines.map((line) => [line.accountCode, line]));
    expect(byCode.get('530')?.debit === 10 && byCode.get('11102')?.credit === 10, 'expected Dr 530 10 / Cr 11102 10');
    const boxes = await request('GET', '/api/cashbox/boxes');
    expect(boxes.json.data.find((box) => String(box._id) === String(ctx.drawer._id)).balance === 80, 'the drawer balance is the float');
    return `${opened.json.number}: Dr 530 10 / Cr 11102 10, drawer 80`;
  });

  const health = await request('GET', '/api/accounting/health');
  await step('Stage 19: GET /api/accounting/health answers with every check including boxes and shifts', async () => {
    expectStatus(health, 200, 'GET /api/accounting/health');
    expect(health.json.boxes && Array.isArray(health.json.boxes.byBox), 'no boxes check');
    expect(health.json.shifts && Array.isArray(health.json.shifts.byShift), 'no shifts check');
    return `${Object.keys(health.json).join(', ')}`;
  });
  for (const [name, check] of Object.entries(health.json || {})) {
    await step(`Stage 19: health ${name}: difference 0`, async () => {
      expect(Number(check.difference) === 0 && check.ok !== false, JSON.stringify(check));
      return name === 'shifts' ? check.byShift.map((row) => `${row.number} ${row.phase} ${row.actual}=${row.expected}`).join(' | ') : name === 'boxes' ? check.byBox.map((row) => `${row.name} ${row.actual}=${row.expected}`).join(' | ') : `expected ${check.expected ?? '-'}, actual ${check.actual ?? '-'}`;
    });
  }

  await step('Stage 19: a cashier cannot see the cash management: boxes, transfers, devices → 403; payment boxes → 200', async () => {
    const statuses = [];
    for (const [method, route, body, expected] of [
      ['GET', '/api/cashbox/boxes', undefined, 403], ['POST', '/api/cashbox/boxes', { name: 'x', type: 'wallet' }, 403],
      ['POST', '/api/cashbox/transfers', { fromBoxId: ctx.main._id, toBoxId: ctx.wallet._id, amount: 1 }, 403], ['GET', '/api/devices', undefined, 403],
      ['GET', '/api/cashbox/payment-boxes', undefined, 200],
    ]) {
      const response = await request(method, route, { body, ...asUser(ctx.cashierToken) });
      expectStatus(response, expected, `cashier ${method} ${route}`);
      statuses.push(response.status);
    }
    return `statuses ${statuses.join(', ')}`;
  });

  await step('Stage 19: a storekeeper gets 403 on boxes, shifts, expenses, drawings and transfers', async () => {
    const statuses = [];
    for (const [method, route, body] of [
      ['GET', '/api/cashbox/boxes'], ['GET', '/api/shifts'], ['GET', '/api/expenses'], ['POST', '/api/expenses', { accountId: 'x', amount: 1 }],
      ['POST', '/api/cashbox/drawings', { amount: 1 }], ['POST', '/api/cashbox/transfers', { fromBoxId: ctx.main._id, toBoxId: ctx.wallet._id, amount: 1 }],
    ]) {
      const response = await request(method, route, { body, ...asUser(ctx.keeperToken) });
      expectStatus(response, 403, `storekeeper ${method} ${route}`);
      statuses.push(response.status);
    }
    return `statuses ${statuses.join(', ')}`;
  });

  await step('Stage 19: a request without the device header, or with a malformed one, still works (the id never authenticates)', async () => {
    const plain = await request('GET', '/api/cashbox/payment-boxes', { token: ctx.cashierToken });
    expectStatus(plain, 200, 'no device header');
    const bad = await request('GET', '/api/cashbox/payment-boxes', { token: ctx.cashierToken, headers: { 'x-nota-device-id': 'bad id!' } });
    expectStatus(bad, 200, 'malformed device header');
    expect(bad.json.defaultBoxId === plain.json.defaultBoxId, 'a malformed id changed the default box');
    const unsigned = await request('GET', '/api/cashbox/payment-boxes', { token: null, headers: DEVICE_HEADERS });
    expectStatus(unsigned, 401, 'device header without a session');
    return 'default box unchanged; no token → 401';
  });
}

async function runScenarios() {
  const ctx = {};
  const today = localDay(); // sellingDate of every sale below

  await runAuthSetup(ctx);

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

  // Stage 15: the backend, not just the POS field, enforces each user's maximum discount.
  await step('Max discount: manager limited to 10% is refused at 15%', async () => {
    requireCtx(ctx, 'productId');
    const manager = {
      name: 'Smoke Limited Manager',
      username: 'smoke-limited-manager',
      password: 'manager-pass-1',
      role: 'manager',
      maxDiscountPercent: 10,
    };
    const created = await request('POST', '/api/users', { body: manager });
    expectStatus(created, 201, 'POST /api/users (limited manager)');
    const login = await request('POST', '/api/auth/login', {
      body: { username: manager.username, password: manager.password },
      token: null,
    });
    expectStatus(login, 200, 'limited manager login');
    const response = await request('POST', '/api/sellings', {
      token: login.json.token,
      body: {
        customerName: 'Smoke Discount Customer',
        customerPhone: '01000000008',
        sellingDate: today,
        items: [{ productId: ctx.productId, quantity: 1, price: 100 }],
        discountAmount: 15,
      },
    });
    expectStatus(response, 403, 'POST /api/sellings with a 15% discount');
    expect(response.json.code === 'DISCOUNT_LIMIT', `code expected DISCOUNT_LIMIT, got ${response.json.code}`);
    expect(response.json.message === 'أقصى خصم مسموح لك 10٪', `message: ${response.json.message}`);
    expect(response.json.maxDiscountPercent === 10, `limit expected 10, got ${response.json.maxDiscountPercent}`);
    return `${describe(response)}, limit ${response.json.maxDiscountPercent}%, ${await expectStock(ctx, 10)}`;
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
    ctx.cashInvoiceNumber = response.json && response.json.number;
    expect(ctx.cashInvoiceId, 'response has no _id');
    expect(/^INV-\d{6,}$/.test(ctx.cashInvoiceNumber || ''), `cash invoice number is invalid: ${ctx.cashInvoiceNumber}`);
    expect(Number(response.json.totalPrice) === 200, `totalPrice expected 200, got ${response.json.totalPrice}`);
    return `invoice ${ctx.cashInvoiceId}, ${await expectStock(ctx, 8)}`;
  });

  await step('Sale below purchase price is rejected', async () => {
    requireCtx(ctx, 'productId', 'clerkToken');
    // Stage 13: the owner may sell below cost (sales.priceBelowCost), so this check uses the clerk
    // (a cashier, who may not). The message must not reveal the purchase price (50).
    const response = await request('POST', '/api/sellings', {
      token: ctx.clerkToken,
      body: {
        customerName: 'Smoke Cash Customer',
        customerPhone: '01000000001',
        sellingDate: today,
        items: [{ productId: ctx.productId, quantity: 1, price: 40 }],
      },
    });
    expectStatus(response, 400, 'POST /api/sellings at price 40');
    expect(!/50/.test(String(response.json && response.json.message)), 'the message reveals the purchase price');
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
    ctx.cashReturnNumber = response.json?.data?.returnLog?.number;
    ctx.cashReturnId = response.json?.data?.returnLog?._id;
    expect(/^RT-\d{6,}$/.test(ctx.cashReturnNumber || ''), `cash return number is invalid: ${ctx.cashReturnNumber}`);
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
    ctx.creditInvoiceNumber = response.json && response.json.number;
    ctx.customerId = response.json && response.json.customerId && String(response.json.customerId);
    expect(ctx.creditInvoiceId, 'response has no _id');
    expect(/^CR-\d{6,}$/.test(ctx.creditInvoiceNumber || ''), `credit invoice number is invalid: ${ctx.creditInvoiceNumber}`);
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
    expect(/^RC-\d{6,}$/.test(response.json.receiptNumber || ''), `receipt number is invalid: ${response.json.receiptNumber}`);
    ctx.receiptNumbers = [...(ctx.receiptNumbers || []), response.json.receiptNumber];
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
    expect(/^RC-\d{6,}$/.test(response.json.receiptNumber || ''), `customer receipt number is invalid: ${response.json.receiptNumber}`);
    ctx.receiptNumbers = [...(ctx.receiptNumbers || []), response.json.receiptNumber];
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
    const returns = await request('GET', `/api/returns?returnType=credit&invoiceId=${ctx.creditInvoiceId}`);
    expectStatus(returns, 200, 'GET /api/returns (credit)');
    const returnNumber = returns.json.data?.at(-1)?.number;
    ctx.creditReturnNumber = returnNumber;
    ctx.creditReturnId = returns.json.data?.at(-1)?._id;
    expect(/^RT-\d{6,}$/.test(returnNumber || ''), `credit return number is invalid: ${returnNumber}`);
    return `${await expectStock(ctx, 7)}, invoice total ${response.json.totalPrice}, remaining ${response.json.remainingAmount}`;
  });

  await step('Search cash, credit and return documents by number', async () => {
    requireCtx(ctx, 'cashInvoiceNumber', 'creditInvoiceNumber', 'cashReturnNumber');
    const cash = await request('GET', `/api/sellings?number=${encodeURIComponent(ctx.cashInvoiceNumber.replace(/^INV-0+/, 'INV-'))}`);
    const credit = await request('GET', `/api/credit-sales?number=${encodeURIComponent(ctx.creditInvoiceNumber.toLowerCase())}`);
    const returned = await request('GET', `/api/returns?number=${encodeURIComponent(ctx.cashReturnNumber)}`);
    expectStatus(cash, 200, 'GET /api/sellings?number');
    expectStatus(credit, 200, 'GET /api/credit-sales?number');
    expectStatus(returned, 200, 'GET /api/returns?number');
    expect(cash.json.data?.some((row) => row.number === ctx.cashInvoiceNumber), 'cash number search did not find the invoice');
    expect(credit.json.data?.some((row) => row.number === ctx.creditInvoiceNumber), 'credit number search did not find the invoice');
    expect(returned.json.data?.some((row) => row.number === ctx.cashReturnNumber), 'return number search did not find the return');
    return `${ctx.cashInvoiceNumber}, ${ctx.creditInvoiceNumber}, ${ctx.cashReturnNumber}`;
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
    const cashTotal = Number(cashInvoice.json.netTotal);
    const creditTotal = Number(creditInvoice.json.netTotal);
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

  await step('Cancel cash invoice → restore 2 not-returned units, cancelRefundAmount 200', async () => {
    requireCtx(ctx, 'cashInvoiceId');
    const response = await request('POST', `/api/sellings/${ctx.cashInvoiceId}/cancel`, { body: { reason: 'smoke cancellation' } });
    expectStatus(response, 200, 'POST /api/sellings/:id/cancel');
    expect(response.json.status === 'cancelled', `cash status expected cancelled, got ${response.json.status}`);
    expect(Number(response.json.cancelRefundAmount) === 200, `cancelRefundAmount expected 200, got ${response.json.cancelRefundAmount}`);
    const readable = await request('GET', `/api/sellings/${ctx.cashInvoiceId}`);
    expectStatus(readable, 200, 'GET cancelled cash invoice');
    return await expectStock(ctx, 9);
  });

  await step('Stage 19 round 2: the cancelled cash invoice says which box paid the refund (cancelRefundBoxName)', async () => {
    requireCtx(ctx, 'cashInvoiceId');
    const response = await request('GET', `/api/sellings/${ctx.cashInvoiceId}`);
    expectStatus(response, 200, 'GET cancelled cash invoice');
    expect(Boolean(response.json.cancelRefundBoxId) && response.json.cancelRefundBoxName === 'الخزنة الرئيسية', JSON.stringify({ id: response.json.cancelRefundBoxId, name: response.json.cancelRefundBoxName }));
    return `refund box: ${response.json.cancelRefundBoxName}`;
  });

  await step('Credit invoice with payments/return cannot be cancelled', async () => {
    requireCtx(ctx, 'creditInvoiceId');
    const response = await request('POST', `/api/credit-sales/${ctx.creditInvoiceId}/cancel`, { body: { reason: 'smoke cancellation' } });
    expectStatus(response, 409, 'POST /api/credit-sales/:id/cancel with return');
    expect(['HAS_RETURNS', 'HAS_PAYMENTS'].includes(response.json.code), `expected cancellation conflict code, got ${response.json.code}`);
    return await expectStock(ctx, 9);
  });

  await step('Credit invoice with down payment cancels, restores stock, and statement nets to zero', async () => {
    requireCtx(ctx, 'productId', 'customerId');
    const created = await request('POST', '/api/credit-sales', { body: {
      customerId: ctx.customerId, sellingDate: today,
      items: [{ productId: ctx.productId, quantity: 1, price: 790 }], initialPaidAmount: 200,
    } });
    expectStatus(created, 201, 'POST /api/credit-sales (cancel fixture)');
    expect(/^CR-\d{6,}$/.test(created.json.number || ''), `credit cancel fixture number invalid: ${created.json.number}`);
    expect(/^RC-\d{6,}$/.test(created.json.payments?.[0]?.number || ''), `down-payment receipt invalid: ${created.json.payments?.[0]?.number}`);
    expect((await expectStock(ctx, 8)), 'stock after cancel fixture create');
    const cancelled = await request('POST', `/api/credit-sales/${created.json._id}/cancel`, { body: { reason: 'smoke down payment cancel' } });
    expectStatus(cancelled, 200, 'POST /api/credit-sales/:id/cancel');
    expect(cancelled.json.status === 'cancelled', `credit status expected cancelled, got ${cancelled.json.status}`);
    expect(Number(cancelled.json.cancelRefundAmount) === 200, `credit cancelRefundAmount expected 200, got ${cancelled.json.cancelRefundAmount}`);
    expect(await expectStock(ctx, 9), 'stock after credit cancel');
    ctx.cancelledCreditId = created.json._id;
    ctx.cancelledCreditNumber = created.json.number;
    ctx.cancelledDownPaymentNumber = created.json.payments[0].number;
    const statement = await request('GET', `/api/customers/${ctx.customerId}/statement`);
    expectStatus(statement, 200, 'GET /api/customers/:id/statement');
    const lines = statement.json.lines || statement.json.data?.lines || [];
    const fixtureLines = lines.filter((line) => line.number === created.json.number || line.number === created.json.payments[0].number);
    expect(fixtureLines.some((line) => line.type === 'invoice' && Number(line.debit) === 790), 'statement is missing the 790 invoice debit');
    expect(fixtureLines.some((line) => line.type === 'payment' && Number(line.credit) === 200), 'statement is missing the 200 payment credit');
    expect(fixtureLines.some((line) => line.type === 'cancel' && Number(line.credit) === 790), 'statement is missing the 790 cancel credit');
    expect(fixtureLines.some((line) => line.description === 'رد المقدم' && Number(line.debit) === 200), 'statement is missing the 200 down-payment refund debit');
    return `${created.json.number}, ${created.json.payments[0].number}, four statement lines, stock 9`;
  });

  await step('Product with sales archives; archived product is hidden by default and restorable', async () => {
    requireCtx(ctx, 'productId');
    const archived = await request('DELETE', `/api/products/${ctx.productId}`);
    expectStatus(archived, 200, 'DELETE /api/products/:id');
    expect(archived.json.action === 'archived', `expected archived action, got ${archived.json.action}`);
    const hidden = await request('GET', '/api/products?page=1&limit=10');
    expect(!(hidden.json.data || []).some((row) => row._id === ctx.productId), 'archived product is visible in the default list');
    const included = await request('GET', '/api/products?page=1&limit=10&includeArchived=1');
    expect((included.json.data || []).some((row) => row._id === ctx.productId && row.isArchived), 'archived product missing from includeArchived list');
    const restored = await request('POST', `/api/products/${ctx.productId}/restore`);
    expectStatus(restored, 200, 'POST /api/products/:id/restore');
    return 'archived, hidden, included, restored';
  });

  await step('Deleting a non-empty category is refused with CATEGORY_NOT_EMPTY', async () => {
    requireCtx(ctx, 'categoryId');
    const response = await request('DELETE', `/api/categories/${ctx.categoryId}`);
    expectStatus(response, 409, 'DELETE /api/categories/:id');
    expect(response.json.code === 'CATEGORY_NOT_EMPTY', `code expected CATEGORY_NOT_EMPTY, got ${response.json.code}`);
    return describe(response);
  });

  await step('Dashboard excludes cancelled cash and uses net credit totals after return/cancel', async () => {
    const response = await request('GET', '/api/dashboard/summary');
    expectStatus(response, 200, 'GET /api/dashboard/summary after cancellation');
    expect(response.json.today.cash.count === 0 && Number(response.json.today.cash.total) === 0,
      `cancelled cash still counted: ${JSON.stringify(response.json.today.cash)}`);
    expect(response.json.today.credit.count === 1 && Number(response.json.today.credit.total) === 100,
      `credit net total expected 100: ${JSON.stringify(response.json.today.credit)}`);
    expect(Number(response.json.credit.outstanding) === 20, `outstanding expected 20, got ${response.json.credit.outstanding}`);
    return `cash 0, credit net 100, outstanding ${response.json.credit.outstanding}`;
  });

  await step('Accounting: every smoke INV/CR/RC/RT has a journal entry', async () => {
    const sources = [
      ['sale', ctx.cashInvoiceId], ['credit_sale', ctx.creditInvoiceId], ['return', ctx.cashReturnId], ['return', ctx.creditReturnId],
    ];
    for (const [sourceType, sourceId] of sources) {
      const response = await request('GET', `/api/accounting/journal?sourceType=${sourceType}&sourceId=${sourceId}&limit=100`);
      expectStatus(response, 200, 'GET /api/accounting/journal by source'); expect(response.json.data.length > 0, `missing JE for ${sourceType} ${sourceId}`);
    }
    for (const number of ctx.receiptNumbers || []) { const response = await request('GET', `/api/accounting/journal?sourceType=receipt&sourceNumber=${number}`); expect(response.json.data.length === 1, `missing or duplicate receipt JE ${number}`); }
    return `${sources.length} documents and ${(ctx.receiptNumbers || []).length} receipts linked`;
  });

  await step('Accounting: edited cash-sale journal lines are exact', async () => {
    const response = await request('GET', `/api/accounting/journal?sourceType=sale&sourceId=${ctx.cashInvoiceId}&limit=100`); const entry = response.json.data.find(row => row.type === 'auto' && row.lines.some(line => line.accountCode === '1111' && Number(line.debit) === 300));
    expect(entry, 'edited cash-sale entry missing'); const byCode = new Map(entry.lines.map(line => [line.accountCode, line]));
    expect(byCode.get('1111')?.debit === 300, 'CASH_MAIN debit is not 300'); expect(byCode.get('410')?.credit === 300, 'SALES credit is not 300'); expect(byCode.get('510')?.debit === 150, 'COGS debit is not 150'); expect(byCode.get('114')?.credit === 150, 'INVENTORY credit is not 150');
    return 'Dr cash 300, Cr sales 300, Dr COGS 150, Cr inventory 150';
  });

  await step('Accounting: credit cancel with down payment nets customer party to 0', async () => {
    const response = await request('GET', `/api/accounting/journal?sourceId=${ctx.cancelledCreditId}&limit=100`); expectStatus(response, 200, 'journal for cancelled credit');
    const customerNet = response.json.data.flatMap(entry => entry.lines).filter(line => line.accountCode === '113').reduce((sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0), 0);
    const receipt = await request('GET', `/api/accounting/journal?sourceType=receipt&sourceNumber=${ctx.cancelledDownPaymentNumber}`); const receiptCustomer = receipt.json.data.flatMap(entry => entry.lines).filter(line => line.accountCode === '113').reduce((sum,line)=>sum+Number(line.debit||0)-Number(line.credit||0),0);
    expect(customerNet + receiptCustomer === 0, `customer party net expected 0, got ${customerNet + receiptCustomer}`); return `party net ${customerNet + receiptCustomer}`;
  });

  await step('Accounting health: every expected/actual/difference is printed and difference is 0', async () => {
    const response = await request('GET', '/api/accounting/health'); expectStatus(response, 200, 'GET /api/accounting/health');
    const details = Object.entries(response.json).map(([name, check]) => `${name}: expected=${check.expected}, actual=${check.actual}, difference=${check.difference}`);
    for (const [name, check] of Object.entries(response.json)) expect(Number(check.difference) === 0 && check.ok !== false, `${name} difference ${check.difference} ok ${check.ok}`);
    return details.join(' | ');
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

  await runAuthScenarios(ctx);
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

// Stage 20: purchases, supplier payments, purchase returns and refunds, cancel, the statement, on a fresh database (auth on).
const S20_DEVICE = { 'x-nota-device-id': '1a9fad5b-d9cb-469f-a165-70867728950f', 'x-nota-device-name': encodeURIComponent('Smoke-S20-PC') };

async function runStage20Scenarios() {
  const ctx = {};
  authToken = null;
  const login = async (user) => {
    const response = await request('POST', '/api/auth/login', { body: { username: user.username, password: user.password }, token: null });
    expectStatus(response, 200, `${user.username} login`);
    return response.json.token;
  };
  const utcDay = () => new Date().toISOString().slice(0, 10);
  const balanceOfSupplier = async () => (await request('GET', `/api/suppliers/${ctx.supplierId}`)).json.balance;

  await step('Stage 20: setup-owner, a cashier and a storekeeper on a fresh database', async () => {
    const owner = await request('POST', '/api/auth/setup-owner', { body: OWNER, token: null });
    expectStatus(owner, 201, 'POST /api/auth/setup-owner');
    authToken = owner.json.token;
    const cashier = { name: 'S20 Cashier', username: 's20-cashier', password: 'clerk-pass-1', role: 'cashier' };
    const keeper = { name: 'S20 Keeper', username: 's20-keeper', password: 'clerk-pass-1', role: 'storekeeper' };
    expectStatus(await request('POST', '/api/users', { body: cashier }), 201, 'POST cashier');
    expectStatus(await request('POST', '/api/users', { body: keeper }), 201, 'POST storekeeper');
    ctx.cashierToken = await login(cashier);
    ctx.keeperToken = await login(keeper);
    return 'owner, cashier, storekeeper';
  });

  await step('Stage 20: a supplier with an opening of 500 owed (main cash 20,000, a 30,000 bank), a product with 10 in stock at 20', async () => {
    const category = await request('POST', '/api/categories', { body: { name: 'S20 Category' } });
    expectStatus(category, 201, 'POST /api/categories');
    const product = await request('POST', '/api/products', { body: { name: 'S20 Product', code: 'S20-1', categoryId: category.json._id, inventoryCount: 10, purchasePrice: 20, wholesalePrice: 30, retailPrice: 40 } });
    expectStatus(product, 201, 'POST /api/products');
    ctx.productId = product.json._id;
    const supplier = await request('POST', '/api/suppliers', { body: { name: 'S20 Supplier', paymentTermsDays: 30 } });
    expectStatus(supplier, 201, 'POST /api/suppliers');
    ctx.supplierId = supplier.json._id;
    const saved = await request('POST', '/api/accounting/opening', { body: { cash: 20000, banks: [{ name: 'S20 Bank', type: 'bank', amount: 30000 }], suppliers: [{ supplierId: ctx.supplierId, amount: 500 }] } });
    expectStatus(saved, 200, 'POST /api/accounting/opening');
    const boxes = await request('GET', '/api/cashbox/boxes');
    ctx.main = boxes.json.data.find((box) => box.isMain);
    ctx.bank = boxes.json.data.find((box) => box.type === 'bank');
    expect((await balanceOfSupplier()) === 500, 'opening balance 500');
    return `OB ${saved.json.number}, supplier balance 500`;
  });

  await step('Stage 20: a drawer with a shift (2,000 float) is the box the purchase pays from', async () => {
    const drawer = await request('POST', '/api/cashbox/boxes', { body: { name: 'S20 Drawer', type: 'cash', deviceId: S20_DEVICE['x-nota-device-id'], shiftsEnabled: true } });
    expectStatus(drawer, 201, 'POST drawer');
    ctx.drawer = drawer.json;
    const funded = await request('POST', '/api/cashbox/transfers', { body: { fromBoxId: ctx.main._id, toBoxId: ctx.drawer._id, amount: 2000 } });
    expectStatus(funded, 201, 'POST transfer');
    const shift = await request('POST', '/api/shifts', { headers: S20_DEVICE, body: { boxId: ctx.drawer._id, openingFloat: 2000 } });
    expectStatus(shift, 201, 'POST /api/shifts');
    ctx.shift = shift.json;
    return `${shift.json.number} on ${ctx.drawer.name}`;
  });

  await step('Stage 20: PO-000001, 10 at 30 (total 300), 100 paid from the drawer → PV-000001, stock 20, cost 25, supplier balance 700', async () => {
    const response = await request('POST', '/api/purchases', { headers: S20_DEVICE, body: { supplierId: ctx.supplierId, supplierInvoiceNo: 'S20-INV-1', date: utcDay(), items: [{ productId: ctx.productId, qty: 10, unitPrice: 30 }], paidAmount: 100, boxId: ctx.drawer._id } });
    expectStatus(response, 201, 'POST /api/purchases');
    expect(response.json.number === 'PO-000001' && response.json.pvNumber === 'PV-000001' && response.json.total === 300, JSON.stringify(response.json));
    ctx.purchase = response.json;
    const product = (await request('GET', `/api/products/${ctx.productId}`)).json;
    expect(product.inventoryCount === 20 && product.purchasePrice === 25, `stock ${product.inventoryCount}, cost ${product.purchasePrice}`);
    expect((await balanceOfSupplier()) === 700, `balance ${await balanceOfSupplier()}`);
    return `${response.json.number} + ${response.json.pvNumber}, stock 20, cost 25, balance 700`;
  });

  await step('Stage 20: the shift expects the PV (supplier payments 100): 1,900 in the drawer', async () => {
    const report = await request('GET', `/api/shifts/${ctx.shift._id}`, { headers: S20_DEVICE });
    expectStatus(report, 200, 'GET /api/shifts/:id');
    const lines = Object.fromEntries(report.json.lines.map((row) => [row.key, row.amount]));
    expect(lines.supplierPayments === 100 && report.json.expected === 1900, JSON.stringify({ lines, expected: report.json.expected }));
    return `supplierPayments ${lines.supplierPayments}, expected ${report.json.expected}`;
  });

  await step('Stage 20: pay the supplier 200 from the bank → PV-000002, balance 500; an advance needs a confirm (409)', async () => {
    const paid = await request('POST', `/api/suppliers/${ctx.supplierId}/payments`, { body: { amount: 200, boxId: ctx.bank._id, reference: 'S20-CHQ' } });
    expectStatus(paid, 201, 'POST payment');
    expect(paid.json.number === 'PV-000002' && paid.json.balanceAfter === 500, JSON.stringify(paid.json));
    const advance = await request('POST', `/api/suppliers/${ctx.supplierId}/payments`, { body: { amount: 900, boxId: ctx.bank._id } });
    expectStatus(advance, 409, 'advance without confirm');
    expect(advance.json.code === 'ADVANCE_NOT_CONFIRMED', describe(advance));
    return `${paid.json.number}, balance ${paid.json.balanceAfter}; ${describe(advance)}`;
  });

  await step('Stage 20: return 2 units → PR-000001 (60); a cash refund is refused while we still owe the supplier (409 REFUND_EXCEEDS_DUE); balance 440', async () => {
    const url = `/api/purchases/${ctx.purchase._id}/returns`;
    const items = [{ itemId: ctx.purchase.items[0]._id, qty: 2 }];
    const refused = await request('POST', url, { headers: S20_DEVICE, body: { items, reason: 'smoke return', refundAmount: 60, boxId: ctx.drawer._id } });
    expectStatus(refused, 409, 'return with a refund while we owe the supplier');
    expect(refused.json.code === 'REFUND_EXCEEDS_DUE', describe(refused));
    const response = await request('POST', url, { headers: S20_DEVICE, body: { items, reason: 'smoke return' } });
    expectStatus(response, 201, 'POST returns');
    expect(response.json.number === 'PR-000001' && response.json.total === 60 && response.json.supplierBalanceAfter === 440, JSON.stringify(response.json));
    const product = (await request('GET', `/api/products/${ctx.productId}`)).json;
    expect(product.inventoryCount === 18 && product.purchasePrice === 25, `stock ${product.inventoryCount}, cost ${product.purchasePrice}`);
    return `${describe(refused)}; ${response.json.number} ${response.json.total}, stock 18, balance 440`;
  });

  await step('Stage 20: PO-000002 (4 at 50) on credit moves the average to 29.55; cancelling it takes the stock back and keeps the current average', async () => {
    const second = await request('POST', '/api/purchases', { body: { supplierId: ctx.supplierId, date: utcDay(), items: [{ productId: ctx.productId, qty: 4, unitPrice: 50 }] } });
    expectStatus(second, 201, 'POST second purchase');
    expect(second.json.number === 'PO-000002' && second.json.pvNumber === null, JSON.stringify(second.json));
    expect((await balanceOfSupplier()) === 640, 'balance 640 with the credit invoice');
    const cancelled = await request('POST', `/api/purchases/${second.json._id}/cancel`, { body: { reason: 'smoke cancel' } });
    expectStatus(cancelled, 200, 'POST cancel');
    expect((await balanceOfSupplier()) === 440, `balance ${await balanceOfSupplier()}`);
    const product = (await request('GET', `/api/products/${ctx.productId}`)).json;
    expect(product.inventoryCount === 18 && product.purchasePrice === 29.55, `stock ${product.inventoryCount}, cost ${product.purchasePrice}`);
    return `PO-000002 cancelled, stock 18, cost stays 29.55, balance 440`;
  });

  await step('Stage 20: the supplier statement lines and totals agree with the supplier balance', async () => {
    const statement = await request('GET', `/api/suppliers/${ctx.supplierId}/statement`);
    expectStatus(statement, 200, 'GET statement');
    const types = statement.json.lines.map((row) => row.type);
    expect(JSON.stringify(types) === JSON.stringify(['opening_balance', 'purchase', 'payment', 'payment', 'purchase_return', 'purchase', 'purchase_cancel']), types.join(','));
    expect(statement.json.balance === 440 && statement.json.ledgerBalance === 440 && statement.json.totals.balance === 440, JSON.stringify(statement.json.totals));
    expect(statement.json.lines[1].supplierInvoiceNo === 'S20-INV-1', 'supplier invoice number on the purchase line');
    return `${types.length} lines, balance ${statement.json.balance}, aging total ${statement.json.aging.total}`;
  });

  await step('Stage 20: an advance of 540 from the bank (balance -100), then the supplier refunds 100 into the drawer → SR-000001, balance 0', async () => {
    const advance = await request('POST', `/api/suppliers/${ctx.supplierId}/payments`, { body: { amount: 540, boxId: ctx.bank._id, confirmAdvance: true } });
    expectStatus(advance, 201, 'POST advance payment');
    expect(advance.json.balanceAfter === -100, JSON.stringify(advance.json));
    const tooMuch = await request('POST', `/api/suppliers/${ctx.supplierId}/refunds`, { headers: S20_DEVICE, body: { amount: 101, boxId: ctx.drawer._id } });
    expectStatus(tooMuch, 409, 'refund above the advance');
    const refund = await request('POST', `/api/suppliers/${ctx.supplierId}/refunds`, { headers: S20_DEVICE, body: { amount: 100, boxId: ctx.drawer._id, note: 'smoke refund' } });
    expectStatus(refund, 201, 'POST refund');
    expect(refund.json.number === 'SR-000001' && (await balanceOfSupplier()) === 0, JSON.stringify(refund.json));
    return `${advance.json.number} advance, ${describe(tooMuch)}, ${refund.json.number}, balance 0`;
  });

  await step('Stage 20: a sale of the purchased product takes COGS at the current average cost (29.55)', async () => {
    const sale = await request('POST', '/api/sellings', { headers: S20_DEVICE, body: { customerName: 'Walk-in', customerPhone: '01000002020', sellingDate: localDay(), items: [{ productId: ctx.productId, quantity: 1, price: 100 }] } });
    expectStatus(sale, 201, 'POST /api/sellings');
    const item = sale.json.items[0];
    expect(item.purchasePrice === 29.55, `COGS cost ${item.purchasePrice}`);
    const journal = await request('GET', `/api/accounting/journal?sourceType=sale&sourceId=${sale.json._id}`);
    expectStatus(journal, 200, 'GET journal');
    const lines = (journal.json.data || journal.json.entries || []).flatMap((entry) => entry.lines || []);
    const cogs = lines.find((row) => row.accountCode === '510' || /cogs|cost of/i.test(row.accountNameEn || ''));
    expect(cogs && cogs.debit === 29.55, `COGS line ${JSON.stringify(cogs)}`);
    return `sale cost 29.55, COGS debit ${cogs.debit}`;
  });

  await step('Stage 20: accounting health: every check is 0 (suppliers, inventory, entries, boxes, shifts)', async () => {
    const health = await request('GET', '/api/accounting/health');
    expectStatus(health, 200, 'GET /api/accounting/health');
    const rows = Object.entries(health.json).filter(([, check]) => check && typeof check === 'object' && 'difference' in check);
    for (const [name, check] of rows) {
      expect(Number(check.difference) === 0 && check.ok !== false, `health ${name}: ${JSON.stringify(check)}`);
    }
    expect(health.json.suppliers.difference === 0 && health.json.inventory.difference === 0 && health.json.entries.difference === 0 && health.json.boxes.difference === 0, 'the four Stage 20 checks');
    return rows.map(([name, check]) => `${name}=${check.difference}`).join(', ');
  });

  await step('Stage 20: a cashier gets 403 on purchases, the supplier statement and paying suppliers', async () => {
    expectStatus(await request('GET', '/api/purchases', { token: ctx.cashierToken }), 403, 'cashier GET /api/purchases');
    expectStatus(await request('POST', '/api/purchases', { token: ctx.cashierToken, body: { supplierId: ctx.supplierId, items: [{ productId: ctx.productId, qty: 1, unitPrice: 1 }] } }), 403, 'cashier POST /api/purchases');
    expectStatus(await request('GET', `/api/suppliers/${ctx.supplierId}/statement`, { token: ctx.cashierToken }), 403, 'cashier GET statement');
    expectStatus(await request('POST', `/api/suppliers/${ctx.supplierId}/payments`, { token: ctx.cashierToken, body: { amount: 1 } }), 403, 'cashier POST payment');
    return '403, 403, 403, 403';
  });

  await step('Stage 20: a storekeeper can buy on credit only (paying needs suppliers.pay → 403)', async () => {
    const credit = await request('POST', '/api/purchases', { token: ctx.keeperToken, body: { supplierId: ctx.supplierId, date: utcDay(), items: [{ productId: ctx.productId, qty: 1, unitPrice: 30 }] } });
    expectStatus(credit, 201, 'storekeeper credit purchase');
    expect(credit.json.paidAmount === 0, 'a storekeeper purchase is all credit');
    const paid = await request('POST', '/api/purchases', { token: ctx.keeperToken, body: { supplierId: ctx.supplierId, date: utcDay(), items: [{ productId: ctx.productId, qty: 1, unitPrice: 30 }], paidAmount: 10 } });
    expectStatus(paid, 403, 'storekeeper paid purchase');
    expect(paid.json.code === 'PAY_NOT_ALLOWED', describe(paid));
    return `${credit.json.number} on credit; ${describe(paid)}`;
  });
}

const S21_DEVICE = { 'x-nota-device-id': '5b0e7c1a-3d44-4a8e-9f21-c0de21000001', 'x-nota-device-name': encodeURIComponent('Smoke-S21-PC') };

async function runStage21Scenarios() {
  const ctx = {};
  authToken = null;
  const r2 = (value) => Math.round(value * 100) / 100;
  const login = async (user) => {
    const response = await request('POST', '/api/auth/login', { body: { username: user.username, password: user.password }, token: null });
    expectStatus(response, 200, `${user.username} login`);
    return response.json.token;
  };
  // The LOCAL day: VAT starts on the shop's local day, and every document is dated by it.
  const localDay = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  // A month can be filed only after it has ended, so the VAT documents of this scenario are dated in the PREVIOUS month
  // (the 15th) and the shop's VAT start date is moved back to its first day. Document dates are business dates; the
  // records are created now, so they are ledger documents.
  const monthStart = (offset) => new Date(new Date().getFullYear(), new Date().getMonth() + offset, 1);
  const dayKey = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const docDay = dayKey(new Date(monthStart(-1).getFullYear(), monthStart(-1).getMonth(), 15));
  const previousPeriod = docDay.slice(0, 7);
  const currentPeriod = localDay().slice(0, 7);
  const sell = (items, extra = {}) => request('POST', '/api/sellings', { headers: S21_DEVICE, body: { customerName: 'S21 Cash', customerPhone: '01021212121', sellingDate: docDay, items, ...extra } });

  await step('Stage 21: setup-owner and a cashier on a fresh database', async () => {
    const owner = await request('POST', '/api/auth/setup-owner', { body: OWNER, token: null });
    expectStatus(owner, 201, 'POST /api/auth/setup-owner');
    authToken = owner.json.token;
    const cashier = { name: 'S21 Cashier', username: 's21-cashier', password: 'clerk-pass-1', role: 'cashier' };
    expectStatus(await request('POST', '/api/users', { body: cashier }), 201, 'POST cashier');
    ctx.cashierToken = await login(cashier);
    return 'owner, cashier';
  });

  await step('Stage 21: a product (cost 20, price 35), a credit customer, a VAT-registered supplier, main cash 50,000, a drawer with a shift', async () => {
    const category = await request('POST', '/api/categories', { body: { name: 'S21 Category' } });
    expectStatus(category, 201, 'POST /api/categories');
    const product = await request('POST', '/api/products', { body: { name: 'S21 Product', code: 'S21-1', categoryId: category.json._id, inventoryCount: 500, purchasePrice: 20, wholesalePrice: 30, retailPrice: 35 } });
    expectStatus(product, 201, 'POST /api/products');
    ctx.productId = product.json._id;
    const customer = await request('POST', '/api/customers', { body: { name: 'S21 Customer', phone: '01031313131' } });
    expectStatus(customer, 201, 'POST /api/customers');
    ctx.customerId = customer.json._id;
    const supplier = await request('POST', '/api/suppliers', { body: { name: 'S21 Supplier', vatRegistered: true } });
    expectStatus(supplier, 201, 'POST /api/suppliers');
    ctx.supplierId = supplier.json._id;
    expect(supplier.json.vatRegistered === true, 'the supplier keeps its VAT flag');
    expectStatus(await request('POST', '/api/accounting/opening', { body: { cash: 50000 } }), 200, 'POST /api/accounting/opening');
    const boxes = await request('GET', '/api/cashbox/boxes');
    ctx.main = boxes.json.data.find((box) => box.isMain);
    const drawer = await request('POST', '/api/cashbox/boxes', { body: { name: 'S21 Drawer', type: 'cash', deviceId: S21_DEVICE['x-nota-device-id'], shiftsEnabled: true } });
    expectStatus(drawer, 201, 'POST drawer');
    ctx.drawer = drawer.json;
    expectStatus(await request('POST', '/api/cashbox/transfers', { body: { fromBoxId: ctx.main._id, toBoxId: ctx.drawer._id, amount: 2000 } }), 201, 'POST transfer');
    const shift = await request('POST', '/api/shifts', { headers: S21_DEVICE, body: { boxId: ctx.drawer._id, openingFloat: 2000 } });
    expectStatus(shift, 201, 'POST /api/shifts');
    ctx.shift = shift.json;
    return `${shift.json.number} on ${ctx.drawer.name}`;
  });

  await step('Stage 21: turning VAT on needs the shop tax number (400 TAX_NUMBER_REQUIRED); with it VAT is on from today', async () => {
    const refused = await request('PUT', '/api/shop-profile', { body: { name: 'S21 Shop', vat: { enabled: true, rate: 14, pricesIncludeVat: true } } });
    expectStatus(refused, 400, 'VAT on without a tax number');
    expect(refused.json.code === 'TAX_NUMBER_REQUIRED', describe(refused));
    const on = await request('PUT', '/api/shop-profile', { body: { name: 'S21 Shop', taxNumber: '123-456-789', vat: { enabled: true, rate: 14, pricesIncludeVat: true } } });
    expectStatus(on, 200, 'PUT /api/shop-profile');
    expect(on.json.vat.enabled === true && on.json.vat.rate === 14 && String(on.json.vat.startDate).length > 0, JSON.stringify(on.json.vat));
    return `${describe(refused)}; VAT on from ${String(on.json.vat.startDate).slice(0, 10)}`;
  });

  await step('Stage 21: VAT was turned on last month (the start date moves back to the 1st of last month) so last month can be filed', async () => {
    const { MongoClient } = require(path.join(BACKEND_DIR, 'node_modules', 'mongodb'));
    const client = new MongoClient(`mongodb://127.0.0.1:${MONGO_PORT}/${STAGE21_DB_NAME}?replicaSet=${REPLICA_SET}&directConnection=true`);
    await client.connect();
    try {
      const start = monthStart(-1);
      const result = await client.db(STAGE21_DB_NAME).collection('shopprofiles').updateOne({ key: 'default' }, { $set: { 'vat.startDate': new Date(Date.UTC(start.getFullYear(), start.getMonth(), 1)) } });
      expect(result.modifiedCount === 1, JSON.stringify(result));
    } finally { await client.close(); }
    const profile = await request('GET', '/api/shop-profile');
    expect(String(profile.json.vat.startDate).startsWith(`${previousPeriod}-01`), JSON.stringify(profile.json.vat));
    return `VAT start date ${String(profile.json.vat.startDate).slice(0, 10)}; documents dated ${docDay}`;
  });

  await step('Stage 21: a cash sale 4 x 35 + 2 x 65, discount 20 -> total 250, VAT 30.70, net 219.30', async () => {
    const response = await sell([{ productId: ctx.productId, quantity: 4, price: 35 }, { productId: ctx.productId, quantity: 2, price: 65 }], { discountAmount: 20 });
    expectStatus(response, 201, 'POST /api/sellings');
    expect(response.json.totalPrice === 250 && response.json.vatAmount === 30.7 && response.json.netAmount === 219.3, JSON.stringify({ total: response.json.totalPrice, vat: response.json.vatAmount, net: response.json.netAmount }));
    ctx.sale = response.json;
    return `${response.json.number}: total 250, VAT 30.7, net 219.3`;
  });

  await step('Stage 21: a big cash sale (11,400, VAT 1,400), a credit sale (114, VAT 14), a partial return of the first sale', async () => {
    const big = await sell([{ productId: ctx.productId, quantity: 1, price: 11400 }]);
    expectStatus(big, 201, 'big cash sale');
    expect(big.json.vatAmount === 1400, `big VAT ${big.json.vatAmount}`);
    const credit = await request('POST', '/api/credit-sales', { headers: S21_DEVICE, body: { customerId: ctx.customerId, sellingDate: docDay, items: [{ productId: ctx.productId, quantity: 1, price: 114 }] } });
    expectStatus(credit, 201, 'credit sale');
    expect(credit.json.vatAmount === 14, `credit VAT ${credit.json.vatAmount}`);
    const itemId = ctx.sale.items[0]._id;
    const returned = await request('POST', '/api/returns', { headers: S21_DEVICE, body: { returnType: 'cash', invoiceId: ctx.sale._id, returnDate: docDay, items: [{ itemId, productId: ctx.productId, quantity: 1, returnReason: 'smoke' }] } });
    expectStatus(returned, 201, 'POST /api/returns');
    ctx.returnVat = returned.json.data.returnLog.vatAmount;
    expect(ctx.returnVat > 0, `return VAT ${ctx.returnVat}`);
    return `big VAT ${big.json.vatAmount}, credit VAT ${credit.json.vatAmount}, return VAT ${ctx.returnVat}`;
  });

  await step('Stage 21: a purchase from the registered supplier (net 1,000 + VAT 140 = 1,140) and an expense with VAT (114, VAT 14)', async () => {
    const purchase = await request('POST', '/api/purchases', { body: { supplierId: ctx.supplierId, date: docDay, items: [{ productId: ctx.productId, qty: 10, unitPrice: 100 }] } });
    expectStatus(purchase, 201, 'POST /api/purchases');
    expect(purchase.json.netTotal === 1000 && purchase.json.vatAmount === 140 && purchase.json.total === 1140, JSON.stringify({ net: purchase.json.netTotal, vat: purchase.json.vatAmount, total: purchase.json.total }));
    const categories = await request('GET', '/api/expenses/categories');
    const utilities = categories.json.data.find((row) => row.code === '523');
    const expense = await request('POST', '/api/expenses', { body: { accountId: utilities._id, amount: 114, vatAmount: 14, boxId: ctx.main._id, date: docDay, note: 'S21 electricity' } });
    expectStatus(expense, 201, 'POST /api/expenses');
    expect(expense.json.vatAmount === 14, 'expense VAT');
    return `${purchase.json.number}: VAT 140; ${expense.json.number}: VAT 14`;
  });

  await step('Stage 21: prepare last month, then file it: output - input = payable, the offset posts Dr 22 / Cr 115; the running month cannot be filed (409 PERIOD_NOT_ENDED)', async () => {
    const period = previousPeriod;
    ctx.period = period;
    const prepared = await request('GET', `/api/vat/returns/${period}`);
    expectStatus(prepared, 200, 'GET prepared return');
    const expectedOutput = r2(30.7 + 1400 + 14 - ctx.returnVat);
    expect(prepared.json.output === expectedOutput && prepared.json.input === 154 && prepared.json.net === r2(expectedOutput - 154), JSON.stringify({ output: prepared.json.output, input: prepared.json.input, net: prepared.json.net }));
    expect(prepared.json.canFile === true, 'the month can be filed');
    const running = await request('GET', `/api/vat/returns/${currentPeriod}`);
    expect(running.json.canFile === false, 'the running month cannot be filed yet');
    const filed = await request('POST', `/api/vat/returns/${period}/file`);
    expectStatus(filed, 201, 'POST file');
    expect(filed.json.number === 'VR-000001' && filed.json.offset === 154 && filed.json.payable === r2(expectedOutput - 154), JSON.stringify(filed.json));
    ctx.payable = filed.json.payable;
    const tooEarly = await request('POST', `/api/vat/returns/${currentPeriod}/file`);
    expectStatus(tooEarly, 409, 'file the running month');
    expect(tooEarly.json.code === 'PERIOD_NOT_ENDED', describe(tooEarly));
    return `${period}: output ${prepared.json.output}, input ${prepared.json.input}, payable ${ctx.payable}, offset 154 (${filed.json.number}); ${currentPeriod}: ${describe(tooEarly)}`;
  });

  await step('Stage 21: pay 500 of it from the drawer in the shift (VP-000001); the shift expects it as "سداد ضريبة"', async () => {
    const paid = await request('POST', `/api/vat/returns/${ctx.period}/pay`, { headers: S21_DEVICE, body: { amount: 500, boxId: ctx.drawer._id, reference: 'S21-RCPT' } });
    expectStatus(paid, 201, 'POST pay');
    expect(paid.json.payment.number === 'VP-000001' && paid.json.return.status === 'partial' && paid.json.return.remaining === r2(ctx.payable - 500), JSON.stringify(paid.json.return));
    const report = await request('GET', `/api/shifts/${ctx.shift._id}`, { headers: S21_DEVICE });
    expectStatus(report, 200, 'GET /api/shifts/:id');
    const lines = Object.fromEntries(report.json.lines.map((row) => [row.key, row.amount]));
    expect(lines.vatPayments === 500, JSON.stringify(lines));
    return `${paid.json.payment.number}, remaining ${paid.json.return.remaining}, shift vatPayments ${lines.vatPayments}`;
  });

  await step('Stage 21: pay the rest -> the return is paid; paying more is refused (409)', async () => {
    const rest = await request('POST', `/api/vat/returns/${ctx.period}/pay`, { headers: S21_DEVICE, body: { amount: r2(ctx.payable - 500), boxId: ctx.drawer._id } });
    expectStatus(rest, 201, 'POST pay rest');
    expect(rest.json.return.status === 'paid' && rest.json.return.remaining === 0, JSON.stringify(rest.json.return));
    const more = await request('POST', `/api/vat/returns/${ctx.period}/pay`, { headers: S21_DEVICE, body: { amount: 1, boxId: ctx.drawer._id } });
    expectStatus(more, 409, 'pay with nothing due');
    return `${rest.json.payment.number} paid; ${describe(more)}`;
  });

  await step('Stage 21: accounting health printed and every check is 0 (including the new vat check)', async () => {
    const health = await request('GET', '/api/accounting/health');
    expectStatus(health, 200, 'GET /api/accounting/health');
    const rows = Object.entries(health.json).filter(([, check]) => check && typeof check === 'object' && 'difference' in check);
    for (const [name, check] of rows) {
      expect(Number(check.difference) === 0 && check.ok !== false, `health ${name}: ${JSON.stringify(check)}`);
    }
    expect('vat' in health.json && health.json.vat.difference === 0, 'the vat check exists and is 0');
    return rows.map(([name, check]) => `${name}=${check.difference}`).join(', ');
  });

  await step('Stage 21: a cashier cannot file, pay or read the VAT return (403)', async () => {
    expectStatus(await request('POST', `/api/vat/returns/${ctx.period}/file`, { token: ctx.cashierToken }), 403, 'cashier file');
    expectStatus(await request('POST', `/api/vat/returns/${ctx.period}/pay`, { token: ctx.cashierToken, body: { amount: 1 } }), 403, 'cashier pay');
    expectStatus(await request('GET', '/api/vat/returns', { token: ctx.cashierToken }), 403, 'cashier list');
    return '403, 403, 403';
  });

  await step('Stage 21: turn VAT off -> the next sale has no VAT; the posted invoice keeps its VAT', async () => {
    expectStatus(await request('PUT', '/api/shop-profile', { body: { name: 'S21 Shop', taxNumber: '123-456-789', vat: { enabled: false } } }), 200, 'VAT off');
    const plain = await sell([{ productId: ctx.productId, quantity: 1, price: 100 }]);
    expectStatus(plain, 201, 'sale with VAT off');
    expect(plain.json.vatAmount === undefined && plain.json.totalPrice === 100, JSON.stringify({ vat: plain.json.vatAmount, total: plain.json.totalPrice }));
    const kept = await request('GET', `/api/sellings/${ctx.sale._id}`);
    expect(kept.json.vatAmount === 30.7, `the posted invoice keeps VAT ${kept.json.vatAmount}`);
    return `${plain.json.number}: no VAT; ${kept.json.number} keeps 30.7`;
  });
}

// Stage 22: the financial reports, manual entries (draft, post, reverse, forbidden accounts, a bad debt), the account tree and
// closing last month (PERIOD_LOCKED, a return on a locked invoice, reopen), on a fresh database (auth on).
async function runStage22Scenarios() {
  const ctx = {};
  authToken = null;
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const LAST15 = dayKey(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  const LAST_START = dayKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const LAST_END = dayKey(new Date(now.getFullYear(), now.getMonth(), 0));
  const TODAY = dayKey(now);
  const login = async (user) => {
    const response = await request('POST', '/api/auth/login', { body: { username: user.username, password: user.password }, token: null });
    expectStatus(response, 200, `${user.username} login`);
    return response.json.token;
  };
  const code = (codeValue) => { const option = ctx.options.find((row) => row.code === codeValue); if (!option) throw new Error(`no account ${codeValue}`); return option._id; };
  const manual = async (lines, extra = {}) => {
    const draft = await request('POST', '/api/accounting/manual-entries', { body: { date: TODAY, memo: 'Smoke entry', lines, ...extra } });
    expectStatus(draft, 201, 'POST manual draft');
    return draft.json;
  };

  await step('Stage 22: setup-owner and a cashier on a fresh database', async () => {
    const owner = await request('POST', '/api/auth/setup-owner', { body: OWNER, token: null });
    expectStatus(owner, 201, 'POST /api/auth/setup-owner');
    authToken = owner.json.token;
    const cashier = { name: 'S22 Cashier', username: 's22-cashier', password: 'clerk-pass-1', role: 'cashier' };
    expectStatus(await request('POST', '/api/users', { body: cashier }), 201, 'POST cashier');
    ctx.cashierToken = await login(cashier);
    return 'owner, cashier';
  });

  await step('Stage 22: last month = main cash 50,000, a cash sale 10 x 35, a credit sale 4 x 35, an expense 100 (utilities)', async () => {
    ctx.options = (await request('GET', '/api/accounting/manual-entries/accounts')).json.data;
    const category = await request('POST', '/api/categories', { body: { name: 'S22 Category' } });
    expectStatus(category, 201, 'POST /api/categories');
    const product = await request('POST', '/api/products', { body: { name: 'S22 Product', code: 'S22-1', categoryId: category.json._id, inventoryCount: 500, purchasePrice: 20, wholesalePrice: 30, retailPrice: 35 } });
    expectStatus(product, 201, 'POST /api/products');
    ctx.productId = product.json._id;
    const customer = await request('POST', '/api/customers', { body: { name: 'S22 Customer', phone: '01041414141' } });
    expectStatus(customer, 201, 'POST /api/customers');
    ctx.customerId = customer.json._id;
    expectStatus(await request('POST', '/api/accounting/opening', { body: { cash: 50000 } }), 200, 'POST /api/accounting/opening');
    const cash = await request('POST', '/api/sellings', { body: { customerName: 'S22 Cash', customerPhone: '01051515151', sellingDate: LAST15, items: [{ productId: ctx.productId, quantity: 10, price: 35 }] } });
    expectStatus(cash, 201, 'cash sale');
    ctx.cash = cash.json;
    const credit = await request('POST', '/api/credit-sales', { body: { customerId: ctx.customerId, sellingDate: LAST15, items: [{ productId: ctx.productId, quantity: 4, price: 35 }] } });
    expectStatus(credit, 201, 'credit sale');
    ctx.credit = credit.json;
    expectStatus(await request('POST', '/api/expenses', { body: { accountId: code('523'), amount: 100, date: LAST15 } }), 201, 'expense');
    return `${ctx.cash.number}, ${ctx.credit.number}, expense dated ${LAST15}`;
  });

  await step('Stage 22: the five reports return and balance (income statement net profit 110, balance sheet difference 0, trial balance balanced, box closing = box balance, party aging)', async () => {
    requireCtx(ctx, 'cash');
    const income = await request('GET', `/api/reports/income-statement?from=${LAST_START}&to=${LAST_END}`);
    expectStatus(income, 200, 'income statement');
    // sales 490 - COGS 280 - expenses 100
    expect(income.json.summary.sales === 490 && income.json.summary.cogs === 280 && income.json.summary.netProfit === 110, JSON.stringify(income.json.summary));
    expect(income.json.check.difference === 0, 'the net profit equals the ledger');
    const sheet = await request('GET', `/api/reports/balance-sheet?asOf=${TODAY}`);
    expectStatus(sheet, 200, 'balance sheet');
    expect(sheet.json.check.difference === 0 && sheet.json.periodProfit === 110, JSON.stringify({ check: sheet.json.check, profit: sheet.json.periodProfit }));
    const trial = await request('GET', `/api/reports/trial-balance?from=${LAST_START}&to=${TODAY}`);
    expectStatus(trial, 200, 'trial balance');
    expect(trial.json.balanced === true, 'the trial balance totals balance');
    const boxes = await request('GET', `/api/reports/box-movements?from=${LAST_START}&to=${TODAY}`);
    expectStatus(boxes, 200, 'box movements');
    for (const box of boxes.json.boxes) {
      const ledger = await request('GET', `/api/cashbox/boxes/${box.boxId}`);
      expect(ledger.json.balance === box.closing, `box ${box.name}: ${box.closing} vs ${ledger.json.balance}`);
    }
    const parties = await request('GET', '/api/reports/party-balances');
    expectStatus(parties, 200, 'party balances');
    const row = parties.json.customers.rows.find((entry) => entry.partyId === ctx.customerId);
    expect(row && row.balance === 140 && row.aging.total === 140, JSON.stringify(row));
    return `net profit ${income.json.summary.netProfit}, assets ${sheet.json.totals.assets} = ${sheet.json.totals.liabilitiesAndEquity}, customer aging ${row.aging.total}`;
  });

  await step('Stage 22: an Excel export downloads (.xlsx, numbers as numbers)', async () => {
    const file = await request('GET', `/api/reports/income-statement?from=${LAST_START}&to=${LAST_END}&format=xlsx`, { binary: true });
    expectStatus(file, 200, 'income statement xlsx');
    expect(String(file.headers.get('content-type')).includes('spreadsheetml'), file.headers.get('content-type'));
    expect(file.buffer.length > 1000 && file.buffer.subarray(0, 2).toString() === 'PK', 'a zip (xlsx) body');
    return `${file.buffer.length} bytes`;
  });

  await step('Stage 22: a manual draft is saved, edited, posted (JE number) and reversed (linked)', async () => {
    const draft = await manual([{ accountId: code('523'), debit: 50 }, { accountId: code('23'), credit: 40 }]);
    const edited = await request('PUT', `/api/accounting/manual-entries/${draft._id}`, { body: { lines: [{ accountId: code('523'), debit: 50 }, { accountId: code('23'), credit: 50 }] } });
    expectStatus(edited, 200, 'PUT draft');
    const posted = await request('POST', `/api/accounting/manual-entries/${draft._id}/post`);
    expectStatus(posted, 200, 'post');
    expect(/^JE-\d+$/.test(posted.json.number) && posted.json.status === 'posted', JSON.stringify(posted.json).slice(0, 200));
    expectStatus(await request('PUT', `/api/accounting/manual-entries/${draft._id}`, { body: { memo: 'x' } }), 409, 'a posted entry is not edited');
    const reversed = await request('POST', `/api/accounting/manual-entries/${draft._id}/reverse`, { body: { reason: 'Smoke reversal' } });
    expectStatus(reversed, 200, 'reverse');
    expect(reversed.json.reversal && /^JE-\d+$/.test(reversed.json.reversal.number), JSON.stringify(reversed.json.reversal));
    expectStatus(await request('POST', `/api/accounting/manual-entries/${draft._id}/reverse`, { body: { reason: 'Again' } }), 409, 'reversed twice');
    return `${posted.json.number} reversed by ${reversed.json.reversal.number}`;
  });

  await step('Stage 22: a forbidden account is refused (400): a box, inventory, an invoice account; a customer debit too', async () => {
    const attempt = async (lines) => {
      const draft = await manual(lines);
      return request('POST', `/api/accounting/manual-entries/${draft._id}/post`);
    };
    const balanced = (accountId) => [{ accountId, debit: 10 }, { accountId: code('31'), credit: 10 }];
    const box = await attempt(balanced(code('1111')));
    expectStatus(box, 400, 'box account');
    expect(box.json.reason === 'BOX_ACCOUNT' && box.json.message.includes('استخدم شاشة الخزائن أو المصروفات'), describe(box));
    const inventory = await attempt(balanced(code('114')));
    expectStatus(inventory, 400, 'inventory');
    expect(inventory.json.message.includes('استخدم تعديل الصنف'), describe(inventory));
    const sales = await attempt(balanced(code('410')));
    expectStatus(sales, 400, 'sales account');
    expect(sales.json.message.includes('الحساب ده بيتحرك من الفواتير'), describe(sales));
    const debit = await attempt([{ accountId: code('113'), debit: 10, partyType: 'customer', partyId: ctx.customerId }, { accountId: code('31'), credit: 10 }]);
    expectStatus(debit, 400, 'customer debit');
    expect(debit.json.message === 'اعمل فاتورة آجل بدل القيد اليدوي', describe(debit));
    return 'box, inventory, sales, customer debit: 400';
  });

  await step('Stage 22: a bad debt: a manual credit on the customer settles the open invoice, the statement shows one line, health stays 0', async () => {
    requireCtx(ctx, 'credit');
    const draft = await manual([{ accountId: code('525'), debit: 140 }, { accountId: code('113'), credit: 140, partyType: 'customer', partyId: ctx.customerId }], { memo: 'Smoke bad debt' });
    const posted = await request('POST', `/api/accounting/manual-entries/${draft._id}/post`);
    expectStatus(posted, 200, 'post bad debt');
    const invoice = await request('GET', `/api/credit-sales/${ctx.credit._id}`);
    expect(invoice.json.remainingAmount === 0 && invoice.json.status === 'paid', JSON.stringify({ remaining: invoice.json.remainingAmount, status: invoice.json.status }));
    const statement = await request('GET', `/api/customers/${ctx.customerId}/statement`);
    const lines = statement.json.lines.filter((line) => line.type === 'manual');
    expect(lines.length === 1 && lines[0].credit === 140 && statement.json.totals.balance === 0, JSON.stringify(statement.json.totals));
    const health = await request('GET', '/api/accounting/health');
    expect(health.json.customers.difference === 0, JSON.stringify(health.json.customers));
    return `${posted.json.number}: invoice ${invoice.json.number} paid, balance 0`;
  });

  await step('Stage 22: accounts: a new leaf under 520 gets 52001, becomes an expense category and shows in the income statement; a system account is renamed', async () => {
    const parent = (await request('GET', '/api/accounting/accounts')).json.accounts;
    const flat = []; const walk = (rows) => rows.forEach((row) => { flat.push(row); walk(row.children || []); }); walk(parent);
    const group = flat.find((row) => row.code === '520');
    const created = await request('POST', '/api/accounting/accounts', { body: { parentId: group._id, nameAr: 'صيانة المحل', nameEn: 'Maintenance' } });
    expectStatus(created, 201, 'create account');
    expect(created.json.code === '52001' && created.json.type === 'expense', JSON.stringify(created.json));
    const categories = await request('GET', '/api/expenses/categories');
    expect(categories.json.data.some((row) => row.code === '52001'), 'the new account is an expense category');
    expectStatus(await request('POST', '/api/expenses', { body: { accountId: created.json._id, amount: 25, date: TODAY } }), 201, 'expense in the new category');
    const income = await request('GET', `/api/reports/income-statement?from=${TODAY}&to=${TODAY}`);
    const find = (rows) => rows.flatMap((row) => [row, ...(row.children ? find(row.children) : [])]);
    expect(find(income.json.rows).some((row) => row.code === '52001' && row.amount === 25), 'the income statement shows the new account');
    const sales = flat.find((row) => row.code === '410');
    const renamed = await request('PUT', `/api/accounting/accounts/${sales._id}`, { body: { nameAr: 'مبيعات البضاعة' } });
    expectStatus(renamed, 200, 'rename a system account');
    expectStatus(await request('POST', '/api/accounting/accounts', { body: { parentId: flat.find((row) => row.code === '111')._id, nameAr: 'x' } }), 400, 'no accounts under the box branch');
    return `52001 created, 410 renamed to ${renamed.json.nameAr}`;
  });

  await step('Stage 22: a cashier gets 403 on the reports, manual entries and closing', async () => {
    const token = ctx.cashierToken;
    expectStatus(await request('GET', '/api/reports/income-statement', { token }), 403, 'cashier report');
    expectStatus(await request('GET', '/api/reports/party-balances', { token }), 403, 'cashier party balances');
    expectStatus(await request('POST', '/api/accounting/manual-entries', { token, body: { date: TODAY, memo: 'x', lines: [] } }), 403, 'cashier manual entry');
    expectStatus(await request('POST', '/api/accounting/closing/close', { token, body: { confirm: true } }), 403, 'cashier close');
    expectStatus(await request('GET', '/api/accounting/lock-date', { token }), 200, 'every signed-in user reads the lock date');
    return '403, 403, 403, 403; lock date readable';
  });

  await step('Stage 22: close last month: PERIOD_LOCKED on a back-dated sale, a return on a locked invoice still works (dated today), then reopen', async () => {
    requireCtx(ctx, 'cash');
    expectStatus(await request('POST', '/api/accounting/opening/finalize', { body: { confirm: true } }), 200, 'finalize the opening');
    const state = await request('GET', '/api/accounting/closing');
    expect(state.json.next.end === LAST_END && state.json.checklist.canClose === true, JSON.stringify({ next: state.json.next, blocking: state.json.checklist.blocking.filter((item) => !item.ok) }));
    const closed = await request('POST', '/api/accounting/closing/close', { body: { confirm: true, periodEnd: LAST_END } });
    expectStatus(closed, 200, 'close last month');
    expect(closed.json.lockedThrough === LAST_END, JSON.stringify(closed.json));
    const lockDate = await request('GET', '/api/accounting/lock-date');
    expect(lockDate.json.lockedThrough === LAST_END, JSON.stringify(lockDate.json));
    const locked = await request('POST', '/api/sellings', { body: { customerName: 'late', customerPhone: '01061616161', sellingDate: LAST15, items: [{ productId: ctx.productId, quantity: 1, price: 35 }] } });
    expectStatus(locked, 409, 'a sale into the closed month');
    expect(locked.json.code === 'PERIOD_LOCKED' && locked.json.message.includes(LAST_END.split('-').reverse().join('/')), describe(locked));
    const edit = await request('PUT', `/api/sellings/${ctx.cash._id}`, { body: { customerName: 'edited' } });
    expectStatus(edit, 409, 'editing a locked invoice');
    const returned = await request('POST', '/api/returns', { body: { returnType: 'cash', invoiceId: ctx.cash._id, items: [{ productId: ctx.productId, quantity: 1, returnReason: 'after the close' }] } });
    expectStatus(returned, 201, 'a return on a locked invoice');
    const health = await request('GET', '/api/accounting/health');
    for (const [name, check] of Object.entries(health.json).filter(([, value]) => value && typeof value === 'object' && 'difference' in value)) expect(Number(check.difference) === 0 && check.ok !== false, `health ${name}: ${JSON.stringify(check)}`);
    const reopened = await request('POST', '/api/accounting/closing/reopen', { body: { confirm: true, reason: 'Smoke reopen' } });
    expectStatus(reopened, 200, 'reopen');
    expect(reopened.json.lockedThrough === null, JSON.stringify(reopened.json));
    expectStatus(await request('POST', '/api/sellings', { body: { customerName: 'late', customerPhone: '01061616161', sellingDate: LAST15, items: [{ productId: ctx.productId, quantity: 1, price: 35 }] } }), 201, 'back-dating works after the reopen');
    return `locked through ${LAST_END}: sale 409, edit 409, return ${returned.json.data ? returned.json.data.returnLog.number : 'ok'} ok; reopened`;
  });

  await step('Stage 22: accounting health printed and every check is 0 (including closing)', async () => {
    const health = await request('GET', '/api/accounting/health');
    expectStatus(health, 200, 'GET /api/accounting/health');
    const rows = Object.entries(health.json).filter(([, check]) => check && typeof check === 'object' && 'difference' in check);
    for (const [name, check] of rows) expect(Number(check.difference) === 0 && check.ok !== false, `health ${name}: ${JSON.stringify(check)}`);
    expect('closing' in health.json && health.json.closing.difference === 0, 'the closing check exists and is 0');
    return rows.map(([name, check]) => `${name}=${check.difference}`).join(', ');
  });
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
    const authBackend = await startBackend({ auth: true });
    await runScenarios();
    // The switch: the same backend with NOTA_AUTH unset, on a fresh database of the same mongod.
    await stopChild(authBackend);
    children.splice(children.indexOf(authBackend), 1);
    const noAuthBackend = await startBackend({ auth: false, dbName: NOAUTH_DB_NAME });
    await runAuthOffCheck();
    // Stage 18: the opening-balance wizard, on its own fresh database with auth on.
    await stopChild(noAuthBackend);
    children.splice(children.indexOf(noAuthBackend), 1);
    const openingBackend = await startBackend({ auth: true, dbName: OPENING_DB_NAME });
    await runOpeningScenarios();
    // Stage 19: cash boxes, shifts, transfers, expenses, owner drawings and customer credit, on its own fresh database.
    await stopChild(openingBackend);
    children.splice(children.indexOf(openingBackend), 1);
    const stage19Backend = await startBackend({ auth: true, dbName: STAGE19_DB_NAME });
    await runStage19Scenarios();
    // Stage 20: purchases, supplier payments, returns, cancel and the statement, on its own fresh database.
    await stopChild(stage19Backend);
    children.splice(children.indexOf(stage19Backend), 1);
    const stage20Backend = await startBackend({ auth: true, dbName: STAGE20_DB_NAME });
    await runStage20Scenarios();
    // Stage 21: VAT: settings, sales, returns, purchases, expenses, the monthly return and its payment, on its own fresh database.
    await stopChild(stage20Backend);
    children.splice(children.indexOf(stage20Backend), 1);
    const stage21Backend = await startBackend({ auth: true, dbName: STAGE21_DB_NAME });
    await runStage21Scenarios();
    // Stage 22: reports, manual entries, accounts and period closing, on its own fresh database.
    await stopChild(stage21Backend);
    children.splice(children.indexOf(stage21Backend), 1);
    await startBackend({ auth: true, dbName: STAGE22_DB_NAME });
    await runStage22Scenarios();
  } catch (error) {
    record(false, 'Smoke test setup', error.message);
  } finally {
    await cleanup();
  }

  process.exit(summarize() > 0 ? 1 : 0);
}

main();
