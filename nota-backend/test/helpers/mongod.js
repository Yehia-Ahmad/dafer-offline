// Throwaway mongod for tests that need a real database (Stage 12: aggregations).
// Binary: NOTA_TEST_MONGOD, else the bundled ../nota-frontend/vendor/mongodb/bin/mongod(.exe).
// Port 27098 by default (Stage 13 tests use 27097), fresh dbpath under the OS temp folder,
// removed afterwards. Never touches 27017.
// When no binary exists the caller skips its tests (see `mongodSkipReason`).
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mongoose = require("mongoose");

const PORT = 27098;
const DB_NAME = "nota_test";
const REPLICA_SET = "rs0";

const candidate = () =>
  process.env.NOTA_TEST_MONGOD ||
  path.resolve(__dirname, "..", "..", "..", "nota-frontend", "vendor", "mongodb", "bin",
    process.platform === "win32" ? "mongod.exe" : "mongod");

const mongodPath = candidate();
const mongodSkipReason = fs.existsSync(mongodPath)
  ? false
  : `no mongod (set NOTA_TEST_MONGOD or run "npm run offline:vendor" in nota-frontend); looked for ${mongodPath}`;

const isPortOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });

/**
 * Removes `nota-test-mongo-*` folders older than `maxAgeMs` in the OS temp folder: what a hard-killed test run (a runner
 * timeout, taskkill /T) leaves behind, because nothing can run cleanup then. Only that exact name pattern; the default age
 * is far longer than any test file takes, so a folder of a test file running in parallel is never touched.
 */
function sweepStaleTempDirs({ maxAgeMs = 60 * 60 * 1000, root = os.tmpdir() } = {}) {
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith("nota-test-mongo-")) continue;
    const full = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch { /* in use or already gone */ }
  }
  return removed;
}

// Test files run in parallel processes: each file that needs a database passes its own port.
async function startMongod({ port = PORT, tag = "", license } = {}) {
  sweepStaleTempDirs();
  // A leftover server on this port (an interrupted earlier run) must never be mistaken for ours: its data would leak in.
  if (await isPortOpen(port)) throw new Error(`port ${port} is already in use (a leftover test mongod?); stop it and re-run`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nota-test-mongo-${tag}`));
  const dbPath = path.join(dir, "db");
  fs.mkdirSync(dbPath);
  // The guard owns mongod and stops it (and deletes `dir`) when its stdin closes: stop(), a failed start, the runner's
  // timeout, SIGINT, or a hard kill of this process.
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "scripts", "throwaway-mongod-guard.js"), dir, mongodPath,
    "--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--replSet", REPLICA_SET,
    "--logpath", path.join(dir, "mongod.log"), "--wiredTigerCacheSizeGB", "0.25"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  const release = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    try { child.stdin.end(); } catch { /* already closed */ }
  });
  try {
    return await boot({ port, child, dir, license });
  } catch (error) {
    await release();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function boot({ port, child, dir, license }) {
  const deadline = Date.now() + 60000;
  while (!(await isPortOpen(port))) {
    if (child.exitCode !== null) throw new Error(`mongod exited with ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error("mongod did not start in 60 s");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const bootstrap = new mongoose.mongo.MongoClient(`mongodb://127.0.0.1:${port}`, { directConnection: true });
  await bootstrap.connect();
  try {
    const admin = bootstrap.db("admin");
    const hello = await admin.command({ hello: 1 });
    if (!hello.setName) {
      await admin.command({ replSetInitiate: { _id: REPLICA_SET, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    }
    const deadlinePrimary = Date.now() + 60000;
    for (;;) {
      const state = await admin.command({ hello: 1 });
      if (state.setName === REPLICA_SET && state.isWritablePrimary) break;
      if (Date.now() > deadlinePrimary) throw new Error("mongod replica set did not become PRIMARY in 60 s");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    await bootstrap.close();
  }
  await mongoose.connect(`mongodb://127.0.0.1:${port}/${DB_NAME}?replicaSet=${REPLICA_SET}&directConnection=true`);
  // Build the indexes the models declare, the same way startup does (ensureIndexes, so models with autoIndex off get theirs too).
  await require("../../src/config/db").ensureIndexes();

  // Stage 24: every DB test runs with a valid test license, so the old tests do not change behaviour.
  // A license test passes { license: false } and installs what it needs itself.
  if (license !== false) require("./license").installTestLicense();

  return async function stop() {
    await mongoose.disconnect();
    require("./license").removeTestLicenseDir();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      try { child.stdin.end(); } catch { /* already closed */ }
    });
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

async function clearDatabase() {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
}

module.exports = { startMongod, clearDatabase, mongodSkipReason, sweepStaleTempDirs };
