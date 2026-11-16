#!/usr/bin/env node
// Builds a Nota release on the developer PC (Windows, macOS or Linux):
//   node deploy/make-release.js [--allow-dirty] [--skip-build]
// Output: release/release-<version>-<commit>.tar.gz (release/ is git-ignored), containing
//   release.json, backend/ (no node_modules, tests, .env), frontend/admin/ (the admin app, built with baseHref /admin/),
//   storefront/ (the server-side rendered customer website: server/ + browser/; the server bundle includes its own
//   dependencies, so there is no node_modules and no npm ci for it).
// Refuses to run when the git tree has uncommitted changes (--allow-dirty for testing only).
// Needs: git, node/npm, and `tar` (built into Windows 10/11).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const backendDir = path.join(repoRoot, "nota-backend");
const frontendDir = path.join(repoRoot, "nota-frontend");
const storefrontDir = path.join(repoRoot, "nota-storefront");
const outDir = path.join(repoRoot, "release");

const args = new Set(process.argv.slice(2));
const allowDirty = args.has("--allow-dirty");
const skipBuild = args.has("--skip-build");

// Throws (instead of exiting) so the staging folder is always cleaned up by the `finally` below.
const fail = (message) => {
  throw new Error(message);
};

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", shell: process.platform === "win32" && options.shell, ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  return result;
};

const git = (...gitArgs) => {
  const result = run("git", gitArgs, { cwd: repoRoot });
  if (result.status !== 0) fail(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

// Files and folders of nota-backend that go into the release. Everything else (test/, node_modules, .env, ...) stays out.
// vendor/ holds xlsx-0.20.3.tgz (package.json points to it with file:), so `npm ci` on the server never needs cdn.sheetjs.com.
const BACKEND_ENTRIES = ["src", "scripts", "vendor", "package.json", "package-lock.json"];
// Dev/test-only scripts that must not be shipped.
const BACKEND_SCRIPT_EXCLUDES = new Set(["run-tests.js", "legacy-migration.js", "throwaway-mongod-guard.js"]);

const copyBackend = (target) => {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of BACKEND_ENTRIES) {
    const from = path.join(backendDir, entry);
    if (!fs.existsSync(from)) fail(`nota-backend/${entry} not found`);
    fs.cpSync(from, path.join(target, entry), {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        if (base === "node_modules" || base === ".env" || base.startsWith(".env.")) return false;
        if (path.dirname(source) === path.join(backendDir, "scripts") && BACKEND_SCRIPT_EXCLUDES.has(base)) return false;
        return true;
      },
    });
  }
};

const main = () => {
  const dirty = git("status", "--porcelain");
  if (dirty && !allowDirty) {
    fail("the git tree has uncommitted changes. Commit them first (or pass --allow-dirty for a test build).\n" + dirty);
  }

  const commit = git("rev-parse", "--short=7", "HEAD");
  const now = new Date();
  // Version: the backend's package.json version (what /health reports). The commit makes each build unique.
  const version = String(JSON.parse(fs.readFileSync(path.join(backendDir, "package.json"), "utf8")).version || "");
  if (!/^[A-Za-z0-9._-]+$/.test(version)) fail(`nota-backend/package.json has no usable version: "${version}"`);
  const name = `release-${version}-${commit}`;

  // The admin app has its own build configuration (baseHref /admin/) and its own output folder, so the plain production build
  // (offline / online-at-root) in dist/nota is never overwritten. Online Stage 5B.
  const adminOut = path.join("dist", "nota-admin");
  if (!skipBuild) {
    console.log("make-release: building the admin app (configuration admin, baseHref /admin/)...");
    const admin = spawnSync("npx", ["ng", "build", "--configuration", "admin", "--output-path", adminOut], { cwd: frontendDir, stdio: "inherit", shell: process.platform === "win32" });
    if (admin.status !== 0) fail("admin app build failed");
    console.log("make-release: building the storefront (npm ci + ng build)...");
    if (!fs.existsSync(path.join(storefrontDir, "node_modules"))) {
      const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: storefrontDir, stdio: "inherit", shell: process.platform === "win32" });
      if (install.status !== 0) fail("storefront npm ci failed");
    }
    const storefront = spawnSync("npx", ["ng", "build"], { cwd: storefrontDir, stdio: "inherit", shell: process.platform === "win32" });
    if (storefront.status !== 0) fail("storefront build failed");
  }

  const builtRoot = path.join(frontendDir, adminOut);
  const builtDir = fs.existsSync(path.join(builtRoot, "browser", "index.html")) ? path.join(builtRoot, "browser") : builtRoot;
  if (!fs.existsSync(path.join(builtDir, "index.html"))) fail(`no index.html in ${builtDir}; build the admin app first`);
  const adminIndex = fs.readFileSync(path.join(builtDir, "index.html"), "utf8");
  if (!/<base href="\/admin\/"/.test(adminIndex)) fail("the admin build does not have <base href=\"/admin/\">: it was not built with --configuration admin");

  const storefrontBuilt = path.join(storefrontDir, "dist", "nota-storefront");
  if (!fs.existsSync(path.join(storefrontBuilt, "server", "server.mjs")) || !fs.existsSync(path.join(storefrontBuilt, "browser"))) {
    fail("no storefront build in nota-storefront/dist/nota-storefront; build the storefront first");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(outDir, ".staging-"));
  try {
    copyBackend(path.join(staging, "backend"));
    fs.cpSync(builtDir, path.join(staging, "frontend", "admin"), { recursive: true });
    fs.mkdirSync(path.join(staging, "storefront"), { recursive: true });
    fs.cpSync(path.join(storefrontBuilt, "server"), path.join(staging, "storefront", "server"), { recursive: true });
    fs.cpSync(path.join(storefrontBuilt, "browser"), path.join(staging, "storefront", "browser"), { recursive: true });
    fs.writeFileSync(
      path.join(staging, "release.json"),
      `${JSON.stringify({ version, commit, date: now.toISOString(), dirty: Boolean(dirty) }, null, 2)}\n`
    );

    const tarball = path.join(outDir, `${name}.tar.gz`);
    fs.rmSync(tarball, { force: true });
    // Relative paths only: GNU tar (Git Bash) reads "C:\..." as a remote host. Top-level names are listed
    // (not ".") so release.json is a plain path inside the archive.
    const tarResult = run(
      "tar",
      ["-czf", path.basename(tarball), "-C", path.basename(staging), "release.json", "backend", "frontend", "storefront"],
      { cwd: outDir }
    );
    if (tarResult.status !== 0) fail(`tar failed: ${tarResult.stderr.trim()}`);
    console.log(`make-release: ${tarball}`);
    console.log(`make-release: version ${version}, commit ${commit}${dirty ? " (DIRTY tree, do not use for production)" : ""}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

try {
  main();
} catch (error) {
  console.error(`make-release: ${error.message}`);
  process.exit(1);
}
