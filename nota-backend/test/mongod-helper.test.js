// The throwaway-mongod helper must never leave a database server running, even when the test process is hard-killed (a
// runner timeout, Ctrl+C, taskkill), must refuse a port that something else already holds, and must sweep stale folders.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { startMongod, mongodSkipReason, sweepStaleTempDirs } = require("./helpers/mongod");

const KILL_PORT = 27199;
const BUSY_PORT = 27198;
const TAG = `hk${process.pid}-`; // only this test's folders carry it, so parallel test files never interfere
const tempDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("nota-test-mongo-")));
const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => { socket.destroy(); resolve(false); });
});
const until = async (condition, ms, message) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
const removeOwnFolders = () => {
  for (const name of fs.readdirSync(os.tmpdir())) if (name.startsWith(`nota-test-mongo-${TAG}`)) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
};

test("a hard-killed test process leaves no mongod running", { skip: mongodSkipReason, timeout: 120000 }, async () => {
  const script = `require(${JSON.stringify(path.join(__dirname, "helpers", "mongod.js"))}).startMongod({ port: ${KILL_PORT}, tag: ${JSON.stringify(TAG)} }).then(() => console.log("READY"), (error) => { console.error(error); process.exit(1); });`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  try {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    await until(() => output.includes("READY"), 90000, "the helper never became ready");
    assert.equal(await portOpen(KILL_PORT), true);
    child.kill(); // hard kill: on Windows no exit handler runs in the child
    await until(async () => !(await portOpen(KILL_PORT)), 30000, "mongod kept running after its test process was killed");
  } finally {
    child.kill(); // never leave the child behind, even when an assertion fails (it would keep the test runner waiting)
    // If the whole process tree was killed nothing could delete the folder; the next start's sweep covers that.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    removeOwnFolders();
  }
});

test("stale nota-test-mongo folders are swept; fresh ones and other names are left alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nota-sweep-root-"));
  try {
    for (const name of ["nota-test-mongo-old", "nota-test-mongo-new", "something-else-old"]) fs.mkdirSync(path.join(root, name));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(root, "nota-test-mongo-old"), twoHoursAgo, twoHoursAgo);
    fs.utimesSync(path.join(root, "something-else-old"), twoHoursAgo, twoHoursAgo);
    assert.deepEqual(sweepStaleTempDirs({ root }), ["nota-test-mongo-old"]);
    assert.deepEqual(fs.readdirSync(root).sort(), ["nota-test-mongo-new", "something-else-old"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a busy port is refused up front and nothing is left behind", async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(BUSY_PORT, "127.0.0.1", resolve));
  const before = tempDirs();
  try {
    await assert.rejects(startMongod({ port: BUSY_PORT, tag: TAG }), /already in use/);
    assert.deepEqual([...tempDirs()].filter((name) => !before.has(name) && name.startsWith(`nota-test-mongo-${TAG}`)), []);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});
