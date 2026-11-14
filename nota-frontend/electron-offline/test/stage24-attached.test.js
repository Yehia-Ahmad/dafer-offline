'use strict';

// Stage 24: an attached session (a second Windows account on the main PC, Stage 15) must count as the main PC. The process that owns the
// server writes its main-PC token to a machine-scope DPAPI file; the attached session reads it and uses it for its window header.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnSync } = require('node:child_process');
const { FILE_NAME, writeMainToken, readMainToken, removeMainToken, restrictMainTokenFile } = require('../lib/main-token-file');
const { waitFor } = require('../lib/net-utils');
const { installSecretHeader, MAIN_TOKEN_HEADER } = require('../lib/lan-auth');
const secretStore = require('../lib/secret-store');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-attached-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// stand-ins for machine-scope DPAPI (the real one is Windows only and tested in the secret-store tests)
const protect = (text) => `P:${Buffer.from(text).toString('base64')}`;
const unprotect = (text) => { if (!text.startsWith('P:')) throw new Error('not protected'); return Buffer.from(text.slice(2), 'base64').toString(); };
const dirOf = (name) => { const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
const TOKEN = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

test('the owner writes the token (protected, never plain) and an attached session reads the same value', () => {
  const dir = dirOf('roundtrip');
  writeMainToken(dir, TOKEN, protect);
  const onDisk = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
  assert.ok(!onDisk.includes(TOKEN), 'the file does not hold the token in plain text');
  assert.equal(readMainToken(dir, unprotect), TOKEN);
  assert.throws(() => writeMainToken(dir, 'short', protect), /malformed/);
});

test('the file has its own DPAPI purpose, so it cannot be read back as another secret', () => {
  assert.throws(() => secretStore.protectSecret('x', { purpose: 'main-token', platform: 'linux' }), /needs Windows/, 'a known purpose (Windows only)');
  assert.throws(() => secretStore.protectSecret('x', { purpose: 'nope', platform: 'win32' }), /unknown secret purpose/);
});

test('a missing, unreadable or malformed file gives null (the attached session then shows the error) and never throws', () => {
  const dir = dirOf('missing');
  assert.equal(readMainToken(dir, unprotect), null);
  fs.writeFileSync(path.join(dir, FILE_NAME), 'garbage', 'utf8');
  assert.equal(readMainToken(dir, unprotect), null, 'unreadable');
  fs.writeFileSync(path.join(dir, FILE_NAME), protect('not-a-token'), 'utf8');
  assert.equal(readMainToken(dir, unprotect), null, 'malformed');
  assert.equal(readMainToken(path.join(tmp, 'no-such-dir'), unprotect), null);
});

test('removed on a clean exit; a stale file left by a crash is overwritten at the next start', () => {
  const dir = dirOf('lifecycle');
  writeMainToken(dir, TOKEN, protect);
  removeMainToken(dir);
  assert.ok(!fs.existsSync(path.join(dir, FILE_NAME)));
  removeMainToken(dir); // nothing to remove: no error
  writeMainToken(dir, TOKEN, protect); // the process crashes: the file stays
  assert.equal(readMainToken(dir, unprotect), TOKEN, 'stale file of the crashed process');
  writeMainToken(dir, OTHER, protect); // the next start makes a new token
  assert.equal(readMainToken(dir, unprotect), OTHER);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left');
});

test('attached mode: the header carries the OWNER token and the backend treats that request as the main PC (no device id, so no slot even with maxClients 0); without it, or with a wrong one, it is a client', async () => {
  const dir = dirOf('attached');
  writeMainToken(dir, TOKEN, protect); // the owning process
  const ownerToken = readMainToken(dir, unprotect); // the attached session
  const session = { handler: null, webRequest: { onBeforeSendHeaders: (_filter, handler) => { session.handler = handler; } } };
  installSecretHeader(session, { origin: 'http://127.0.0.1:5055', secret: 'SECRET-1234', deviceId: '0f8fad5b-d9cb-469f-a165-70867728950e', deviceName: 'ATTACHED-PC', mainToken: ownerToken });
  const sent = await new Promise((resolve) => session.handler({ requestHeaders: {} }, (result) => resolve(result.requestHeaders)));
  assert.equal(sent[MAIN_TOKEN_HEADER], TOKEN);

  // the backend, started by the owner with that token in its environment
  const backendRoot = path.resolve(__dirname, '..', '..', '..', 'nota-backend');
  assert.ok(fs.existsSync(path.join(backendRoot, 'src', 'auth', 'mainPc.js')), 'the backend is in the repo');
  const { spawnSync } = require('node:child_process');
  const probe = `
    const { isMainPc } = require(${JSON.stringify(path.join(backendRoot, 'src', 'auth', 'mainPc.js'))});
    const { deviceGate } = require(${JSON.stringify(path.join(backendRoot, 'src', 'middlewares', 'deviceGate.middleware.js'))});
    const request = (headers) => ({ method: 'GET', path: '/products', ip: '127.0.0.1', get: (name) => headers[name.toLowerCase()] });
    const run = (headers) => { let out = 'next'; deviceGate()(request(headers), {}, (error) => { if (error) out = error.responseData.code; }); return out; };
    const withToken = { 'x-nota-main-token': ${JSON.stringify(sent[MAIN_TOKEN_HEADER])} };
    console.log(JSON.stringify({ main: isMainPc(request(withToken)), gateWithToken: run(withToken), gateWithout: run({}), wrong: run({ 'x-nota-main-token': ${JSON.stringify(OTHER)} }) }));
  `;
  const env = { ...process.env, NOTA_MAIN_TOKEN: TOKEN, NODE_PATH: path.join(backendRoot, 'node_modules') };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), { main: true, gateWithToken: 'next', gateWithout: 'DEVICE_ID_REQUIRED', wrong: 'DEVICE_ID_REQUIRED' });
});

test('the file ACL (real icacls, Windows): writable only by the owning account and SYSTEM, read-only for BUILTIN\\Users, no inherited rights; the owner can replace it at the next start', { skip: process.platform === 'win32' ? false : 'Windows only' }, () => {
  const dir = dirOf('acl');
  const first = writeMainToken(dir, TOKEN, protect);
  assert.deepEqual(first, { restricted: true });
  const file = path.join(dir, FILE_NAME);
  const listing = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true }).stdout;
  const entries = listing.split(/\r?\n/).map((line) => line.replace(file, '').trim()).filter((line) => /:\(/.test(line));
  const sid = spawnSync(path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout.match(/"(S-1-[0-9-]+)"/)[1];
  const grants = Object.fromEntries(entries.map((line) => { const [who, rights] = [line.slice(0, line.lastIndexOf(':')), line.slice(line.lastIndexOf(':') + 1)]; return [who, rights]; }));
  assert.equal(entries.length, 3, `exactly three entries (Users, SYSTEM, the owner), got:\n${listing}`);
  assert.ok(entries.every((line) => !/\(I\)/.test(line)), 'nothing inherited');
  const users = entries.find((line) => /^BUILTIN\\Users:/i.test(line));
  const system = entries.find((line) => /^NT AUTHORITY\\SYSTEM:/i.test(line));
  assert.ok(users && /^\(RX?\)$/.test(users.slice(users.indexOf(':') + 1)), `Users read-only: ${users}`);
  assert.ok(system && /\(F\)/.test(system), `SYSTEM full: ${system}`);
  const owner = entries.filter((line) => line !== users && line !== system)[0];
  assert.ok(owner && /\(F\)/.test(owner), `the owning account has full control: ${owner} (sid ${sid})`);
  assert.ok(!/Everyone|Authenticated Users/i.test(listing));
  assert.equal(Object.keys(grants).length, 3);
  // the next start replaces it (same account) and the ACL is the same again
  assert.deepEqual(writeMainToken(dir, OTHER, protect), { restricted: true });
  assert.equal(readMainToken(dir, unprotect), OTHER, 'replaced');
  const again = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter((line) => /:\(/.test(line));
  assert.equal(again.length, 3);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('the ACL command: inheritance removed, Users read, SYSTEM and the owner full; a failure is reported, never thrown', () => {
  const calls = [];
  const ok = restrictMainTokenFile('X:\\f', { platform: 'win32', sid: () => 'S-1-5-21-1-2-3-1001', run: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.deepEqual(ok, { restricted: true });
  assert.deepEqual(calls[0][1], ['X:\\f', '/inheritance:r', '/grant:r', '*S-1-5-32-545:(R)', '/grant:r', '*S-1-5-18:(F)', '/grant:r', '*S-1-5-21-1-2-3-1001:(F)']);
  const failed = restrictMainTokenFile('X:\\f', { platform: 'win32', sid: () => 'S-1-5-21-1', run: () => ({ status: 5, stderr: 'Access is denied.' }) });
  assert.equal(failed.restricted, false);
  assert.match(failed.error, /Access is denied/);
  assert.equal(restrictMainTokenFile('X:\\f', { platform: 'win32', sid: () => { throw new Error('no sid'); }, run: () => ({ status: 0 }) }).restricted, false);
});

test('attached: the token file is read only AFTER the owner backend answers, and the read is retried for a few seconds before MAIN_TOKEN_UNAVAILABLE', async () => {
  const start = MAIN.indexOf('async function attachToRunningServer()');
  const attach = MAIN.slice(start, MAIN.indexOf('function readJwtSecret', start));
  const answers = attach.indexOf('waitFor(backendAnswers');
  const read = attach.indexOf('readMainToken(');
  const retry = attach.indexOf('waitFor(readOwnerToken, { timeoutMs: MAIN_TOKEN_WAIT_MS');
  const fail = attach.indexOf("code: 'MAIN_TOKEN_UNAVAILABLE'");
  assert.ok(answers > 0 && read > answers && retry > read && fail > retry, 'backend answers, then read with a retry, then the error');
  assert.match(MAIN, /const MAIN_TOKEN_WAIT_MS = \d{4,5};/, 'a few seconds');
  assert.match(attach, /if \(answered && !ownerToken\)/, 'the error shows only when the server answered but the file never became readable');

  // behaviour of the retry: a file that appears on the third look is picked up; one that never appears gives up
  let looks = 0;
  assert.equal(await waitFor(() => { looks += 1; return looks >= 3; }, { timeoutMs: 2000, intervalMs: 10 }), true);
  assert.equal(looks, 3);
  looks = 0;
  assert.equal(await waitFor(() => { looks += 1; return false; }, { timeoutMs: 60, intervalMs: 10 }), false);
  assert.ok(looks >= 2, 'looked more than once before giving up');
});

test('main.js: the owner writes the file after making its token; an attached session reads it BEFORE installing its header and shows MAIN_TOKEN_UNAVAILABLE when it cannot; the file goes on a clean exit; the token is never logged; the print partition never gets it', () => {
  const owner = MAIN.indexOf('writeMainToken(state.paths.security, state.mainToken');
  const ownerInstall = MAIN.indexOf('installSecretHeader(session.defaultSession, deviceHeaderOptions());', owner);
  assert.ok(owner > 0 && ownerInstall > owner, 'the owner writes the file, then installs its header');
  assert.match(MAIN, /purpose: 'main-token'/);

  const start = MAIN.indexOf('async function attachToRunningServer()');
  const attach = MAIN.slice(start, MAIN.indexOf('function readJwtSecret', start));
  const read = attach.indexOf('readMainToken(');
  const fail = attach.indexOf("code: 'MAIN_TOKEN_UNAVAILABLE'");
  const set = attach.indexOf('state.mainToken = ownerToken');
  const install = attach.indexOf('installSecretHeader(session.defaultSession, deviceHeaderOptions())');
  assert.ok(read > 0 && fail > read && set > fail && install > set, 'read, error if missing (and return), then use the owner token, then install the header');
  assert.match(attach.slice(fail, set), /return;/, 'no silent fall-back to a client');
  assert.match(attach, /started by another account: restart Nota/);

  assert.match(MAIN, /removeMainToken\(state\.paths\.security\);[^\n]*\n\s*await new Promise\(\(resolve\) => state\.serverLock\.close/, 'removed on a clean exit, by the owner only');
  const begin = MAIN.slice(MAIN.indexOf('async function beginRole('), MAIN.indexOf('async function backendAnswers'));
  assert.ok(!/installSecretHeader/.test(begin), 'beginRole installs no header: startMainRole does, for the final mode');

  for (const line of MAIN.split('\n').filter((l) => /mainToken|ownerToken/.test(l))) {
    assert.ok(!/log\.|logger|console\./.test(line), `the token reaches no log: ${line.trim()}`);
  }
  assert.ok(!/mainToken|Main-Token/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'print-service.js'), 'utf8')), 'the print partition never gets it');
});
