// `npm test` runner: runs `node --test` and fails (instead of silently skipping) when no mongod is available.
// Set NOTA_ALLOW_SKIP=1 to explicitly allow the database tests to skip. The skip count is printed after every run.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// A real mongod is needed (replica set, transactions). NOTA_TEST_MONGOD is the path to the binary;
// otherwise "mongod" on PATH is used by test/helpers/mongod.js.
const binaryName = process.platform === "win32" ? "mongod.exe" : "mongod";
const onPath = (process.env.PATH || "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, binaryName)));
const mongodPath = process.env.NOTA_TEST_MONGOD || (onPath ? binaryName : "");
const allowSkip = process.env.NOTA_ALLOW_SKIP === "1";

if (!mongodPath || (process.env.NOTA_TEST_MONGOD && !fs.existsSync(mongodPath))) {
  if (!allowSkip) {
    console.error("npm test: no mongod found.");
    console.error("Set NOTA_TEST_MONGOD to a mongod binary or put mongod on PATH. Set NOTA_ALLOW_SKIP=1 to run without it (database tests are then skipped).");
    process.exit(1);
  }
}

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: ["inherit", "pipe", "inherit"], env: process.env });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.on("exit", (code, signal) => {
  const match = [...output.matchAll(/^[ℹ#]\s*skipped\s+(\d+)/gm)].pop();
  const skipped = match ? Number(match[1]) : 0;
  console.log(`\nnpm test: ${skipped} skipped${allowSkip ? " (NOTA_ALLOW_SKIP=1)" : ""}`);
  process.exit(signal ? 1 : code ?? 1);
});
