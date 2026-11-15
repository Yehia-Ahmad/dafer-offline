'use strict';

// Stage 25: the bundled, bytecode backend. Runs against the REAL staged backend (offline:stage first). A missing stage fails these
// tests, like the Stage 24 real-stage test, unless NOTA_ALLOW_SKIP=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FRONTEND = path.resolve(__dirname, '..', '..');
const BACKEND = path.resolve(FRONTEND, '..', 'nota-backend');
const STAGED = path.join(FRONTEND, 'offline-stage', 'backend');
const { issueTestLicense } = require(path.join(BACKEND, 'test', 'helpers', 'license.js'));
const integrity = require('../lib/integrity');
let electronPath = null;
try { electronPath = require('electron'); } catch { electronPath = null; }

const staged = fs.existsSync(path.join(STAGED, 'src', 'server.jsc'));
const skip = process.env.NOTA_ALLOW_SKIP === '1' && (!staged || typeof electronPath !== 'string') ? 'no staged backend (NOTA_ALLOW_SKIP=1)' : false;

const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

test('the staged backend is a bundle: a handful of files, loader stubs plus bytecode, third-party notices, no source map', { skip }, () => {
  assert.ok(staged, 'no staged backend: run offline:stage first');
  const files = walkFiles(STAGED).map((file) => path.relative(STAGED, file).replace(/\\/g, '/'));
  assert.ok(files.length < 40, `${files.length} files`);
  for (const required of ['src/server.js', 'src/server.jsc', 'src/license/index.js', 'src/license/index.jsc', 'src/driver.js', 'src/driver.jsc', 'integrity.json', 'package.json', 'THIRD_PARTY_LICENSES.txt', 'node_modules/bytenode/package.json']) assert.ok(files.includes(required), `${required} is staged`);
  assert.ok(!files.some((file) => file.endsWith('.map')), 'no source map inside the staged backend');
  assert.equal(fs.readFileSync(path.join(STAGED, 'src', 'server.js'), 'utf8'), "require('bytenode');\nmodule.exports = require('./server.jsc');\n");
  assert.ok(!files.some((file) => /test-key/.test(file)), 'no test key file');
  const licenses = fs.readFileSync(path.join(STAGED, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
  for (const name of ['express', 'mongoose', 'mongodb', 'bson']) assert.match(licenses, new RegExp(`==== ${name} `), `${name} license text is kept`);
  const manifest = JSON.parse(fs.readFileSync(path.join(STAGED, 'integrity.json'), 'utf8')).files;
  for (const file of files.filter((name) => name !== 'integrity.json')) assert.ok(file in manifest, `${file} is covered by the tamper check`);
});

test('the source maps of the bundle are kept next to the stage (release artifacts), never inside the backend or the app', { skip }, () => {
  const maps = path.join(FRONTEND, 'offline-stage', 'sourcemaps');
  assert.ok(fs.existsSync(path.join(maps, 'backend-server.js.map')) && fs.existsSync(path.join(maps, 'backend-license-index.js.map')));
  for (const dir of [STAGED, path.join(FRONTEND, 'offline-stage', 'app')]) {
    assert.ok(!walkFiles(dir).some((file) => /backend-.*\.js\.map$|server\.js\.map$/.test(file)), `no bundle source map under ${path.basename(dir)}`);
  }
});

test('a changed bundle is caught by the tamper check (the bytecode, and the loader stub)', { skip }, async () => {
  const copy = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nota-bundle-'));
  try {
    fs.cpSync(STAGED, copy, { recursive: true });
    const seal = { manifestSha256: integrity.sha256(fs.readFileSync(path.join(copy, 'integrity.json'))) };
    assert.deepEqual(await integrity.verifyBackendAsync({ backendDir: copy, seal }), { ok: true, problems: [] });
    fs.appendFileSync(path.join(copy, 'src', 'server.jsc'), 'x');
    assert.deepEqual((await integrity.verifyBackendAsync({ backendDir: copy, seal })).problems, ['changed: src/server.jsc']);
    fs.cpSync(path.join(STAGED, 'src', 'server.jsc'), path.join(copy, 'src', 'server.jsc'));
    fs.writeFileSync(path.join(copy, 'src', 'server.js'), "require('bytenode');\nrequire('child_process');\nmodule.exports = require('./server.jsc');\n");
    assert.deepEqual((await integrity.verifyBackendAsync({ backendDir: copy, seal })).problems, ['changed: src/server.js']);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('the license module still loads first in the bundle and stays a single instance: hijacking crypto after it loaded does not let a forged license pass', { skip: skip || (typeof electronPath === 'string' ? false : 'electron is not installed') }, () => {
  const forged = issueTestLicense({ shopName: 'مزوّر' }); // signed with the TEST key, which a production build does not accept
  const script = `
    const assert = require('node:assert');
    const path = require('node:path');
    const crypto = require('node:crypto');
    // what the Electron main process does first (main.js requires src/license), before anything else
    const license = require('./src/license');
    // code loaded later tries to bend crypto
    crypto.verify = () => true;
    const before = license.verifyText(process.env.FORGED_LICENSE);
    // the whole server bundle loads now (load-only), and its license is the SAME module instance, not a second copy
    require('./src/server.js');
    crypto.createPublicKey = () => { throw new Error('hijacked'); };
    crypto.createHash = () => { throw new Error('hijacked'); };
    const again = require('./src/license');
    assert.strictEqual(again, license, 'the server bundle shares the main process license module instance');
    const after = again.verifyText(process.env.FORGED_LICENSE);
    console.log(JSON.stringify({ before: before.ok, after: after.ok, code: after.code }));
  `;
  const result = spawnSync(electronPath, ['-e', script], {
    cwd: STAGED,
    encoding: 'utf8',
    timeout: 60000,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', NOTA_STAGE_LOAD_CHECK: '1', FORGED_LICENSE: forged },
  });
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.deepEqual(answer, { before: false, after: false, code: answer.code });
  assert.ok(answer.code, 'a refusal code');
});

test('strip: docs, types, maps, tests and examples go; LICENSE files and runtime files stay', () => {
  const { stripNodeModules } = require('../../scripts/offline/strip');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nota-strip-'));
  try {
    const pkg = path.join(root, 'left-pad');
    const write = (relative, text = 'x') => { fs.mkdirSync(path.dirname(path.join(pkg, relative)), { recursive: true }); fs.writeFileSync(path.join(pkg, relative), text); };
    for (const gone of ['README.md', 'readme.txt', 'CHANGELOG.md', 'HISTORY', 'docs/guide.html', 'example/a.js', 'examples/b.js', 'test/t.js', 'tests/t.js', '__tests__/t.js', 'index.d.ts', 'lib/x.d.mts', 'lib/x.js.map', 'notes.md']) write(gone);
    for (const kept of ['index.js', 'lib/x.js', 'package.json', 'LICENSE', 'LICENSE.md', 'LICENSE-MIT', 'COPYING', 'NOTICE', 'data/tests-data.json']) write(kept);
    write('test/LICENSE', 'nested license');
    const result = stripNodeModules(root);
    assert.ok(result.files >= 14);
    const left = walkFiles(pkg).map((file) => path.relative(pkg, file).split(path.sep).join('/')).sort();
    assert.deepEqual(left, ['COPYING', 'LICENSE', 'LICENSE-MIT', 'LICENSE.md', 'NOTICE', 'data/tests-data.json', 'index.js', 'lib/x.js', 'package.json', 'test/LICENSE'].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Electron main process still gets the MongoDB driver and bson from the bundled backend (src/driver.js), and main.js falls back to node_modules in a dev checkout', { skip: skip || (typeof electronPath === 'string' ? false : 'electron is not installed') }, () => {
  const result = spawnSync(electronPath, ['-e', "const d = require('./src/driver.js'); console.log(JSON.stringify([typeof d.mongodb.MongoClient, typeof d.bson.ObjectId, typeof d.bson.Binary]))"], {
    cwd: STAGED,
    encoding: 'utf8',
    timeout: 60000,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['function', 'function', 'function']);
  const main = fs.readFileSync(path.join(FRONTEND, 'electron-offline', 'main.js'), 'utf8');
  assert.match(main, /'src', 'driver\.js'/);
  assert.match(main, /'node_modules', 'mongodb'/, 'dev checkout fallback');
});

test('a stack trace from the bytecode bundle decodes back to the original source file and line with the kept source map', { skip: skip || (typeof electronPath === 'string' ? false : 'electron is not installed') }, () => {
  const { decodeStack } = require('../../scripts/offline/decode-stack');
  const maps = path.join(FRONTEND, 'offline-stage', 'sourcemaps');
  const result = spawnSync(electronPath, ['-e', "try { new (require('./src/driver.js').bson.ObjectId)('not an id'); } catch (error) { console.log(error.stack); }"], {
    cwd: STAGED,
    encoding: 'utf8',
    timeout: 60000,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /driver\.jsc:1:\d+/, 'the raw bytecode frame is a character offset on line 1');
  const decoded = decodeStack(result.stdout, maps);
  assert.match(decoded, /at new ObjectId \(.*node_modules\/bson\/src\/objectid\.ts:\d+:\d+\)/, decoded);
  assert.ok(!/driver\.jsc:1:/.test(decoded), 'the bundle frame is replaced');
});

test('decode-stack: the source map decoder and the offset-to-line conversion (hand-made map)', () => {
  const { parseMap, originalPosition, offsetToLineColumn } = require('../../scripts/offline/decode-stack');
  // generated "ab\ncd": line 1 col 0 -> a.js 0:0, line 2 col 1 -> b.js 4:2 (VLQ: AAAA ; CCIE ... built by hand below)
  const map = { sources: ['a.js', 'b.js'], mappings: 'AAAA;CCIE' };
  const parsed = parseMap(map);
  assert.deepEqual(originalPosition(parsed, 1, 1), { source: 'a.js', line: 1, column: 1 });
  assert.deepEqual(originalPosition(parsed, 2, 2), { source: 'b.js', line: 5, column: 3 });
  assert.deepEqual(offsetToLineColumn('ab\ncd', 4), { line: 2, column: 2 });
  assert.equal(offsetToLineColumn('ab', 99), null);
});

test('strip: a doc/test/example folder deeper than the package root is code and stays (exceljs/lib/doc/workbook.js)', () => {
  const { stripNodeModules } = require('../../scripts/offline/strip');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nota-strip2-'));
  try {
    const pkg = path.join(root, 'exceljs');
    fs.mkdirSync(path.join(pkg, 'lib', 'doc'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'doc'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'lib', 'doc', 'workbook.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(pkg, 'doc', 'readme.html'), 'docs');
    stripNodeModules(root);
    assert.ok(fs.existsSync(path.join(pkg, 'lib', 'doc', 'workbook.js')));
    assert.ok(!fs.existsSync(path.join(pkg, 'doc')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
