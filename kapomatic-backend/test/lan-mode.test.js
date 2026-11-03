process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const {
  LAN_KEY_INVALID_CODE,
  createLanSecretGuard,
  isLanMode,
} = require("../src/middlewares/lanSecret.middleware");
const { createGracefulShutdown } = require("../src/utils/gracefulShutdown");

const APP_PATH = path.join(__dirname, "..", "src", "app.js");
const LAN_SECRET = "7KQ4-MZ8P-W2RT";
const LAN_ENV_KEYS = [
  "KAPOMATIC_LAN_MODE",
  "KAPOMATIC_LAN_SECRET",
  "KAPOMATIC_APP_VERSION",
  "KAPOMATIC_INSTANCE_ID",
];

const savedEnv = Object.fromEntries(LAN_ENV_KEYS.map((key) => [key, process.env[key]]));

// Each test sets its own LAN variables; put the original values back afterwards.
test.afterEach(() => {
  LAN_ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
});

// app.js reads the LAN variables once at load time, so each mode gets a fresh copy.
const loadApp = (env = {}) => {
  LAN_ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  delete require.cache[APP_PATH];
  return require(APP_PATH);
};

const withServer = async (app, callback) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const lanEnv = {
  KAPOMATIC_LAN_MODE: "1",
  KAPOMATIC_LAN_SECRET: LAN_SECRET,
  KAPOMATIC_APP_VERSION: "1.2.3",
  KAPOMATIC_INSTANCE_ID: "main-pc-instance",
};

test("isLanMode is on only for the exact value 1", () => {
  assert.equal(isLanMode({}), false);
  assert.equal(isLanMode({ KAPOMATIC_LAN_MODE: "" }), false);
  assert.equal(isLanMode({ KAPOMATIC_LAN_MODE: "true" }), false);
  assert.equal(isLanMode({ KAPOMATIC_LAN_MODE: "1" }), true);
});

test("LAN guard refuses to start without a usable secret", () => {
  assert.throws(() => createLanSecretGuard(undefined), /KAPOMATIC_LAN_SECRET/);
  assert.throws(() => createLanSecretGuard("   "), /KAPOMATIC_LAN_SECRET/);
  assert.throws(() => createLanSecretGuard("short"), /at least 8/);
  assert.throws(() => loadApp({ KAPOMATIC_LAN_MODE: "1" }), /KAPOMATIC_LAN_SECRET/);
});

test("online mode: no LAN secret is required and LAN routes are not mounted", async () => {
  const app = loadApp();

  await withServer(app, async (baseUrl) => {
    const unknown = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(unknown.status, 404);

    const lanInfo = await fetch(`${baseUrl}/api/lan/info`);
    assert.equal(lanInfo.status, 404);

    // Push notifications were removed; the old route is gone in every mode.
    const notifications = await fetch(`${baseUrl}/api/notifications/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "abc" }),
    });
    assert.equal(notifications.status, 404);
  });
});

test("LAN mode: requests without the right secret are rejected with 401", async () => {
  const app = loadApp(lanEnv);

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/lan/info`);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), {
      message: "كلمة سر الشبكة غير صحيحة",
      code: LAN_KEY_INVALID_CODE,
    });

    const wrong = await fetch(`${baseUrl}/api/categories`, {
      headers: { "X-Kapomatic-Lan-Key": "WRONG-SECRET-1" },
    });
    assert.equal(wrong.status, 401);

    // Any /api path is guarded, including ones that do not exist.
    const unknown = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(unknown.status, 401);
  });
});

test("LAN mode: the right secret reaches the routes", async () => {
  const app = loadApp(lanEnv);

  await withServer(app, async (baseUrl) => {
    // Surrounding whitespace in the header is tolerated.
    const response = await fetch(`${baseUrl}/api/lan/info`, {
      headers: { "X-Kapomatic-Lan-Key": ` ${LAN_SECRET} ` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = await response.json();
    assert.equal(body.app, "kapomatic-backend");
    assert.equal(body.lanMode, true);
    assert.equal(body.appVersion, "1.2.3");
    assert.equal(body.instanceId, "main-pc-instance");
    assert.equal(typeof body.backendVersion, "string");
    assert.ok(!Number.isNaN(Date.parse(body.serverTime)));

    const unknown = await fetch(`${baseUrl}/api/does-not-exist`, {
      headers: { "X-Kapomatic-Lan-Key": LAN_SECRET },
    });
    assert.equal(unknown.status, 404);
  });
});

test("LAN mode: CORS preflight passes and notifications are not mounted", async () => {
  const app = loadApp(lanEnv);

  await withServer(app, async (baseUrl) => {
    const preflight = await fetch(`${baseUrl}/api/lan/info`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-kapomatic-lan-key",
      },
    });
    assert.equal(preflight.status, 204);

    const notifications = await fetch(`${baseUrl}/api/notifications/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kapomatic-Lan-Key": LAN_SECRET },
      body: JSON.stringify({ token: "abc" }),
    });
    assert.equal(notifications.status, 404);
  });
});

const silentLog = { log() {}, warn() {}, error() {} };

const startSlowServer = async (delayMs) => {
  const server = http.createServer((req, res) => {
    setTimeout(() => res.end("done"), delayMs);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
};

test("graceful shutdown lets in-flight requests finish, then disconnects and exits 0", async () => {
  const { server, url } = await startSlowServer(150);
  const events = [];
  const shutdown = createGracefulShutdown({
    server,
    disconnect: async () => events.push("disconnect"),
    exit: (code) => events.push(`exit:${code}`),
    log: silentLog,
  });

  const inFlight = fetch(url).then((response) => response.text());
  await new Promise((resolve) => setTimeout(resolve, 30));

  const startedAt = Date.now();
  const first = shutdown();
  assert.equal(shutdown(), first, "repeated shutdown calls share one run");

  assert.equal(await inFlight, "done");
  await first;
  assert.ok(Date.now() - startedAt < 1000, "did not wait for the keep-alive timeout");
  assert.deepEqual(events, ["disconnect", "exit:0"]);
  assert.equal(server.listening, false);
});

test("graceful shutdown force-closes requests that outlive the timeout", async () => {
  const { server, url } = await startSlowServer(5000);
  const events = [];
  const shutdown = createGracefulShutdown({
    server,
    disconnect: async () => events.push("disconnect"),
    exit: (code) => events.push(`exit:${code}`),
    timeoutMs: 50,
    log: silentLog,
  });

  const inFlight = fetch(url).then(
    () => "completed",
    () => "aborted"
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  const startedAt = Date.now();
  await shutdown();
  assert.ok(Date.now() - startedAt < 2000, "did not wait for the slow request");
  assert.equal(await inFlight, "aborted");
  assert.deepEqual(events, ["disconnect", "exit:0"]);
});

test("graceful shutdown exits 1 when MongoDB disconnect fails", async () => {
  const { server } = await startSlowServer(0);
  const exits = [];
  const shutdown = createGracefulShutdown({
    server,
    disconnect: async () => {
      throw new Error("boom");
    },
    exit: (code) => exits.push(code),
    log: silentLog,
  });

  await shutdown();
  assert.deepEqual(exits, [1]);
});
