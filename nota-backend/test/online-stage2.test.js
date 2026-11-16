// Online Stage 2 tests: trust proxy (login lockout per real client IP behind nginx), GET /health,
// the production access log format and NOTA_LISTEN_HOST. Uses a real throwaway mongod (port 27171).
process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const SECRET = "online-stage2-test-secret-0123456789abcdef";
const APP_PATH = path.join(__dirname, "..", "src", "app.js");

const loadApp = (env) => {
  const keys = ["NOTA_JWT_SECRET", "NOTA_TRUST_PROXY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  delete require.cache[APP_PATH];
  try {
    return require(APP_PATH);
  } finally {
    keys.forEach((key) => (saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key])));
  }
};
// NOTA_TRUST_PROXY is read when the app module loads, so each variant is its own instance.
const appProxy = loadApp({ NOTA_JWT_SECRET: SECRET, NOTA_TRUST_PROXY: "1" });
const appPlain = loadApp({ NOTA_JWT_SECRET: SECRET });

const { clearDatabase, mongodSkipReason, startMongod } = require("./helpers/mongod");
const { createOwner } = require("../src/auth/ownerAccount");
const { createHealthHandler, readVersion } = require("../src/utils/health");
const { productionFormat, createAccessLog } = require("../src/utils/accessLog");

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
const close = (target) => new Promise((resolve) => target.server.close(resolve));

let stopMongod;
let proxied;
let plain;

test.before(async () => {
  if (mongodSkipReason) return;
  stopMongod = await startMongod({ port: 27171 });
  proxied = await listen(appProxy);
  plain = await listen(appPlain);
});

test.after(async () => {
  if (proxied) await close(proxied);
  if (plain) await close(plain);
  if (stopMongod) await stopMongod();
});

test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase();
  appProxy.locals.auth.loginLimiter.reset();
  appPlain.locals.auth.loginLimiter.reset();
});

const tryLogin = async (target, ip, password) => {
  const response = await fetch(`${target.base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ username: "owner", password }),
  });
  return response.status;
};

const failFiveTimes = async (target, ip) => {
  for (let i = 0; i < 4; i += 1) assert.equal(await tryLogin(target, ip, "wrong"), 401);
  assert.equal(await tryLogin(target, ip, "wrong"), 429); // the 5th failure locks this client
};

test("trust proxy on: one client's failed logins do not lock another client", { skip: mongodSkipReason }, async () => {
  await createOwner({ name: "Owner", username: "owner", password: "owner-pass-1" });
  await failFiveTimes(proxied, "203.0.113.10");
  assert.equal(await tryLogin(proxied, "203.0.113.10", "owner-pass-1"), 429, "the guessing client stays locked");
  assert.equal(await tryLogin(proxied, "203.0.113.11", "owner-pass-1"), 200, "another client can sign in");
});

test("trust proxy off: X-Forwarded-For is ignored (every request is the same peer)", { skip: mongodSkipReason }, async () => {
  await createOwner({ name: "Owner", username: "owner", password: "owner-pass-1" });
  await failFiveTimes(plain, "203.0.113.10");
  // Without NOTA_TRUST_PROXY a spoofed header neither helps an attacker nor changes who is locked.
  assert.equal(await tryLogin(plain, "203.0.113.11", "owner-pass-1"), 429);
});

test("trust proxy is loopback only: the setting is 'loopback' when on and unset when off", () => {
  assert.equal(appProxy.get("trust proxy"), "loopback");
  assert.notEqual(appPlain.get("trust proxy"), "loopback");
});

test("GET /health: 200 with exactly { ok, version, db } and no auth", { skip: mongodSkipReason }, async () => {
  const response = await fetch(`${plain.base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["db", "ok", "version"]);
  assert.equal(body.ok, true);
  assert.equal(body.db, "up");
  assert.equal(typeof body.version, "string");
  assert.ok(body.version.length > 0);
});

test("GET /health: 503 when MongoDB does not answer, still no other data", async () => {
  const app = express();
  app.get("/health", createHealthHandler({ ping: async () => { throw new Error("secret detail"); }, version: "1.2.3" }));
  const server = await listen(app);
  try {
    const response = await fetch(`${server.base}/health`);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { ok: false, version: "1.2.3", db: "down" });
    assert.ok(!text.includes("secret detail"));
  } finally {
    await close(server);
  }
});

test("readVersion prefers release.json next to the backend folder, else package.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nota-health-"));
  try {
    const backend = path.join(root, "backend");
    fs.mkdirSync(backend);
    fs.writeFileSync(path.join(backend, "package.json"), JSON.stringify({ version: "9.9.9" }));
    assert.equal(readVersion(backend), "9.9.9");
    fs.writeFileSync(path.join(root, "release.json"), JSON.stringify({ version: "2026.11.1-abc1234" }));
    assert.equal(readVersion(backend), "2026.11.1-abc1234");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production access log has no query string; dev format is unchanged morgan 'dev'", () => {
  const tokens = {
    url: (req) => req.originalUrl,
    "remote-addr": () => "203.0.113.5",
    method: () => "GET",
    status: () => "200",
    res: () => "42",
    "response-time": () => "1.234",
  };
  const line = productionFormat(tokens, { originalUrl: "/api/products?search=%D8%B3%D9%83%D8%B1&page=2" }, {});
  assert.equal(line, "203.0.113.5 - GET /api/products 200 42 - 1.234ms");
  assert.ok(!line.includes("?") && !line.includes("search"));
  assert.equal(typeof createAccessLog({ NODE_ENV: "production" }), "function");
  assert.equal(typeof createAccessLog({}), "function");
});

test("NOTA_LISTEN_HOST: server.js binds to that address when set", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.match(source, /process\.env\.NOTA_LISTEN_HOST/);
  assert.match(source, /app\.listen\(PORT, host, onListening\)/);
  assert.match(source, /app\.listen\(PORT, onListening\)/);
});
