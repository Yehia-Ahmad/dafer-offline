process.env.NODE_ENV = "test";
process.env.NOTA_AUTH = "1";
process.env.NOTA_JWT_SECRET = "stage24-test-secret-0123456789abcdef-0123456789";

// Stage 24: the license core. Format and signature checks, the 402 lock, activation rules, the shop-name lock and the client limit.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
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
const { resetDeviceGate } = require("../src/middlewares/deviceGate.middleware");
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
  await clearDatabase(); token = null; resetDeviceThrottle(); resetDeviceGate();
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
// A client PC reaches the backend over the LAN, so its requests come from a non-loopback address. These tests send from 127.0.0.N
// (N != 1), which the backend does NOT treat as loopback (only 127.0.0.1 / ::1 are), so they are real LAN-style requests over real HTTP.

const sourceOf = (id) => `127.0.0.${10 + Number(id.slice(-2))}`; // client-pc-0001 -> 127.0.0.11, one address per PC
function callFrom(source, method, route, { body, headers = {}, auth = token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${baseUrl}${route}`, {
      method, localAddress: source, timeout: 15000,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const asClient = (id, name = "PC") => ({ source: sourceOf(id), headers: { "x-nota-device-id": id, "x-nota-device-name": name } });
const clientCall = (id, name = "PC", route = "/api/products") => { const c = asClient(id, name); return callFrom(c.source, "GET", route, { headers: c.headers }); };
const clientLogin = (id, name = "PC") => { const c = asClient(id, name); return callFrom(c.source, "POST", "/api/auth/login", { body: { username: "s24-owner", password: "owner-pass-123" }, headers: c.headers, auth: null }); };

it("client limit: pair up to maxClients, the next client is refused (CLIENT_LIMIT) on every request; a paired one keeps working", async () => {
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
  assert.equal((await Device.findOne({ deviceId: "client-pc-0001" })).role, "client");
});

it("unpair REVOKES: the PC cannot pair itself again even with a free slot; the owner re-allows it; only then does it come back", async () => {
  assert.equal((await clientCall("client-pc-0001", "A")).status, 200);
  assert.equal((await clientCall("client-pc-0002", "B")).status, 200);
  ok(await call("DELETE", "/api/license/clients/client-pc-0001"));
  assert.equal((await call("DELETE", "/api/license/clients/client-pc-0001")).status, 404, "nothing left to unpair");
  const revoked = await clientCall("client-pc-0001", "A");
  assert.equal(revoked.status, 403, "a slot is free, but a revoked PC cannot take it by itself");
  assert.equal(revoked.json.code, "CLIENT_REVOKED");
  assert.match(revoked.json.messageEn, /allow it again/);
  assert.equal((await clientLogin("client-pc-0001", "A")).json.code, "CLIENT_REVOKED", "at login too");
  // the owner sees it in the list of removed PCs
  const info = ok(await call("GET", "/api/license/info"));
  assert.deepEqual(info.revoked.map((r) => r.deviceId), ["client-pc-0001"]);
  assert.equal(info.clientsUsed, 1);
  // the freed slot goes to another PC meanwhile
  assert.equal((await clientCall("client-pc-0003", "C")).status, 200);
  // re-allowing does not take a slot: the PC still needs a free one
  ok(await call("POST", "/api/license/clients/client-pc-0001/allow"));
  assert.equal((await call("POST", "/api/license/clients/client-pc-0001/allow")).status, 404, "it is not revoked any more");
  assert.equal((await clientCall("client-pc-0001", "A")).json.code, "CLIENT_LIMIT", "re-allowed, but the two slots are taken");
  ok(await call("DELETE", "/api/license/clients/client-pc-0002"));
  ok(await call("POST", "/api/license/clients/client-pc-0002/allow"));
  assert.equal((await clientCall("client-pc-0001", "A")).status, 200, "re-allowed and a slot is free: it pairs itself again");
  assert.deepEqual(ok(await call("GET", "/api/license/info")).revoked, []);
});

it("client limit at LOGIN: a client PC beyond maxClients cannot sign in (403 CLIENT_LIMIT, ar + en message); a paired one can; revoked cannot", async () => {
  assert.equal((await clientLogin("client-pc-0001")).status, 200);
  assert.equal((await clientLogin("client-pc-0002")).status, 200);
  const refused = await clientLogin("client-pc-0003");
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "CLIENT_LIMIT");
  assert.equal(refused.json.message, "وصلت لأقصى عدد أجهزة فرعية في الترخيص — اطلب من المالك يشيل جهاز");
  assert.match(refused.json.messageEn, /limit of client PCs/);
  assert.equal((await clientLogin("client-pc-0001")).status, 200, "an already paired PC signs in again");
  assert.equal((await call("POST", "/api/auth/login", { username: "s24-owner", password: "owner-pass-123" })).status, 200, "the main PC (loopback) is not counted");
  ok(await call("DELETE", "/api/license/clients/client-pc-0002"));
  assert.equal((await clientLogin("client-pc-0002")).json.code, "CLIENT_REVOKED");
  assert.equal((await clientLogin("client-pc-0003")).status, 200, "the freed slot");
});

it("BYPASS 1: the main PC's instance id does not make a LAN request 'the main PC' (it needs a slot, even with maxClients 0); only loopback is the main PC", async () => {
  installTestLicense({ maxClients: 0 });
  process.env.NOTA_INSTANCE_ID = "main-pc-instance-01";
  try {
    // anyone with the LAN key can read the instance id from /api/lan/info and send it as their device id
    const spoof = await callFrom("127.0.0.31", "GET", "/api/products", { headers: { "x-nota-device-id": "main-pc-instance-01" } });
    assert.equal(spoof.status, 403);
    assert.equal(spoof.json.code, "CLIENT_LIMIT");
    assert.equal((await clientLogin("client-pc-0001")).json.code, "CLIENT_LIMIT");
    assert.equal(await Device.countDocuments({ role: "main" }), 0, "nothing was registered as the main PC");
    // the real main PC is the loopback one, whatever id it sends (or none)
    assert.equal((await call("GET", "/api/products", undefined, { "x-nota-device-id": "main-pc-instance-01", "x-nota-device-name": "Main" })).status, 200);
    assert.equal((await Device.findOne({ deviceId: "main-pc-instance-01" })).role, "main");
    assert.equal((await call("GET", "/api/products")).status, 200, "loopback needs no device id");
  } finally { delete process.env.NOTA_INSTANCE_ID; }
});

it("BYPASS 2: every non-loopback request must carry a device id (400 DEVICE_ID_REQUIRED, login included); loopback and the discovery probe need none", async () => {
  for (const [method, route, body] of [["GET", "/api/products"], ["POST", "/api/auth/login", { username: "s24-owner", password: "owner-pass-123" }], ["GET", "/api/license/status"], ["GET", "/api/auth/bootstrap"]]) {
    const response = await callFrom("127.0.0.41", method, route, { body, auth: null });
    assert.equal(response.status, 400, `${method} ${route}`);
    assert.equal(response.json.code, "DEVICE_ID_REQUIRED");
    assert.match(response.json.messageEn, /device id/);
  }
  assert.equal((await callFrom("127.0.0.41", "GET", "/api/products", { headers: { "x-nota-device-id": "bad id!" } })).json.code, "DEVICE_ID_REQUIRED", "an invalid id counts as none");
  assert.equal((await call("GET", "/api/license/status")).status, 200, "the main PC (loopback) sends no id");
  // the discovery probe (a client has no identity yet) is exempt: checked on the middleware, because /api/lan is mounted only in LAN mode
  const { deviceGate } = require("../src/middlewares/deviceGate.middleware");
  const probe = { method: "GET", path: "/lan/info", ip: "192.168.1.9", get: () => undefined };
  let result = "not called";
  deviceGate()(probe, {}, (error) => { result = error || "next"; });
  assert.equal(result, "next");
  deviceGate()({ ...probe, path: "/products" }, {}, (error) => { result = error; });
  assert.equal(result.responseData.code, "DEVICE_ID_REQUIRED");
});

it("BYPASS 3: one device id from a different IP within 2 minutes is refused for the new IP (403 DEVICE_IN_USE, ar + en); after 2 minutes of silence it may move", async () => {
  const id = "client-pc-0001";
  const header = { "x-nota-device-id": id, "x-nota-device-name": "A" };
  assert.equal((await callFrom("127.0.0.51", "GET", "/api/products", { headers: header })).status, 200);
  const copy = await callFrom("127.0.0.52", "GET", "/api/products", { headers: header });
  assert.equal(copy.status, 403);
  assert.equal(copy.json.code, "DEVICE_IN_USE");
  assert.ok(copy.json.message.includes("بيستخدمه جهاز تاني") && /another PC/.test(copy.json.messageEn));
  assert.equal((await callFrom("127.0.0.51", "GET", "/api/products", { headers: header })).status, 200, "the PC that was there first is not disturbed");

  // the 2-minute window, with an injected clock
  const { deviceInUse: makeGate, resetDeviceGate } = require("../src/middlewares/deviceGate.middleware");
  resetDeviceGate();
  let clock = 1_000_000;
  const gate = makeGate({ now: () => clock });
  const run = (ip) => { let out = "next"; gate({ method: "GET", path: "/products", ip, get: (name) => (name === "x-nota-device-id" ? "moving-device-001" : undefined) }, {}, (e) => { if (e) out = e.responseData.code; }); return out; };
  assert.equal(run("10.0.0.5"), "next");
  assert.equal(run("::ffff:10.0.0.5"), "next", "an IPv4-mapped address is the same PC");
  clock += 119_000;
  assert.equal(run("10.0.0.6"), "DEVICE_IN_USE", "still inside 2 minutes");
  clock += 2_000;
  assert.equal(run("10.0.0.6"), "next", "silent for 2 minutes: another address may take the id (e.g. a new DHCP address)");
  assert.equal(run("10.0.0.5"), "DEVICE_IN_USE", "and now the old address is the other one");
  resetDeviceGate();
});

// ---- Stage 24 last fixes: the main-PC token ------------------------------------------------------------------------
// A TCP forwarder on the main PC (or any local proxy) relays LAN requests to 127.0.0.1, so loopback alone must not mean "the main PC".
const net = require("node:net");
const { mainPcToken, HEADER: MAIN_TOKEN_HEADER } = require("../src/auth/mainPc");
const { NO_MAIN_TOKEN } = require("./helpers/license");

function startForwarder() {
  const target = new URL(baseUrl);
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: "127.0.0.1", port: Number(target.port) });
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream); upstream.pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", end); upstream.on("error", end); client.on("close", end); upstream.on("close", end);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(done); }),
  })));
}
// what a client PC (or the forwarder's user) sends: no main-PC token
const viaForwarder = (forwarder, route, { method = "GET", body, headers = {}, auth = token } = {}) =>
  fetch(`${forwarder.url}${route}`, {
    method,
    headers: { [NO_MAIN_TOKEN]: "1", connection: "close", ...(body ? { "Content-Type": "application/json" } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (response) => { const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } return { status: response.status, json }; });

it("FORWARDER 1: a LAN request relayed to 127.0.0.1 with no header is NOT the main PC → 400 DEVICE_ID_REQUIRED", async () => {
  const forwarder = await startForwarder();
  try {
    for (const [method, route, body] of [["GET", "/api/products"], ["POST", "/api/auth/login", { username: "s24-owner", password: "owner-pass-123" }], ["GET", "/api/auth/bootstrap"]]) {
      const response = await viaForwarder(forwarder, route, { method, body, auth: null });
      assert.equal(response.status, 400, `${method} ${route}`);
      assert.equal(response.json.code, "DEVICE_ID_REQUIRED");
    }
    assert.equal(await Device.countDocuments({ role: "main" }), 0, "nothing was registered as the main PC");
  } finally { await forwarder.close(); }
});

it("FORWARDER 2: through the forwarder each new device id is counted as a client PC; CLIENT_LIMIT when the slots are full (login included)", async () => {
  const forwarder = await startForwarder();
  try {
    const as = (id, route = "/api/products", extra = {}) => viaForwarder(forwarder, route, { headers: { "x-nota-device-id": id, "x-nota-device-name": "F" }, ...extra });
    assert.equal((await as("forwarded-pc-0001")).status, 200);
    assert.equal((await as("forwarded-pc-0002")).status, 200);
    const third = await as("forwarded-pc-0003");
    assert.equal(third.status, 403);
    assert.equal(third.json.code, "CLIENT_LIMIT");
    const login = await as("forwarded-pc-0004", "/api/auth/login", { method: "POST", body: { username: "s24-owner", password: "owner-pass-123" }, auth: null });
    assert.equal(login.json.code, "CLIENT_LIMIT", "login is counted too");
    assert.deepEqual((await Device.find({ role: "client", paired: true }).sort({ deviceId: 1 })).map((d) => d.deviceId), ["forwarded-pc-0001", "forwarded-pc-0002"]);
    assert.equal(await Device.countDocuments({ role: "main" }), 0);
    assert.equal(ok(await call("GET", "/api/license/info")).clientsUsed, 2);
  } finally { await forwarder.close(); }
});

it("MAIN WINDOW: loopback + the main-PC token is the main PC (no id needed, role main, not counted); a WRONG token (or one of another length) is a client", async () => {
  assert.equal((await call("GET", "/api/products")).status, 200, "the test's fetch sends the token, like the app's own window");
  assert.equal((await call("GET", "/api/products", undefined, { "x-nota-device-id": "main-window-pc-01", "x-nota-device-name": "Main" })).status, 200);
  assert.equal((await Device.findOne({ deviceId: "main-window-pc-01" })).role, "main");
  assert.equal(ok(await call("GET", "/api/license/info")).clientsUsed, 0);
  const real = mainPcToken();
  for (const wrong of ["not-the-token", `${real.slice(0, -1)}x`, `${real}x`, real.slice(0, 8)]) {
    const noId = await call("GET", "/api/products", undefined, { [NO_MAIN_TOKEN]: "1", [MAIN_TOKEN_HEADER]: wrong });
    assert.equal(noId.status, 400, "a wrong token is not the main PC: a device id is required");
    assert.equal(noId.json.code, "DEVICE_ID_REQUIRED");
  }
  const asClientOnLoopback = await call("GET", "/api/products", undefined, { [NO_MAIN_TOKEN]: "1", [MAIN_TOKEN_HEADER]: "wrong", "x-nota-device-id": "wrong-token-pc-01", "x-nota-device-name": "W" });
  assert.equal(asClientOnLoopback.status, 200);
  assert.equal((await Device.findOne({ deviceId: "wrong-token-pc-01" })).role, "client", "counted as a client");
});

it("the main-PC token: removed from the environment once read, compared in constant time, random when Electron sent none", async () => {
  assert.equal(process.env.NOTA_MAIN_TOKEN, undefined, "the variable is removed once read");
  assert.match(require("node:fs").readFileSync(require.resolve("../src/auth/mainPc"), "utf8"), /timingSafeEqual/);
  assert.ok(mainPcToken().length >= 32, "a random token even when Electron sent none");
});

it("DEVICE_IN_USE runs on AUTHENTICATED requests only: an unauthenticated / 401 request with a client's id from another IP records nothing and locks nobody", async () => {
  const header = { "x-nota-device-id": "client-pc-0001", "x-nota-device-name": "A" };
  assert.equal((await callFrom("127.0.0.51", "GET", "/api/products", { headers: header })).status, 200, "the real client works");
  assert.equal((await callFrom("127.0.0.52", "GET", "/api/products", { headers: header, auth: null })).status, 401, "not signed in");
  assert.equal((await callFrom("127.0.0.52", "POST", "/api/auth/login", { body: { username: "s24-owner", password: "wrong-password" }, headers: header, auth: null })).status, 401, "a failed login records nothing either");
  assert.equal((await callFrom("127.0.0.51", "GET", "/api/products", { headers: header })).status, 200, "the real client is not locked out");
  assert.equal((await callFrom("127.0.0.53", "GET", "/api/products", { headers: header, auth: null })).status, 401);
  assert.equal((await callFrom("127.0.0.51", "GET", "/api/products", { headers: header })).status, 200);
  assert.equal((await callFrom("127.0.0.52", "GET", "/api/products", { headers: header })).json.code, "DEVICE_IN_USE", "the copy IS refused once it is signed in");
});

it("DEVICE_IN_USE at LOGIN, after the credentials are verified: a copied id is refused at sign-in (ar + en); a wrong password from there is a plain 401 and records nothing", async () => {
  const header = { "x-nota-device-id": "client-pc-0001", "x-nota-device-name": "A" };
  const login = (source, password = "owner-pass-123") => callFrom(source, "POST", "/api/auth/login", { body: { username: "s24-owner", password }, headers: header, auth: null });
  const first = await login("127.0.0.51");
  assert.equal(first.status, 200);
  assert.equal((await login("127.0.0.52", "wrong-password")).status, 401, "a wrong password never gets as far as the device check");
  assert.equal((await login("127.0.0.52", "wrong-password")).json.code === "DEVICE_IN_USE", false);
  const copied = await login("127.0.0.52");
  assert.equal(copied.status, 403, "right credentials, but the id is in use at another address");
  assert.equal(copied.json.code, "DEVICE_IN_USE");
  assert.ok(copied.json.message.includes("بيستخدمه جهاز تاني") && /another PC/.test(copied.json.messageEn));
  assert.equal(copied.json.token, undefined, "no token is issued");
  assert.equal((await login("127.0.0.51")).status, 200, "the PC that was there first signs in again");
  assert.equal(await Device.countDocuments({ deviceId: "client-pc-0001" }), 1);
});

it("maxClients 0 = main PC only", async () => {
  installTestLicense({ maxClients: 0 });
  assert.equal((await clientCall("client-pc-0001")).json.code, "CLIENT_LIMIT");
});

it("only the owner can unpair or re-allow; a PC registered before Stage 24 is paired by migration 12", async () => {
  const { migrations } = require("../src/migrations");
  await Device.collection.insertOne({ deviceId: "old-client-pc-01", name: "Old", role: "client", lastSeenAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  await migrations.find((m) => m.version === 12).run(null);
  assert.equal((await Device.findOne({ deviceId: "old-client-pc-01" })).paired, true);
  ok(await call("POST", "/api/users", { name: "Mgr", username: "s24-mgr2", password: "secret-pass-1", role: "manager" }), 201);
  const mgr = ok(await call("POST", "/api/auth/login", { username: "s24-mgr2", password: "secret-pass-1" })).token;
  const previous = token; token = mgr;
  assert.equal((await call("DELETE", "/api/license/clients/old-client-pc-01")).status, 403);
  assert.equal((await call("POST", "/api/license/clients/old-client-pc-01/allow")).status, 403);
  token = previous;
  ok(await call("DELETE", "/api/license/clients/old-client-pc-01"));
  token = mgr;
  assert.equal((await call("POST", "/api/license/clients/old-client-pc-01/allow")).status, 403, "a manager cannot re-allow it either");
  token = previous;
});

it("the license module keeps its OWN references to crypto: replacing crypto.verify / createPublicKey / createHash after it loaded does not make a forged license pass", () => {
  const dir = path.join(__dirname, "..", "src", "license");
  const files = ["index", "keys", "format", "machineId", "build-flags", "test-key"].map((name) => require.resolve(path.join(dir, name)));
  const saved = files.map((file) => [file, require.cache[file]]);
  const originals = { verify: crypto.verify, createPublicKey: crypto.createPublicKey, createHash: crypto.createHash };
  files.forEach((file) => delete require.cache[file]);
  try {
    const fresh = require("../src/license"); // a fresh copy, loaded now: it takes its references now (server.js loads it before any dependency)
    const realMachine = require("../src/license/machineId").getMachineId();
    // what code loaded later (a dependency from node_modules) could do
    crypto.verify = () => true;
    crypto.createPublicKey = () => { throw new Error("hijacked"); };
    crypto.createHash = () => { throw new Error("hijacked"); };
    assert.equal(crypto.verify(null, Buffer.from("x"), "not a key", Buffer.alloc(1)), true, "the hijack is real: code that calls crypto.verify at call time would now accept anything");

    const forged = issueTestLicense({ shopName: "مزوّر" }, otherPrivateKey()); // signed by someone else
    assert.equal(fresh.verifyText(forged).ok, false);
    assert.equal(fresh.verifyText(forged).code, "BAD_SIGNATURE");
    const [a, p, s] = issueTestLicense({}).split(".");
    const edited = JSON.parse(Buffer.from(p, "base64url")); edited.maxClients = 999;
    assert.equal(fresh.verifyText(`${a}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${s}`).code, "BAD_SIGNATURE", "a tampered license too");
    assert.equal(fresh.verifyText(issueTestLicense({})).ok, true, "and a real one still verifies (createPublicKey / verify are the genuine ones)");
    assert.equal(require("../src/license/machineId").getMachineId(), realMachine, "the Machine ID does not depend on crypto.createHash being genuine at call time");
  } finally {
    Object.assign(crypto, originals);
    files.forEach((file) => delete require.cache[file]);
    for (const [file, entry] of saved) if (entry) require.cache[file] = entry;
  }
});

it("server.js loads the license code FIRST, before dotenv, express and every other dependency", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const requires = [...server.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(requires[0], "./license", requires.join(", "));
  const text = fs.readFileSync(path.join(__dirname, "..", "src", "license", "index.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "src", "license", "keys.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "src", "license", "machineId.js"), "utf8");
  assert.ok(!/\bcrypto\.(verify|createPublicKey|createHash)\b/.test(text.replace(/\/\/.*$/gm, "")), "no call goes through the crypto module object at call time");
  assert.ok(!/\bfs\.(readFileSync|writeFileSync|renameSync|mkdirSync)\b/.test(text.replace(/\/\/.*$/gm, "")), "nor through fs");
});

it("a save that repeats the license name and sends nameEn: null (the license has no English name) is accepted", async () => {
  installTestLicense({ shopName: "محل النور" }); // no English name in this license
  for (const nameEn of [null, undefined, ""]) {
    const response = await call("PUT", "/api/shop-profile", { name: "محل النور", ...(nameEn === undefined ? {} : { nameEn }), phones: [], address: "x" });
    assert.equal(response.status, 200, JSON.stringify(response.json));
  }
  assert.equal((await call("PUT", "/api/shop-profile", { name: "محل النور", nameEn: "Something", phones: [] })).json.code, "SHOP_NAME_LOCKED", "a real change is still refused");
  assert.equal((await call("PUT", "/api/shop-profile", { name: "", phones: [] })).json.code, "SHOP_NAME_LOCKED", "a blank name is a change");
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

