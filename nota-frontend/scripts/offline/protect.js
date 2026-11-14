'use strict';

// Stage 24: turns the backend source into what ships.
//
//   1. prepareProductionSource: the staged copy gets TEST_BUILD = false and loses test-key.js, so it contains the
//      production key only.
//   2. sourceProblems: the build FAILS if the staged source still has the test key, a "true" test flag, the placeholder
//      production key, or a private key / key file.
//   3. compileToBytecode: every .js becomes V8 bytecode (.jsc), compiled by the exact Electron that runs the backend
//      (ELECTRON_RUN_AS_NODE, a build-time use only), and the .js is replaced by a two-line loader stub.
//   4. stagedProblems: nothing but stubs may remain as .js.
//
// Bytecode is not encryption: it keeps the shop from reading or patching the code with a text editor.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLACEHOLDER_MARKER = 'NOTA_PLACEHOLDER_REPLACE_WITH_PRODUCTION_PUBLIC_KEY';
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const KEY_FILE = /\.(pem|key|p12|pfx)$/i;

const stubFor = (baseName) => `require('bytenode');\nmodule.exports = require('./${baseName}.jsc');\n`;

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full, entry);
  }
}

const jsFiles = (dir) => {
  const files = [];
  walk(dir, (full) => { if (full.endsWith('.js')) files.push(full); });
  return files;
};

/** Test flag off, test key gone. `productionKeyPem` is for tests only: it swaps the compiled-in production key. */
function prepareProductionSource(srcDir, { productionKeyPem } = {}) {
  const license = path.join(srcDir, 'license');
  fs.writeFileSync(path.join(license, 'build-flags.js'), '// Build-time constant. false in the staged (shipped) backend.\nmodule.exports = { TEST_BUILD: false };\n');
  fs.rmSync(path.join(license, 'test-key.js'), { force: true });
  if (productionKeyPem) {
    const file = path.join(license, 'keys.js');
    const text = fs.readFileSync(file, 'utf8');
    const replaced = text.replace(/const PRODUCTION_PUBLIC_KEY_PEM = `[^`]*`;/, () => `const PRODUCTION_PUBLIC_KEY_PEM = \`${productionKeyPem.trim()}\`;`);
    if (replaced === text) throw new Error('could not find PRODUCTION_PUBLIC_KEY_PEM in keys.js');
    fs.writeFileSync(file, replaced);
  }
}

/** Reasons the plain (not yet compiled) staged source must not ship. Empty = fine. */
function sourceProblems(srcDir) {
  const problems = [];
  const license = path.join(srcDir, 'license');
  if (fs.existsSync(path.join(license, 'test-key.js'))) problems.push('src/license/test-key.js (the test key) is in the staged backend');
  const flags = path.join(license, 'build-flags.js');
  if (!fs.existsSync(flags) || /TEST_BUILD\s*:\s*true/.test(fs.readFileSync(flags, 'utf8'))) problems.push('src/license/build-flags.js has TEST_BUILD true (or is missing)');
  const keys = path.join(license, 'keys.js');
  if (!fs.existsSync(keys)) problems.push('src/license/keys.js is missing');
  else {
    // The literal itself (the file also defines the marker constant, so searching the whole file would always hit).
    const literal = /const PRODUCTION_PUBLIC_KEY_PEM = `([^`]*)`;/.exec(fs.readFileSync(keys, 'utf8'));
    let valid = false;
    if (literal && !literal[1].includes('PLACEHOLDER')) {
      try { valid = crypto.createPublicKey(literal[1]).asymmetricKeyType === 'ed25519'; } catch { valid = false; }
    }
    if (!valid) problems.push('the production public key is still the placeholder (or not an Ed25519 key): put your key in nota-backend/src/license/keys.js (tools/license-gen/README.md, step 2)');
  }
  walk(srcDir, (full) => {
    if (KEY_FILE.test(full)) problems.push(`key file: ${path.relative(srcDir, full)}`);
    else if (full.endsWith('.js') && PRIVATE_KEY_BLOCK.test(fs.readFileSync(full, 'utf8'))) problems.push(`private key block in ${path.relative(srcDir, full)}`);
  });
  return problems;
}

/** Private key anywhere in a staged folder (text files up to 4 MB). Returns relative paths. */
function findPrivateKeys(dir, { skip = [] } = {}) {
  const hits = [];
  walk(dir, (full) => {
    const relative = path.relative(dir, full);
    if (skip.some((part) => relative.split(path.sep).includes(part))) return;
    if (KEY_FILE.test(full)) { hits.push(relative); return; }
    if (/\.(png|jpe?g|ico|woff2?|ttf|gz|zip|exe|dll|node|svg|pdf|jsc|asar|map)$/i.test(full)) return;
    if (fs.statSync(full).size > 4 * 1024 * 1024) return;
    if (PRIVATE_KEY_BLOCK.test(fs.readFileSync(full, 'utf8'))) hits.push(relative);
  });
  return hits;
}

/** Compiles every .js under srcDir with the given Electron binary. Returns { files, electron }. */
function compileToBytecode({ srcDir, electronPath, nodeModules }) {
  const result = spawnSync(electronPath, [path.join(__dirname, 'compile-bytecode.js'), srcDir], {
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: nodeModules },
  });
  if (result.status !== 0) throw new Error(`bytecode compile failed (${result.status}): ${result.stderr || result.stdout}`);
  const line = (result.stdout || '').trim().split('\n').pop();
  return JSON.parse(line);
}

/** After compiling: every .js must be exactly a loader stub with a .jsc beside it. */
function stagedProblems(srcDir) {
  const problems = [];
  for (const file of jsFiles(srcDir)) {
    const base = path.basename(file, '.js');
    if (fs.readFileSync(file, 'utf8') !== stubFor(base)) problems.push(`readable JavaScript in the staged backend: ${path.relative(srcDir, file)}`);
    if (!fs.existsSync(path.join(path.dirname(file), `${base}.jsc`))) problems.push(`no bytecode for ${path.relative(srcDir, file)}`);
  }
  return problems;
}

module.exports = { PLACEHOLDER_MARKER, stubFor, jsFiles, prepareProductionSource, sourceProblems, findPrivateKeys, compileToBytecode, stagedProblems };
