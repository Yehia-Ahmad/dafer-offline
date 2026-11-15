'use strict';

// Stage 25, step F: the release script and the release key. The key pairs here are throwaway (made by the vendor tool into a temp folder and
// deleted at the end); no real key exists on this machine and none is ever written into the repo.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const FRONTEND = path.resolve(__dirname, '..', '..');
const BACKEND = path.resolve(FRONTEND, '..', 'nota-backend');
const TOOL = path.resolve(FRONTEND, '..', 'tools', 'license-gen', 'license-gen.js');
const release = require(path.join(FRONTEND, 'scripts', 'offline', 'release-win.js'));
const releaseKey = require(path.join(FRONTEND, 'scripts', 'offline', 'release-key.js'));
const { issueTestLicense } = require(path.join(BACKEND, 'test', 'helpers', 'license.js'));
let electronPath = null;
try { electronPath = require('electron'); } catch { electronPath = null; }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-release-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const keygen = (name) => {
  const dir = path.join(tmp, name);
  const made = spawnSync(process.execPath, [TOOL, 'keygen', '--out', dir], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return dir;
};
const TEST_PEM = require(path.join(BACKEND, 'src', 'license', 'test-key.js')).TEST_PUBLIC_KEY_PEM;
const write = (name, text) => { const file = path.join(tmp, name); fs.writeFileSync(file, text); return file; };
const baseEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const name of ['NOTA_RELEASE_PUBLIC_KEY_FILE', 'NOTA_ALLOW_PLACEHOLDER_KEY', 'NOTA_NO_BUNDLE', 'NOTA_ALLOW_SKIP', 'CSC_LINK']) if (!(name in extra)) delete env[name];
  return env;
};

// ------------------------------------------------------------------ the key file

test('the release key file: a public Ed25519 key passes; the placeholder, the test key, a private key, an RSA key, junk and a missing file are refused', () => {
  const keys = keygen('good-keys');
  const good = releaseKey.readReleaseKey(path.join(keys, 'public.pem'), { backendDir: BACKEND });
  assert.match(good.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(good.pem, /^-----BEGIN PUBLIC KEY-----/);

  const refuse = (file, pattern) => assert.throws(() => releaseKey.readReleaseKey(file, { backendDir: BACKEND }), pattern);
  refuse(undefined, /NOTA_RELEASE_PUBLIC_KEY_FILE is not set/);
  refuse(path.join(tmp, 'nope.pem'), /cannot read/);
  refuse(write('placeholder.pem', `-----BEGIN PUBLIC KEY-----\n${releaseKey.PLACEHOLDER_MARKER}\n-----END PUBLIC KEY-----\n`), /placeholder/);
  refuse(write('test-key.pem', TEST_PEM), /TEST key/);
  refuse(write('verification-key.pem', require(path.join(FRONTEND, 'scripts', 'offline', 'verification-key.js')).verificationPublicPem()), /VERIFICATION key/);
  refuse(path.join(keys, 'private.pem'), /PRIVATE key/);
  refuse(write('junk.pem', 'hello'), /not a PEM public key/);
  const rsa = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  refuse(write('rsa.pem', rsa.publicKey.export({ type: 'spki', format: 'pem' })), /rsa key/);
});

// ------------------------------------------------------------------ the preflight and the pieces

function fakeProject(version = '2.0.0', changelog) {
  const root = fs.mkdtempSync(path.join(tmp, 'proj-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog ?? `# log\n\n## ${version} - 2026-12-01\n\n### ar\n- جديد\n\n### en\n- new\n`);
  return root;
}

test('preflight: stops before any build for a missing/placeholder/test/private key, a forbidden dev variable, a missing changelog section or an existing release folder; passes with a temp key', () => {
  const keys = keygen('pre-keys');
  const pub = path.join(keys, 'public.pem');
  const root = fakeProject();
  const releaseRoot = path.join(tmp, 'release-offline');
  const pre = (env) => release.preflight({ env, rootDir: root, backendDir: BACKEND, releaseRoot });

  assert.throws(() => pre({}), /NOTA_RELEASE_PUBLIC_KEY_FILE is not set/);
  assert.throws(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: write('p2.pem', `-----BEGIN PUBLIC KEY-----\n${releaseKey.PLACEHOLDER_MARKER}\n-----END PUBLIC KEY-----`) }), /placeholder/);
  assert.throws(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: write('t2.pem', TEST_PEM) }), /TEST key/);
  assert.throws(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: write('v2.pem', require(path.join(FRONTEND, 'scripts', 'offline', 'verification-key.js')).verificationPublicPem()) }), /VERIFICATION key/);
  assert.throws(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: path.join(keys, 'private.pem') }), /PRIVATE key/);
  for (const name of release.FORBIDDEN_ENV) assert.throws(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: pub, [name]: '1' }), new RegExp(`${name} is set`));

  const noSection = fakeProject('3.0.0', '# log\n\n## 1.0.0 - 2026-11-14\n\n### ar\n- x\n\n### en\n- y\n');
  assert.throws(() => release.preflight({ env: { NOTA_RELEASE_PUBLIC_KEY_FILE: pub }, rootDir: noSection, backendDir: BACKEND, releaseRoot }), /no section for 3\.0\.0/);
  const arOnly = fakeProject('3.1.0', '## 3.1.0 - 2026-12-01\n\n### ar\n- x\n');
  assert.throws(() => release.preflight({ env: { NOTA_RELEASE_PUBLIC_KEY_FILE: pub }, rootDir: arOnly, backendDir: BACKEND, releaseRoot }), /both an Arabic and an English list/);
  const badVersion = fakeProject('1.0');
  assert.throws(() => release.preflight({ env: { NOTA_RELEASE_PUBLIC_KEY_FILE: pub }, rootDir: badVersion, backendDir: BACKEND, releaseRoot }), /plain x\.y\.z/);

  const ok = pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: pub });
  assert.equal(ok.version, '2.0.0');
  assert.match(ok.key.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(ok.entry.en, ['new']);

  fs.mkdirSync(path.join(releaseRoot, '2.0.0'), { recursive: true });
  assert.throws(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: pub }), /already exists/);
  assert.doesNotThrow(() => pre({ NOTA_RELEASE_PUBLIC_KEY_FILE: pub, NOTA_RELEASE_OVERWRITE: '1' }));
});

test('the real repo: package.json version has a changelog section; the script only accepts known flags', () => {
  const keys = keygen('real-keys');
  const ok = release.preflight({ env: { NOTA_RELEASE_PUBLIC_KEY_FILE: path.join(keys, 'public.pem') }, rootDir: FRONTEND, backendDir: BACKEND, releaseRoot: path.join(tmp, 'nothing-here') });
  assert.equal(ok.version, require('../../package.json').version);
  assert.deepEqual(release.parseArgs(['--skip-tests', '--stage-only']), { skipTests: true, stageOnly: true });
  assert.deepEqual(release.parseArgs([]), { skipTests: false, stageOnly: false });
  assert.throws(() => release.parseArgs(['--fast']), /unknown argument/);
});

test('code signing: without CSC_LINK the builder runs unsigned and the build still works; with it signing is switched on (the certificate and password are only read from the environment)', () => {
  const unsigned = release.builderArgs({ env: {}, outputDir: 'release-offline/.build' });
  assert.deepEqual(unsigned, ['--win', 'nsis', '--config', 'electron-builder.offline.json', '--config.directories.output=release-offline/.build']);
  const signed = release.builderArgs({ env: { CSC_LINK: 'C:\\certs\\nota.pfx', CSC_KEY_PASSWORD: 'x' }, outputDir: 'o' });
  assert.ok(signed.includes('--config.win.signAndEditExecutable=true'));
  assert.ok(!signed.join(' ').includes('nota.pfx') && !signed.join(' ').includes('CSC_KEY_PASSWORD'), 'the certificate path and password never appear in the arguments');
  const config = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'electron-builder.offline.json'), 'utf8'));
  assert.equal(config.win.signAndEditExecutable, false, 'unsigned by default, so a build works without a certificate');
  assert.ok(!/CSC_KEY_PASSWORD\s*[:=]\s*['"][^'"]+/.test(fs.readFileSync(path.join(FRONTEND, 'scripts', 'offline', 'release-win.js'), 'utf8')), 'no password in the script');
});

test('release note: version, build, hash, key fingerprint, signing state, tests and the changelog in both languages; the maps folder is explained', () => {
  const note = release.releaseNote({
    version: '1.0.0', build: '20261114.2346', key: { fingerprint: 'a'.repeat(64) }, installer: 'Nota-Setup-1.0.0.exe', sha256: 'b'.repeat(64), size: 123456789,
    tests: 'all passed', signed: false, entry: { ar: ['جديد'], en: ['new'] }, builtAt: '2026-11-14T10:00:00Z',
  });
  for (const part of ['Nota 1.0.0 (build 20261114.2346)', 'b'.repeat(64), 'a'.repeat(64), 'NOT signed', 'SmartScreen', 'all passed', '- جديد', '- new', 'sourcemaps/', 'NOT inside the installer', '117.7 MB']) assert.ok(note.includes(part), part);
  assert.ok(release.releaseNote({ version: '1', build: 'b', key: { fingerprint: 'c' }, installer: 'x.exe', sha256: 'd', size: 1, tests: 't', signed: true, entry: { ar: [], en: [] }, builtAt: 'now' }).includes('signed with the configured certificate'));
});

test('the installed program must not contain source maps: a stray .map or a sourcemaps folder is reported', () => {
  const unpacked = path.join(tmp, 'win-unpacked');
  fs.mkdirSync(path.join(unpacked, 'resources', 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'resources', 'backend', 'src', 'server.js'), 'stub');
  const asar = require('@electron/asar');
  const appDir = path.join(tmp, 'asar-src');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'main.js'), 'x');
  return asar.createPackage(appDir, path.join(unpacked, 'resources', 'app.asar')).then(() => {
    assert.deepEqual(release.packageProblems(unpacked), []);
    fs.writeFileSync(path.join(unpacked, 'resources', 'backend', 'src', 'server.js.map'), '{}');
    fs.mkdirSync(path.join(unpacked, 'resources', 'sourcemaps'));
    const problems = release.packageProblems(unpacked);
    assert.equal(problems.length, 2, problems.join(' | '));
  });
});

// ------------------------------------------------------------------ the command line (fails before any build)

test('release:win from the command line: fails at once with the placeholder file, the test key and no key; nothing is staged', () => {
  const script = path.join(FRONTEND, 'scripts', 'offline', 'release-win.js');
  const run = (env, args = ['--stage-only', '--skip-tests']) => spawnSync(process.execPath, [script, ...args], { cwd: FRONTEND, encoding: 'utf8', env: baseEnv({ ...env, NOTA_RELEASE_OVERWRITE: '1' }), timeout: 60000 });
  const noKey = run({});
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /NOTA_RELEASE_PUBLIC_KEY_FILE is not set/);
  const placeholder = run({ NOTA_RELEASE_PUBLIC_KEY_FILE: write('cli-placeholder.pem', `-----BEGIN PUBLIC KEY-----\n${releaseKey.PLACEHOLDER_MARKER}\n-----END PUBLIC KEY-----`) });
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /placeholder/);
  const testKey = run({ NOTA_RELEASE_PUBLIC_KEY_FILE: write('cli-test.pem', TEST_PEM) });
  assert.equal(testKey.status, 1);
  assert.match(testKey.stderr, /TEST key/);
  const forbidden = run({ NOTA_RELEASE_PUBLIC_KEY_FILE: path.join(keygen('cli-keys'), 'public.pem'), NOTA_ALLOW_PLACEHOLDER_KEY: '1' });
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /NOTA_ALLOW_PLACEHOLDER_KEY is set/);
  for (const result of [noKey, placeholder, testKey, forbidden]) assert.ok(!/\[release\] (backend|frontend)/.test(result.stdout), 'no step ran');
  const verifKey = run({ NOTA_RELEASE_PUBLIC_KEY_FILE: write('cli-verif.pem', require(path.join(FRONTEND, 'scripts', 'offline', 'verification-key.js')).verificationPublicPem()) });
  assert.equal(verifKey.status, 1);
  assert.match(verifKey.stderr, /VERIFICATION key/);
  assert.equal(run({}, ['--bogus']).status, 1);
});

test('the repo keeps its placeholder key and no key file of any kind', () => {
  const keys = fs.readFileSync(path.join(BACKEND, 'src', 'license', 'keys.js'), 'utf8');
  assert.match(keys, /const PRODUCTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\r?\n\$\{PLACEHOLDER_MARKER\}\r?\n-----END PUBLIC KEY-----`;/);
  const readme = fs.readFileSync(path.join(FRONTEND, '..', 'tools', 'license-gen', 'README.md'), 'utf8');
  assert.match(readme, /NOTA_RELEASE_PUBLIC_KEY_FILE/, 'the key README explains the release path');
  assert.ok(!/Commit that change yourself/.test(readme), 'the old "commit the key" step is gone');
});

// ------------------------------------------------------------------ a real stage with a temp key

const distReady = fs.existsSync(path.join(FRONTEND, 'dist-offline', 'browser', 'index.html'));
const canStage = distReady && typeof electronPath === 'string' && fs.existsSync(path.join(FRONTEND, 'vendor', 'mongodb', 'versions.json'));

test('a REAL stage with a temp release key: the bundle carries that key (a license from the vendor tool is accepted, a test-key license is refused), the record and build-guard agree, the repo key is untouched, and the temp key is deleted afterwards', { skip: !canStage && process.env.NOTA_ALLOW_SKIP === '1' ? 'no build:offline output / vendor / electron (NOTA_ALLOW_SKIP=1)' : false, timeout: 900000 }, () => {
  assert.ok(canStage, 'run npm run build:offline and npm run offline:vendor first');
  const keys = keygen('stage-keys');
  const stageDir = path.join(tmp, 'stage-out');
  const stage = (keyFile, extra = {}) => spawnSync(process.execPath, [path.join(FRONTEND, 'scripts', 'offline', 'stage.js')], {
    cwd: FRONTEND, encoding: 'utf8', timeout: 600000, env: baseEnv({ NOTA_STAGE_DIR: stageDir, ...(keyFile ? { NOTA_RELEASE_PUBLIC_KEY_FILE: keyFile } : {}), ...extra }),
  });
  try {
    // the stage refuses the test key and a private key before it copies anything
    const refusedTest = stage(write('stage-test.pem', TEST_PEM));
    assert.equal(refusedTest.status, 1);
    assert.match(`${refusedTest.stdout}${refusedTest.stderr}`, /TEST key/);
    const refusedPrivate = stage(path.join(keys, 'private.pem'));
    assert.equal(refusedPrivate.status, 1);
    assert.match(`${refusedPrivate.stdout}${refusedPrivate.stderr}`, /PRIVATE key/);
    // the same key passed as a release key is refused by the stage itself
    const refusedVerification = stage(write('stage-verification.pem', require(path.join(FRONTEND, 'scripts', 'offline', 'verification-key.js')).verificationPublicPem()));
    assert.equal(refusedVerification.status, 1);
    assert.match(`${refusedVerification.stdout}${refusedVerification.stderr}`, /VERIFICATION key/);
    // no key and no placeholder permission: refused
    const none = stage(null);
    assert.equal(none.status, 1);
    assert.match(`${none.stdout}${none.stderr}`, /placeholder/);

    const staged = stage(path.join(keys, 'public.pem'));
    assert.equal(staged.status, 0, `${staged.stdout}\n${staged.stderr}`);
    assert.match(staged.stdout, /the license bundle carries the chosen production public key and no test key/);
    const record = JSON.parse(fs.readFileSync(path.join(stageDir, 'release-key.json'), 'utf8'));
    const expected = releaseKey.readReleaseKey(path.join(keys, 'public.pem'), { backendDir: BACKEND });
    assert.equal(record.fingerprint, expected.fingerprint);
    assert.equal(record.placeholder, false);
    assert.equal(record.source, 'NOTA_RELEASE_PUBLIC_KEY_FILE');
    assert.ok(!fs.existsSync(path.join(stageDir, 'NON_RELEASABLE.json')));
    assert.equal(fs.existsSync(path.join(stageDir, 'sourcemaps', 'backend-server.js.map')), true);
    const guard = spawnSync(process.execPath, [path.join(FRONTEND, 'scripts', 'offline', 'build-guard.js')], { encoding: 'utf8', env: baseEnv({ NOTA_STAGE_DIR: stageDir }) });
    assert.equal(guard.status, 0, guard.stderr);

    // a verification stage (NOTA_ALLOW_PLACEHOLDER_KEY=1 carries the seed-derived verification key): non-releasable, and build-guard refuses it
    const verifyDir = path.join(tmp, 'verify-stage');
    const verifyRun = spawnSync(process.execPath, [path.join(FRONTEND, 'scripts', 'offline', 'stage.js')], { cwd: FRONTEND, encoding: 'utf8', timeout: 600000, env: baseEnv({ NOTA_STAGE_DIR: verifyDir, NOTA_ALLOW_PLACEHOLDER_KEY: '1' }) });
    assert.equal(verifyRun.status, 0, `${verifyRun.stdout}\n${verifyRun.stderr}`);
    assert.ok(fs.existsSync(path.join(verifyDir, 'NON_RELEASABLE.json')), 'marked non-releasable');
    const verifyRecord = JSON.parse(fs.readFileSync(path.join(verifyDir, 'release-key.json'), 'utf8'));
    assert.equal(verifyRecord.verification, true);
    assert.equal(verifyRecord.fingerprint, require(path.join(FRONTEND, 'scripts', 'offline', 'verification-key.js')).verificationFingerprint());
    const verifyGuard = spawnSync(process.execPath, [path.join(FRONTEND, 'scripts', 'offline', 'build-guard.js')], { encoding: 'utf8', env: baseEnv({ NOTA_STAGE_DIR: verifyDir }) });
    assert.equal(verifyGuard.status, 1);
    assert.match(verifyGuard.stderr, /NON-RELEASABLE/);
    assert.match(verifyGuard.stderr, /VERIFICATION key/);
    // the bundle itself, on the real Electron
    const backend = path.join(stageDir, 'backend');
    const probe = (licenseText) => {
      const licenseDir = fs.mkdtempSync(path.join(tmp, 'lic-'));
      if (licenseText) fs.writeFileSync(path.join(licenseDir, 'nota.lic'), licenseText);
      const result = spawnSync(electronPath, ['-e', "const l=require('./src/license');const s=l.summary();console.log(JSON.stringify({valid:l.isValid(),code:s.code,machineId:s.machineId}))"], {
        cwd: backend, encoding: 'utf8', timeout: 60000,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', NOTA_LICENSE_DIR: licenseDir },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').pop());
    };
    const machineId = probe(null).machineId;
    assert.match(machineId, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    const issued = spawnSync(process.execPath, [TOOL, 'issue', '--key', path.join(keys, 'private.pem'), '--machine', machineId, '--shop', 'محل الإصدار', '--max-clients', '1'], { encoding: 'utf8' });
    assert.equal(issued.status, 0, issued.stderr);
    const text = issued.stdout.trim().split('\n').find((line) => line.startsWith('NOTA1.'));
    assert.deepEqual(probe(text), { valid: true, code: null, machineId }, 'a license made with the temp key is accepted by the staged bundle');
    assert.equal(probe(issueTestLicense({ machineId })).valid, false, 'a test-key license is refused');
    assert.equal(probe(`${text}x`).valid, false, 'a tampered license is refused');
  } finally {
    fs.rmSync(keys, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(keys), false, 'the temp key pair is deleted');
  assert.match(fs.readFileSync(path.join(BACKEND, 'src', 'license', 'keys.js'), 'utf8'), /NOTA_PLACEHOLDER_REPLACE_WITH_PRODUCTION_PUBLIC_KEY/, 'keys.js in the repo still has the placeholder');
});

// ------------------------------------------------------------------ the smoke test target

test('smoke:offline defaults to the STAGED bundle: no stage fails with a clear message (skips only with NOTA_ALLOW_SKIP=1); a stage with a real key is explained; the source tree needs NOTA_SMOKE_SOURCE=1', () => {
  const smoke = path.join(FRONTEND, 'scripts', 'offline', 'smoke-test.js');
  const run = (env) => spawnSync(process.execPath, [smoke], { cwd: FRONTEND, encoding: 'utf8', timeout: 60000, env: baseEnv(env) });
  const empty = path.join(tmp, 'smoke-no-stage');
  const none = run({ NOTA_STAGE_DIR: empty });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no staged backend/);
  assert.match(none.stderr, /offline:stage/);
  assert.match(none.stderr, /NOTA_SMOKE_SOURCE=1/);
  const skipped = run({ NOTA_STAGE_DIR: empty, NOTA_ALLOW_SKIP: '1' });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /SKIPPED/);

  const real = path.join(tmp, 'smoke-real-stage');
  fs.mkdirSync(path.join(real, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(real, 'backend', 'src', 'server.jsc'), 'x');
  releaseKey.writeRecord(real, { placeholder: false, fingerprint: 'a'.repeat(64), source: 'NOTA_RELEASE_PUBLIC_KEY_FILE' });
  const refused = run({ NOTA_STAGE_DIR: real });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /real or unknown production key/);

  const source = fs.readFileSync(smoke, 'utf8');
  assert.match(source, /const SMOKE_SOURCE = process\.env\.NOTA_SMOKE_SOURCE === '1'/);
  assert.match(source, /startChild\(electronBinary\(\), \['src\/server\.js'\], \{ cwd: STAGED_BACKEND/);
  const releaseScript = fs.readFileSync(path.join(FRONTEND, 'scripts', 'offline', 'release-win.js'), 'utf8');
  assert.match(releaseScript, /offline-stage-verify/, 'release:win smokes a throwaway verification stage');
});

test('a verification stage carries the verification key (not the test key, not a release key) and is marked non-releasable', () => {
  const verification = require(path.join(FRONTEND, 'scripts', 'offline', 'verification-key.js'));
  const pem = verification.verificationPublicPem();
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
  assert.notEqual(releaseKey.fingerprintOfLiteral(pem), releaseKey.testKeyFingerprint(BACKEND), 'a different key from the test key');
  const license = verification.issueVerificationLicense({ shopName: 'x' }, { backendDir: BACKEND });
  assert.match(license, /^NOTA1\./);
  const stage = fs.readFileSync(path.join(FRONTEND, 'scripts', 'offline', 'stage.js'), 'utf8');
  assert.match(stage, /markNonReleasable\(STAGE, 'built with the verification key/);
});
