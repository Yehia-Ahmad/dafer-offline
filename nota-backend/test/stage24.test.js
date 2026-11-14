process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage24-test-secret-0123456789abcdef-0123456789";

// Stage 24: the license core. Format and signature checks, the 402 lock, activation rules, the shop-name lock and the client limit.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const app = require("../src/app");
const license = require("../src/license");
const { getMachineId } = require("../src/license/machineId");
const { encodePayload, buildText } = require("../src/license/format");
const AuditLog = require("../src/models/auditLog.model");
const Device = require("../src/models/device.model");
const Meta = require("../src/models/meta.model");
const ShopProfile = require("../src/models/shopProfile.model");
const { resetDeviceThrottle } = require("../src/middlewares/device.middleware");
const { startMongod, clearDatabase, mongodSkipReason } = require("./helpers/mongod");
const { issueTestLicense, installTestLicense, otherPrivateKey, testPrivateKey } = require("./helpers/license");

let stop; let server; let baseUrl; let token;
test.before(async () => {
  if (mongodSkipReason) return;
  stop = await startMongod({ port: 27164, tag: "s24-" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (stop) await stop(); });
test.beforeEach(async () => {
  if (mongodSkipReason) return;
  await clearDatabase(); token = null; resetDeviceThrottle();
  installTestLicense({ maxClients: 2, shopName: "محل النور", shopNameEn: "Al Nour Shop" });
  const owner = await call("POST", "/api/auth/setup-owner", { name: "Owner", username: "s24-owner", password: "owner-pass-123" });
  assert.equal(owner.status, 201); token = owner.json.token;
});
const it = (name, fn) => test(name, { skip: mongodSkipReason }, fn);

async function call(method, route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
}
const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.json)); return response.json; };
const asNobody = async (fn) => { const previous = token; token = null; try { return await fn(); } finally { token = previous; } };

const SOME_ROUTES = [["GET", "/api/shop-profile"], ["GET", "/api/products"], ["GET", "/api/auth/bootstrap"], ["POST", "/api/auth/login"], ["GET", "/api/license/info"], ["GET", "/api/devices"]];

const expectLocked = async (code) => {
  for (const [method, route] of SOME_ROUTES) {
    const response = await call(method, route, method === "POST" ? {} : undefined);
    assert.equal(response.status, 402, `${method} ${route}`);
    assert.equal(response.json.code, "LICENSE_REQUIRED");
    if (code) assert.equal(response.json.reason, code);
  }
  const status = ok(await call("GET", "/api/license/status"));
  assert.equal(status.licensed, false);
  assert.match(status.machineId, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
};

// ---- format, machine id ---------------------------------------------------------------------------------------

it("machine id: XXXX-XXXX-XXXX-XXXX from SHA-256('nota-machine-v1:' + guid), and stable", () => {
  const { idFromGuid } = require("../src/license/machineId");
  const expected = crypto.createHash("sha256").update("nota-machine-v1:GUID-1").digest("hex").slice(0, 16).toUpperCase().match(/.{4}/g).join("-");
  assert.equal(idFromGuid("GUID-1"), expected);
  assert.match(getMachineId(), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.equal(getMachineId(), getMachineId());
});

it("a license is NOTA1.<payload>.<signature> on one line with the payload keys in canonical order", () => {
  const text = issueTestLicense({ shopNameEn: "X" });
  assert.equal(text.split(".").length, 3);
  assert.ok(text.startsWith("NOTA1."));
  assert.ok(!/\s/.test(text));
  const payload = JSON.parse(Buffer.from(text.split(".")[1], "base64url").toString());
  assert.deepEqual(Object.keys(payload), ["v", "licenseId", "type", "shopName", "shopNameEn", "machineId", "maxClients", "issuedAt"]);
});

// ---- valid license ------------------------------------------------------------------------------------------

it("a valid license: the app works, status says licensed, the info is the owner's", async () => {
  const status = ok(await call("GET", "/api/license/status"));
  assert.equal(status.licensed, true);
  assert.equal(status.shopName, "محل النور");
  assert.equal(status.machineId, getMachineId());
  assert.equal((await call("GET", "/api/products")).status, 200);
  const info = ok(await call("GET", "/api/license/info"));
  assert.equal(info.type, "lifetime");
  assert.equal(info.maxClients, 2);
  assert.equal(info.clientsUsed, 0);
  assert.equal(info.machineId, getMachineId());
  assert.equal(info.signature, undefined);
});

// ---- every way a license can be wrong -> 402 everywhere except the allowed routes ------------------------------------

const BAD = {
  "no license": [null, "NO_LICENSE"],
  "garbage text": ["not a license", "MALFORMED"],
  "signed by another key": [() => issueTestLicense({}, otherPrivateKey()), "BAD_SIGNATURE"],
  "a different machine": [() => issueTestLicense({ machineId: "AAAA-BBBB-CCCC-DDDD" }), "WRONG_MACHINE"],
  "an unknown type": [() => issueTestLicense({ type: "yearly" }), "UNKNOWN_TYPE"],
  "an unknown version": [() => issueTestLicense({ v: 2 }), "UNKNOWN_VERSION"],
  "a tampered shop name": [() => { const [a, p, s] = issueTestLicense({}).split("."); const j = JSON.parse(Buffer.from(p, "base64url")); j.shopName = "محل تاني"; return `${a}.${Buffer.from(JSON.stringify(j)).toString("base64url")}.${s}`; }, "BAD_SIGNATURE"],
  "a tampered maxClients": [() => { const [a, p, s] = issueTestLicense({ maxClients: 1 }).split("."); const j = JSON.parse(Buffer.from(p, "base64url")); j.maxClients = 99; return `${a}.${Buffer.from(JSON.stringify(j)).toString("base64url")}.${s}`; }, "BAD_SIGNATURE"],
  "a truncated signature": [() => issueTestLicense({}).slice(0, -6), "BAD_SIGNATURE"],
};
for (const [name, [make, code]] of Object.entries(BAD)) {
  it(`${name}: every route answers 402 LICENSE_REQUIRED (${code}) except status/activate; data is untouched`, async () => {
    await ShopProfile.create({ key: "default", name: "الاسم القديم" });
    installTestLicense({}, make === null ? null : typeof make === "function" ? make() : make);
    token = null;
    await expectLocked(code);
    assert.equal((await ShopProfile.findOne({ key: "default" })).name, "الاسم القديم", "an invalid license never changes data");
  });
}

it("a license with a payload that passes the signature but is malformed is refused (maxClients negative, bad machine id)", async () => {
  for (const overrides of [{ maxClients: -1 }, { maxClients: 1.5 }, { shopName: "" }]) {
    installTestLicense({}, issueTestLicense(overrides));
    assert.equal(license.isValid(), false, JSON.stringify(overrides));
  }
});

it("the production key set does not accept a test-key license (a staged copy of the license code with the test flag off)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nota-prodkeys-"));
  try {
    for (const file of ["index.js", "keys.js", "format.js", "machineId.js"]) fs.copyFileSync(path.join(__dirname, "..", "src", "license", file), path.join(dir, file));
    fs.writeFileSync(path.join(dir, "build-flags.js"), "module.exports = { TEST_BUILD: false };\n");
    const licenseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nota-prodlic-"));
    fs.writeFileSync(path.join(licenseDir, "nota.lic"), issueTestLicense({}));
    const script = `process.env.NOTA_LICENSE_DIR=${JSON.stringify(licenseDir)}; const l=require(${JSON.stringify(path.join(dir, "index.js"))}); const k=require(${JSON.stringify(path.join(dir, "keys.js"))}); console.log(JSON.stringify({valid:l.isValid(), code:l.summary().code, keys:k.acceptedPublicKeys().length, test:k.isTestBuild()}));`;
    const out = JSON.parse(require("node:child_process").execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim());
    assert.deepEqual(out, { valid: false, code: "BAD_SIGNATURE", keys: 0, test: false }, "the placeholder production key verifies nothing and the test key is absent");
    fs.rmSync(licenseDir, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- activation -----------------------------------------------------------------------------------------------

it("with NO license, activation is open (from this PC, no login); a wrong license is refused with the reason and nothing is stored", async () => {
  installTestLicense({}, null);
  token = null;
  const bad = await call("POST", "/api/license/activate", { license: issueTestLicense({ machineId: "AAAA-BBBB-CCCC-DDDD" }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "LICENSE_INVALID");
  assert.equal(bad.json.reason, "WRONG_MACHINE");
  assert.equal(license.isValid(), false);
  assert.ok(!fs.existsSync(license.licensePath()), "no file written for a refused license");
  const good = ok(await call("POST", "/api/license/activate", { license: issueTestLicense({ shopName: "محل جديد", maxClients: 3 }) }));
  assert.equal(good.licensed, true);
  assert.equal(good.shopName, "محل جديد");
  assert.equal(license.isValid(), true);
  assert.ok(fs.existsSync(license.licensePath()), "the file is the source of truth");
  assert.ok((await Meta.findById("license").lean()).licenseText.startsWith("NOTA1."), "a copy is kept in the database");
  assert.equal((await ShopProfile.findOne({ key: "default" })).name, "محل جديد");
  assert.equal((await call("GET", "/api/products")).status, 401 /* licensed now: the normal login rules apply */);
});

it("an existing database keeps working after activation: the license name wins, the old name goes to the audit log", async () => {
  installTestLicense({}, null);
  await ShopProfile.create({ key: "default", name: "الاسم القديم", address: "عنوان" });
  token = null;
  ok(await call("POST", "/api/license/activate", { license: issueTestLicense({ shopName: "محل النور", shopNameEn: "Al Nour" }) }));
  const stored = await ShopProfile.findOne({ key: "default" }).lean();
  assert.equal(stored.name, "محل النور");
  assert.equal(stored.nameEn, "Al Nour");
  assert.equal(stored.address, "عنوان", "other profile data is kept");
  const entry = await AuditLog.findOne({ action: "shop.nameLocked" }).lean();
  assert.equal(entry.details.oldName, "الاسم القديم");
  assert.equal(entry.details.newName, "محل النور");
});

it("replacing a valid license needs the signed-in owner (shop.manage + owner); nobody else, and not without a login", async () => {
  const replacement = issueTestLicense({ shopName: "محل بديل" });
  const anon = await asNobody(() => call("POST", "/api/license/activate", { license: replacement }));
  assert.equal(anon.status, 401);
  ok(await call("POST", "/api/users", { name: "Mgr", username: "s24-mgr", password: "secret-pass-1", role: "manager" }), 201);
  const mgr = ok(await call("POST", "/api/auth/login", { username: "s24-mgr", password: "secret-pass-1" })).token;
  const previous = token; token = mgr;
  const denied = await call("POST", "/api/license/activate", { license: replacement });
  assert.equal(denied.status, 403);
  assert.equal((await call("GET", "/api/license/info")).status, 403);
  token = previous;
  assert.equal(license.details().shopName, "محل النور", "nothing changed");
  const done = ok(await call("POST", "/api/license/activate", { license: replacement }));
  assert.equal(done.shopName, "محل بديل");
  assert.equal(license.details().shopName, "محل بديل");
  // a refused replacement keeps the old license
  const refused = await call("POST", "/api/license/activate", { license: "NOTA1.x.y" });
  assert.equal(refused.status, 400);
  assert.equal(license.details().shopName, "محل بديل");
});

it("activation of a valid license also works with the key tool's own format (round trip through the vendor code path)", () => {
  const text = issueTestLicense({ licenseId: "LIC-1" });
  const result = license.verifyText(text);
  assert.equal(result.ok, true);
  assert.equal(result.payload.licenseId, "LIC-1");
  assert.equal(buildText(encodePayload(result.payload), crypto.sign(null, encodePayload(result.payload), testPrivateKey())), text);
});

// ---- shop name lock -------------------------------------------------------------------------------------------

it("the shop profile shows the license name read-only and the server refuses to change it", async () => {
  const profile = ok(await call("GET", "/api/shop-profile"));
  assert.equal(profile.name, "محل النور");
  assert.equal(profile.nameEn, "Al Nour Shop");
  assert.equal(profile.nameLocked, true);
  const changed = await call("PUT", "/api/shop-profile", { name: "غيرت الاسم", phones: [] });
  assert.equal(changed.status, 400);
  assert.equal(changed.json.code, "SHOP_NAME_LOCKED");
  ok(await call("PUT", "/api/shop-profile", { name: "محل النور", nameEn: "Al Nour Shop", address: "شارع 1", phones: [] }));
  const after = ok(await call("GET", "/api/shop-profile"));
  assert.equal(after.name, "محل النور");
  assert.equal(after.address, "شارع 1");
  assert.equal((await asNobody(() => call("GET", "/api/auth/bootstrap"))).json.shop.name, "محل النور", "the login screen shows the license name too");
});

// ---- client limit ---------------------------------------------------------------------------------------------

const clientCall = (id, name = "PC") => call("GET", "/api/products", undefined, { "x-nota-device-id": id, "x-nota-device-name": name });

it("client limit: pair up to maxClients, the next client is refused (CLIENT_LIMIT), unpairing frees the slot", async () => {
  assert.equal((await clientCall("client-pc-0001", "A")).status, 200);
  assert.equal((await clientCall("client-pc-0002", "B")).status, 200);
  const third = await clientCall("client-pc-0003", "C");
  assert.equal(third.status, 403);
  assert.equal(third.json.code, "CLIENT_LIMIT");
  assert.equal((await clientCall("client-pc-0003", "C")).status, 403, "refused on every request, not once a minute");
  assert.equal((await clientCall("client-pc-0001", "A")).status, 200, "a paired client keeps working");
  assert.equal(await Device.countDocuments({ deviceId: "client-pc-0003" }), 0, "a refused client leaves no record");

  const info = ok(await call("GET", "/api/license/info"));
  assert.equal(info.clientsUsed, 2);
  assert.deepEqual(info.clients.map((c) => c.deviceId).sort(), ["client-pc-0001", "client-pc-0002"]);

  ok(await call("DELETE", "/api/license/clients/client-pc-0001"));
  assert.equal((await call("DELETE", "/api/license/clients/client-pc-0001")).status, 404);
  assert.equal((await clientCall("client-pc-0001", "A")).status, 200, "the freed slot is taken by the first PC that asks: here the old one pairs again");
  assert.equal((await clientCall("client-pc-0003", "C")).status, 403, "...so the third is still refused");
  ok(await call("DELETE", "/api/license/clients/client-pc-0002"));
  assert.equal((await clientCall("client-pc-0003", "C")).status, 200, "the freed slot goes to the next PC that asks");
  assert.equal((await clientCall("client-pc-0002", "B")).status, 403, "the unpaired PC is cut off straight away (the registry throttle is cleared) and needs a free slot to come back");
});

it("client limit at LOGIN: a client PC beyond maxClients cannot sign in (403 CLIENT_LIMIT, ar + en message); a paired one can; unpair frees the slot", async () => {
  const login = (id) => call("POST", "/api/auth/login", { username: "s24-owner", password: "owner-pass-123" }, { "x-nota-device-id": id, "x-nota-device-name": "PC" });
  assert.equal((await login("client-pc-0001")).status, 200);
  assert.equal((await login("client-pc-0002")).status, 200);
  const refused = await login("client-pc-0003");
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "CLIENT_LIMIT");
  assert.equal(refused.json.message, "وصلت لأقصى عدد أجهزة فرعية في الترخيص — اطلب من المالك يشيل جهاز");
  assert.match(refused.json.messageEn, /limit of client PCs/);
  assert.equal((await login("client-pc-0001")).status, 200, "an already paired PC signs in again");
  assert.equal((await call("POST", "/api/auth/login", { username: "s24-owner", password: "owner-pass-123" })).status, 200, "no device header (or the main PC): not counted");
  ok(await call("DELETE", "/api/license/clients/client-pc-0002"));
  assert.equal((await login("client-pc-0003")).status, 200, "the freed slot");
});

it("maxClients 0 = main PC only; the main PC never needs a slot", async () => {
  installTestLicense({ maxClients: 0 });
  assert.equal((await clientCall("client-pc-0001")).json.code, "CLIENT_LIMIT");
  process.env.NOTA_INSTANCE_ID = "main-pc-instance-01";
  try {
    assert.equal((await clientCall("main-pc-instance-01", "Main")).status, 200);
    assert.equal((await Device.findOne({ deviceId: "main-pc-instance-01" })).role, "main");
  } finally { delete process.env.NOTA_INSTANCE_ID; }
});

it("only the owner can unpair; a PC registered before Stage 24 is paired by migration 12", async () => {
  const { migrations } = require("../src/migrations");
  await Device.collection.insertOne({ deviceId: "old-client-pc-01", name: "Old", role: "client", lastSeenAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  await migrations.find((m) => m.version === 12).run(null);
  assert.equal((await Device.findOne({ deviceId: "old-client-pc-01" })).paired, true);
  ok(await call("POST", "/api/users", { name: "Mgr", username: "s24-mgr2", password: "secret-pass-1", role: "manager" }), 201);
  const mgr = ok(await call("POST", "/api/auth/login", { username: "s24-mgr2", password: "secret-pass-1" })).token;
  const previous = token; token = mgr;
  assert.equal((await call("DELETE", "/api/license/clients/old-client-pc-01")).status, 403);
  token = previous;
});

it("no private key anywhere in the repo or the license code: no PEM private block, no .pem/.key files", () => {
  const root = path.join(__dirname, "..", "..");
  const skip = new Set(["node_modules", ".git", ".mongo-data", "dist", "dist-offline", "offline-stage", "release-offline", "vendor", ".angular"]);
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(pem|key)$/i.test(entry.name)) { hits.push(full); continue; }
      if (fs.statSync(full).size > 2 * 1024 * 1024 || /\.(png|jpg|jpeg|ico|woff2?|ttf|gz|zip|exe|dll|node|svg|pdf)$/i.test(entry.name)) continue;
      if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(fs.readFileSync(full, "utf8")) && !full.endsWith("stage24.test.js")) hits.push(full);
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

