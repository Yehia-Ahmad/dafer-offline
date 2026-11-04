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
  "NOTA_LAN_MODE",
  "NOTA_LAN_SECRET",
  "NOTA_APP_VERSION",
  "NOTA_INSTANCE_ID",
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
  NOTA_LAN_MODE: "1",
  NOTA_LAN_SECRET: LAN_SECRET,
  NOTA_APP_VERSION: "1.2.3",
  NOTA_INSTANCE_ID: "main-pc-instance",
};

test("isLanMode is on only for the exact value 1", () => {
  assert.equal(isLanMode({}), false);
  assert.equal(isLanMode({ NOTA_LAN_MODE: "" }), false);
  assert.equal(isLanMode({ NOTA_LAN_MODE: "true" }), false);
  assert.equal(isLanMode({ NOTA_LAN_MODE: "1" }), true);
});

test("LAN guard refuses to start without a usable secret", () => {
  assert.throws(() => createLanSecretGuard(undefined), /NOTA_LAN_SECRET/);
  assert.throws(() => createLanSecretGuard("   "), /NOTA_LAN_SECRET/);
  assert.throws(() => createLanSecretGuard("short"), /at least 8/);
  assert.throws(() => loadApp({ NOTA_LAN_MODE: "1" }), /NOTA_LAN_SECRET/);
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
      headers: { "X-Nota-Lan-Key": "WRONG-SECRET-1" },
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
      headers: { "X-Nota-Lan-Key": ` ${LAN_SECRET} ` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = await response.json();
    assert.equal(body.app, "nota-backend");
    assert.equal(body.lanMode, true);
    assert.equal(body.appVersion, "1.2.3");
    assert.equal(body.instanceId, "main-pc-instance");
    assert.equal(typeof body.backendVersion, "string");
    assert.ok(!Number.isNaN(Date.parse(body.serverTime)));

    const unknown = await fetch(`${baseUrl}/api/does-not-exist`, {
      headers: { "X-Nota-Lan-Key": LAN_SECRET },
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
        "Access-Control-Request-Headers": "x-nota-lan-key",
      },
    });
    assert.equal(preflight.status, 204);

    const notifications = await fetch(`${baseUrl}/api/notifications/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nota-Lan-Key": LAN_SECRET },
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

// db.js: LAN mode never falls back to 127.0.0.1:27017, which may be another MongoDB on the PC.
const { resolveMongoUri, DEFAULT_MONGO_URI } = require("../src/config/db");

test("MONGO_URI rule: LAN mode requires it, online mode keeps the local default", () => {
  assert.deepEqual(resolveMongoUri({ MONGO_URI: "mongodb://127.0.0.1:27217/nota" }), { uri: "mongodb://127.0.0.1:27217/nota" });
  assert.deepEqual(
    resolveMongoUri({ NOTA_LAN_MODE: "1", MONGO_URI: "mongodb://127.0.0.1:27217/nota" }),
    { uri: "mongodb://127.0.0.1:27217/nota" }
  );
  assert.deepEqual(resolveMongoUri({}), { uri: DEFAULT_MONGO_URI, usedDefault: true });
  const lan = resolveMongoUri({ NOTA_LAN_MODE: "1" });
  assert.equal(lan.uri, undefined, "no URI is guessed in LAN mode");
  assert.match(lan.error, /MONGO_URI/);
  assert.match(lan.error, /NOTA_LAN_MODE=1/);
  assert.equal(resolveMongoUri({ NOTA_LAN_MODE: "1", MONGO_URI: "" }).uri, undefined, "an empty MONGO_URI counts as missing");
});

test("LAN mode without MONGO_URI: the server exits 1 with a clear log line and never listens", async () => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nota-no-uri-")); // no .env here
  const env = { ...process.env, NOTA_LAN_MODE: "1", NOTA_LAN_SECRET: LAN_SECRET, PORT: "0", NOTA_LISTEN_HOST: "127.0.0.1" };
  delete env.MONGO_URI;
  delete env.NODE_ENV;
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], { cwd, env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not exit; output: ${output}`)); }, 20000);
      child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 1);
    assert.match(output, /MONGO_URI غير موجود في وضع الشبكة المحلية \(NOTA_LAN_MODE=1\)/);
    assert.doesNotMatch(output, /Server started|MongoDB connected/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
