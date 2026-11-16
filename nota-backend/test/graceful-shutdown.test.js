// Graceful shutdown (restored from main, where it lived in lan-mode.test.js) plus the signal wiring the
// online server uses: SIGTERM from systemd must let an in-flight request finish with its normal response.
process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createGracefulShutdown, registerShutdownSignals } = require("../src/utils/gracefulShutdown");

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

// A real SIGTERM cannot be sent portably (on Windows it kills the process with no handler), so the signal is
// emitted on a stand-in process object: the same registration server.js does with the real `process`.
for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} during an in-flight request: the request finishes with its normal response, then exit 0`, async () => {
    const { server, url } = await startSlowServer(200);
    const events = [];
    const fakeProcess = new EventEmitter();
    registerShutdownSignals(
      createGracefulShutdown({
        server,
        disconnect: async () => events.push("disconnect"),
        exit: (code) => events.push(`exit:${code}`),
        log: silentLog,
      }),
      { proc: fakeProcess }
    );

    const inFlight = fetch(url).then(async (response) => ({ status: response.status, body: await response.text() }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    fakeProcess.emit(signal);
    fakeProcess.emit(signal); // systemd and a second Ctrl+C: still one shutdown

    assert.deepEqual(await inFlight, { status: 200, body: "done" });
    for (let waited = 0; !events.includes("exit:0") && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(events, ["disconnect", "exit:0"]);

    // New connections are refused once the shutdown started.
    await assert.rejects(fetch(url));
  });
}

test("server.js registers the shutdown on SIGTERM and SIGINT and the unit file waits long enough", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  assert.match(source, /registerShutdownSignals\(createGracefulShutdown\(\{ server, disconnect: \(\) => mongoose\.disconnect\(\) \}\)\)/);
  const registered = [];
  registerShutdownSignals(() => {}, { proc: { on: (signal) => registered.push(signal) } });
  assert.deepEqual(registered, ["SIGTERM", "SIGINT"]);
  const unit = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "templates", "nota-backend.service"), "utf8");
  assert.match(unit, /^TimeoutStopSec=20$/m);
});
