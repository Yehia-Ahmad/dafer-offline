// Online Stage 7C: NOTA_PUBLIC_URL must reach the BACKEND env on a real server (publishing an ad refuses without it). setup-server.sh writes
// it to both env files; update.sh copies it for a server that only had it in the storefront env. The shell functions really run here
// (bash, temp files); the test skips when there is no bash.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const deploy = path.join(__dirname, "..", "..", "deploy");
const read = (name) => fs.readFileSync(path.join(deploy, name), "utf8");
const bash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
const noBash = bash.status !== 0 ? "bash not available" : false;

test("setup-server.sh writes NOTA_PUBLIC_URL to the backend env and to the storefront env, from the same domain", () => {
  const setup = read("setup-server.sh");
  assert.match(setup, /env_set NOTA_PUBLIC_URL "https:\/\/\$domain" "\$NOTA_BACKEND_ENV"/);
  assert.match(setup, /env_set NOTA_PUBLIC_URL "https:\/\/\$domain" "\$NOTA_STOREFRONT_ENV"/);
});

test("update.sh calls ensure_public_url (after the storefront env is known to exist); the helper lives in nota-lib.sh", () => {
  const update = read("update.sh");
  const check = update.indexOf('[ -f "$NOTA_STOREFRONT_ENV" ] ||');
  const call = update.indexOf("\nensure_public_url\n");
  assert.ok(check !== -1 && call > check, "called after the storefront env check");
  assert.match(read("nota-lib.sh"), /^ensure_public_url\(\) \{/m);
});

test(".env.example documents NOTA_PUBLIC_URL", () => {
  assert.match(fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8"), /^# NOTA_PUBLIC_URL=https:\/\/your-shop-domain/m);
});

test("every changed deploy script passes bash -n", { skip: noBash }, () => {
  for (const name of ["setup-server.sh", "update.sh", "nota-lib.sh"]) {
    const result = spawnSync("bash", ["-n", path.join(deploy, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

const ensure = (backendLines, storefrontLines) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nota-env-"));
  const backend = path.join(dir, "backend.env");
  const storefront = path.join(dir, "storefront.env");
  if (backendLines !== null) fs.writeFileSync(backend, backendLines);
  if (storefrontLines !== null) fs.writeFileSync(storefront, storefrontLines);
  const slashes = (value) => value.split(path.sep).join("/");
  const result = spawnSync("bash", ["-c", `NOTA_BACKEND_ENV='${slashes(backend)}' NOTA_STOREFRONT_ENV='${slashes(storefront)}'; . '${slashes(path.join(deploy, "nota-lib.sh"))}'; ensure_public_url`], { encoding: "utf8" });
  const out = fs.existsSync(backend) ? fs.readFileSync(backend, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out, stderr: result.stderr };
};

test("ensure_public_url copies the storefront's value when the backend has none", { skip: noBash }, () => {
  const copied = ensure("NODE_ENV=production\n", 'NODE_ENV=production\nNOTA_PUBLIC_URL="https://shop-nota.com"\n');
  assert.equal(copied.status, 0, copied.stderr);
  assert.match(copied.out, /^NOTA_PUBLIC_URL=https:\/\/shop-nota\.com$/m, "written the way env_set always writes (no quotes)");
  assert.match(copied.out, /NODE_ENV=production/, "the rest of the file is kept");
  const unquoted = ensure("PORT=5000\n", "NOTA_PUBLIC_URL=https://shop-nota.com\n");
  assert.match(unquoted.out, /^NOTA_PUBLIC_URL=https:\/\/shop-nota\.com$/m);
});

test("ensure_public_url never replaces a value the backend already has, and does nothing (no error) when neither file has one", { skip: noBash }, () => {
  const kept = ensure("NOTA_PUBLIC_URL=https://mine.example\n", "NOTA_PUBLIC_URL=https://other.example\n");
  assert.equal(kept.status, 0);
  assert.equal(kept.out, "NOTA_PUBLIC_URL=https://mine.example\n");
  const none = ensure("PORT=5000\n", "PORT=4000\n");
  assert.equal(none.status, 0);
  assert.equal(none.out, "PORT=5000\n");
  assert.match(none.stderr, /WARNING: NOTA_PUBLIC_URL is in neither env file/);
});
