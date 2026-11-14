process.env.NODE_ENV = "test";

// Stage 24: tools/license-gen (keygen / issue / verify) and its tie to the backend's verification. No database needed.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const license = require("../src/license");
const { getMachineId } = require("../src/license/machineId");
const { testPrivateKey } = require("./helpers/license");

const TOOL = path.join(__dirname, "..", "..", "tools", "license-gen", "license-gen.js");
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nota-licgen-"));
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); license.resetForTests(); delete process.env.NOTA_LICENSE_DIR; });

test("keygen creates an Ed25519 pair and refuses to overwrite it", () => {
  const dir = path.join(tmp, "keys");
  const first = run("keygen", "--out", dir);
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(path.join(dir, "private.pem"), "utf8");
  assert.match(before, /BEGIN PRIVATE KEY/);
  assert.match(fs.readFileSync(path.join(dir, "public.pem"), "utf8"), /BEGIN PUBLIC KEY/);
  const second = run("keygen", "--out", dir);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, "private.pem"), "utf8"), before, "the key is unchanged");
});

test("issue -> verify round trip, the CSV line is written next to the key, a wrong key fails verify", () => {
  const dir = path.join(tmp, "keys2");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const lic = path.join(tmp, "shop.lic");
  const issued = run("issue", "--key", path.join(dir, "private.pem"), "--machine", "1a2b-3c4d-5e6f-7a8b", "--shop", "محل النور", "--shop-en", "Al Nour", "--max-clients", "3", "--out", lic);
  assert.equal(issued.status, 0, issued.stderr);
  const text = issued.stdout.trim();
  assert.ok(text.startsWith("NOTA1."));
  assert.equal(fs.readFileSync(lic, "utf8").trim(), text);

  const good = run("verify", "--pub", path.join(dir, "public.pem"), lic);
  assert.equal(good.status, 0, good.stderr);
  const payload = JSON.parse(good.stdout.slice(0, good.stdout.lastIndexOf("}") + 1));
  assert.equal(payload.shopName, "محل النور");
  assert.equal(payload.shopNameEn, "Al Nour");
  assert.equal(payload.machineId, "1A2B-3C4D-5E6F-7A8B");
  assert.equal(payload.maxClients, 3);
  assert.equal(payload.type, "lifetime");

  const csv = fs.readFileSync(path.join(dir, "issued-licenses.csv"), "utf8").replace(/^﻿/, "").trim().split("\n");
  assert.equal(csv[0], "licenseId,date,shop,machine,maxClients");
  assert.equal(csv.length, 2);
  assert.ok(csv[1].includes(payload.licenseId) && csv[1].includes("محل النور") && csv[1].includes("1A2B-3C4D-5E6F-7A8B") && csv[1].endsWith('"3"'));

  const other = path.join(tmp, "other");
  assert.equal(run("keygen", "--out", other).status, 0);
  assert.notEqual(run("verify", "--pub", path.join(other, "public.pem"), lic).status, 0, "another public key does not verify it");
});

test("issue refuses a bad machine id, a missing key and a non-numeric --max-clients", () => {
  const dir = path.join(tmp, "keys3");
  assert.equal(run("keygen", "--out", dir).status, 0);
  const key = path.join(dir, "private.pem");
  assert.notEqual(run("issue", "--key", key, "--machine", "nope", "--shop", "x", "--max-clients", "1").status, 0);
  assert.notEqual(run("issue", "--key", key, "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "x", "--max-clients", "many").status, 0);
  assert.notEqual(run("issue", "--key", path.join(dir, "missing.pem"), "--machine", "1A2B-3C4D-5E6F-7A8B", "--shop", "x", "--max-clients", "1").status, 0);
  assert.ok(!fs.existsSync(path.join(dir, "issued-licenses.csv")), "nothing is logged for a refused license");
});

test("the backend accepts what the tool issues (signed with the test key, for this PC) and refuses it signed by an unknown key", () => {
  const pem = path.join(tmp, "test-private.pem");
  fs.writeFileSync(pem, testPrivateKey().export({ type: "pkcs8", format: "pem" }));
  const issued = run("issue", "--key", pem, "--machine", getMachineId(), "--shop", "محل الاختبار", "--max-clients", "1");
  assert.equal(issued.status, 0, issued.stderr);
  const result = license.verifyText(issued.stdout.trim());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.payload.maxClients, 1);

  const unknown = path.join(tmp, "unknown");
  assert.equal(run("keygen", "--out", unknown).status, 0);
  const foreign = run("issue", "--key", path.join(unknown, "private.pem"), "--machine", getMachineId(), "--shop", "x", "--max-clients", "1");
  assert.equal(license.verifyText(foreign.stdout.trim()).code, "BAD_SIGNATURE");
});

test("the .gitignore covers keys, the issue log and license files", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", "..", ".gitignore"), "utf8");
  for (const pattern of ["*.pem", "*.key", "issued-licenses.csv", "tools/license-gen/keys/"]) assert.ok(ignore.split(/\r?\n/).includes(pattern), pattern);
  assert.ok(ignore.split(/\r?\n/).includes("nota-review/"), "the earlier entry is kept");
});
