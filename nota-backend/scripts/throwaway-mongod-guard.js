// Owns one throwaway mongod for a test process: `node scripts/throwaway-mongod-guard.js <tempDir> <mongodPath> <mongod args...>`.
// The test process keeps this guard's stdin open. When the pipe closes (stop(), a crash, the runner's timeout, or a hard
// kill of the test process, which on Windows runs no exit handlers) the guard stops mongod and removes <tempDir>, so a test
// run never leaves a database server or a temp folder behind.
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [dir, mongodPath, ...args] = process.argv.slice(2);
const child = spawn(mongodPath, args, { stdio: "ignore", windowsHide: true });

let stopping = false;
const finish = () => {
  if (stopping) return;
  stopping = true;
  try { child.kill(); } catch { /* already gone */ }
};

child.once("error", () => process.exit(1));
child.once("exit", (code) => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort: the next run sweeps stale folders */ }
  process.exit(code ?? 0);
});

process.stdin.on("end", finish);
process.stdin.on("close", finish);
process.stdin.on("error", finish);
process.stdin.resume();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(signal, finish);
