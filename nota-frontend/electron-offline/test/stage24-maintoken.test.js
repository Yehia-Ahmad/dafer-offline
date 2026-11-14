'use strict';

// Stage 24 last fixes: the per-start main-PC token. Electron main makes it, gives it to the backend in its environment and adds it ONLY to its
// own windows' requests (the app's own session), never to the print partition and never on a client PC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildBackendEnv } = require('../lib/backend-manager');
const { installSecretHeader, MAIN_TOKEN_HEADER } = require('../lib/lan-auth');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const TOKEN = 'ab'.repeat(32);

function fakeSession() {
  const state = { filter: null, handler: null };
  return { state, webRequest: { onBeforeSendHeaders: (filter, handler) => { state.filter = filter; state.handler = handler; } } };
}
const sendThrough = (session, headers = {}) => new Promise((resolve) => session.state.handler({ requestHeaders: headers }, (result) => resolve(result.requestHeaders)));

test('the backend environment carries the token as NOTA_MAIN_TOKEN (and only when one is given)', () => {
  const base = { port: 5055, mongoUri: 'mongodb://x', secret: 'S', appVersion: '1', instanceId: 'id', sourceEnv: {} };
  assert.equal(buildBackendEnv({ ...base, mainToken: TOKEN }).NOTA_MAIN_TOKEN, TOKEN);
  assert.equal('NOTA_MAIN_TOKEN' in buildBackendEnv(base), false);
});

test('the main PC window adds X-Nota-Main-Token; a client PC window (no token) does not; a page cannot choose the value', async () => {
  const main = fakeSession();
  installSecretHeader(main, { origin: 'http://127.0.0.1:5055', secret: 'SECRET-1234', deviceId: '0f8fad5b-d9cb-469f-a165-70867728950e', deviceName: 'PC', mainToken: TOKEN });
  assert.equal(main.state.filter.urls[0], 'http://127.0.0.1:5055/*');
  const sent = await sendThrough(main, { 'X-Nota-Main-Token': 'forged-by-the-page' });
  assert.equal(sent[MAIN_TOKEN_HEADER], TOKEN, 'main overwrites whatever the page set');

  const client = fakeSession();
  installSecretHeader(client, { origin: 'http://192.168.1.10:5055', secret: 'SECRET-1234', deviceId: '0f8fad5b-d9cb-469f-a165-70867728950e', deviceName: 'PC' });
  assert.equal(MAIN_TOKEN_HEADER in (await sendThrough(client)), false);
});

test('main.js: a random 32-byte token at every start, passed to the backend, sent only in the main role, never logged, not on the print partition', () => {
  assert.match(MAIN, /mainToken: require\('crypto'\)\.randomBytes\(32\)\.toString\('hex'\)/, 'random, made when the app starts');
  assert.match(MAIN, /mainToken: state\.mainToken,\s*\n\s*\}\),/, 'handed to the backend through its environment');
  assert.match(MAIN, /mainToken: state\.mode === 'main' \|\| state\.mode === 'attached' \? state\.mainToken : undefined/, 'only the main role (owner or attached) sends it');
  assert.equal((MAIN.match(/installSecretHeader\(session\.defaultSession, deviceHeaderOptions\(\)\)/g) || []).length, 4, 'only the app\'s own session');
  const lines = MAIN.split('\n').filter((line) => /mainToken/.test(line));
  for (const line of lines) {
    assert.ok(!/log\.|logger|console\.|writeFile|writeConfig/.test(line), `the token reaches no log or file: ${line.trim()}`);
  }
  assert.ok(!/writeConfig\([^)]*mainToken/.test(MAIN));
  const printService = fs.readFileSync(path.join(__dirname, '..', 'lib', 'print-service.js'), 'utf8');
  assert.ok(!/mainToken|Main-Token/.test(printService), 'the print partition never gets it');
});
