#!/usr/bin/env node
// Nota vendor license tool (Stage 24). Runs on the vendor's own PC only. Never ships with the app.
//
//   node license-gen.js keygen --out <dir>
//   node license-gen.js issue  --key <private.pem> --machine XXXX-XXXX-XXXX-XXXX --shop "اسم المحل" [--shop-en "Name"] --max-clients N [--out file.lic]
//   node license-gen.js verify --pub <public.pem> <file.lic>
//
// The license text format comes from the backend's own module, so what this tool issues is exactly what the backend checks.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { encodePayload, buildText, parseText, payloadProblem, MACHINE_ID_PATTERN } = require("../../nota-backend/src/license/format");

const CSV_NAME = "issued-licenses.csv";

const fail = (message) => { process.stderr.write(`error: ${message}\n`); process.exit(1); };

/** `--name value` pairs and bare words. */
const parseArgs = (argv) => {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) fail(`missing value for ${argv[i]}`);
      flags[argv[i].slice(2)] = next; i += 1;
    } else rest.push(argv[i]);
  }
  return { flags, rest };
};

const keygen = ({ out }) => {
  if (!out) fail("keygen needs --out <dir>");
  const dir = path.resolve(out);
  const privatePath = path.join(dir, "private.pem");
  const publicPath = path.join(dir, "public.pem");
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) fail(`a key already exists in ${dir}. Refusing to overwrite it (delete it by hand only if you are sure)`);
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(publicPath, publicPem, { flag: "wx" });
  process.stdout.write(`Created ${privatePath} (KEEP OFFLINE, back it up) and ${publicPath}.\n\nPublic key to compile into nota-backend/src/license/keys.js:\n${publicPem}`);
};

const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;

const issue = (flags) => {
  const { key, machine, shop, "shop-en": shopEn, "max-clients": maxClientsText, out } = flags;
  if (!key || !machine || !shop || maxClientsText === undefined) fail("issue needs --key, --machine, --shop and --max-clients");
  const machineId = machine.trim().toUpperCase();
  if (!MACHINE_ID_PATTERN.test(machineId)) fail("--machine must look like XXXX-XXXX-XXXX-XXXX (hex)");
  if (!/^\d+$/.test(maxClientsText)) fail("--max-clients must be a whole number (0 = main PC only)");
  const maxClients = Number(maxClientsText);
  let privateKey;
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(key))); } catch (error) { fail(`cannot read the private key: ${error.message}`); }
  const payload = {
    v: 1,
    licenseId: `NOTA-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    type: "lifetime",
    shopName: shop.trim(),
    ...(shopEn && shopEn.trim() ? { shopNameEn: shopEn.trim() } : {}),
    machineId,
    maxClients,
    issuedAt: new Date().toISOString(),
  };
  const problem = payloadProblem(payload);
  if (problem) fail(`the license would be invalid (${problem}): check the shop name length and --max-clients (0 to 1000)`);
  const bytes = encodePayload(payload);
  const text = buildText(bytes, crypto.sign(null, bytes, privateKey));
  if (out) fs.writeFileSync(path.resolve(out), `${text}\n`, "utf8");
  const csv = path.join(path.dirname(path.resolve(key)), CSV_NAME);
  const isNew = !fs.existsSync(csv);
  fs.appendFileSync(csv, `${isNew ? "﻿licenseId,date,shop,machine,maxClients\n" : ""}${[payload.licenseId, payload.issuedAt, payload.shopName, machineId, maxClients].map(csvCell).join(",")}\n`, "utf8");
  process.stdout.write(`${text}\n`);
  process.stderr.write(`License ${payload.licenseId} for "${payload.shopName}" (${machineId}, ${maxClients} client PCs)${out ? `, written to ${out}` : ""}. Logged in ${csv}\n`);
};

const verify = ({ pub }, files) => {
  if (!pub || files.length !== 1) fail("verify needs --pub <public.pem> <file.lic>");
  let publicKey;
  try { publicKey = crypto.createPublicKey(fs.readFileSync(path.resolve(pub))); } catch (error) { fail(`cannot read the public key: ${error.message}`); }
  const parsed = parseText(fs.readFileSync(path.resolve(files[0]), "utf8"));
  if (!parsed) fail("not a Nota license (expected NOTA1.<payload>.<signature>)");
  let signed = false;
  try { signed = crypto.verify(null, parsed.payloadBytes, publicKey, parsed.signature); } catch { signed = false; }
  process.stdout.write(`${JSON.stringify(parsed.payload, null, 2)}\n`);
  if (!signed) fail("INVALID: the signature does not match this public key");
  const problem = payloadProblem(parsed.payload);
  if (problem) fail(`INVALID: ${problem}`);
  process.stdout.write("OK: signature valid. (It still only works on the PC whose Machine ID is in the license.)\n");
};

const main = () => {
  const [command, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseArgs(argv);
  if (command === "keygen") return keygen(flags);
  if (command === "issue") return issue(flags);
  if (command === "verify") return verify(flags, rest);
  return fail("usage: license-gen.js keygen --out <dir> | issue --key <private.pem> --machine <ID> --shop <name> [--shop-en <name>] --max-clients <N> [--out file.lic] | verify --pub <public.pem> <file.lic>");
};

main();
