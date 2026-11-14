'use strict';

// Stage 19: the desktop app names this PC to the backend (X-Nota-Device-Id / X-Nota-Device-Name), next to the LAN
// key, on every request the pages send. The id is only for choosing a default cash box: it is not authentication.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEVICE_ID_HEADER, DEVICE_NAME_HEADER, DEVICE_NAME_MAX, LAN_KEY_HEADER, deviceNameHeader, installSecretHeader } = require('../lib/lan-auth');

// A fake Electron session: remembers the filter and the listener, and runs it like Electron does.
const fakeSession = () => {
  const session = {
    filter: null,
    listener: null,
    webRequest: { onBeforeSendHeaders(filter, listener) { session.filter = filter; session.listener = listener; } },
    send(headers = { Accept: 'application/json' }) {
      let result;
      session.listener({ requestHeaders: { ...headers } }, (answer) => { result = answer.requestHeaders; });
      return result;
    },
  };
  return session;
};

test('every request carries the LAN key, this PC\'s id and its hostname', () => {
  const session = fakeSession();
  installSecretHeader(session, { origin: 'http://127.0.0.1:5055', secret: 'SECRET-1234', deviceId: '0f8fad5b-d9cb-469f-a165-70867728950e', deviceName: 'CASHIER-PC' });
  assert.deepEqual(session.filter, { urls: ['http://127.0.0.1:5055/*'] });
  const headers = session.send();
  assert.equal(headers[LAN_KEY_HEADER], 'SECRET-1234');
  assert.equal(headers[DEVICE_ID_HEADER], '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.equal(headers[DEVICE_NAME_HEADER], 'CASHIER-PC');
  assert.equal(headers.Accept, 'application/json', 'other headers are kept');
});

test('the header names are the ones the backend reads', () => {
  assert.equal(DEVICE_ID_HEADER, 'X-Nota-Device-Id');
  assert.equal(DEVICE_NAME_HEADER, 'X-Nota-Device-Name');
  const backend = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'nota-backend', 'src', 'middlewares', 'device.middleware.js'), 'utf8');
  assert.ok(backend.includes(DEVICE_ID_HEADER.toLowerCase()), 'the backend middleware reads the id header');
  assert.ok(backend.includes(DEVICE_NAME_HEADER.toLowerCase()), 'the backend middleware reads the name header');
});

test('the hostname is trimmed to 64 characters and sent percent-encoded (Arabic names stay valid header text)', () => {
  assert.equal(DEVICE_NAME_MAX, 64);
  assert.equal(deviceNameHeader('  PC-1  '), 'PC-1');
  assert.equal(deviceNameHeader('x'.repeat(200)).length, 64);
  assert.equal(decodeURIComponent(deviceNameHeader('جهاز الكاشير')), 'جهاز الكاشير');
  assert.match(deviceNameHeader('جهاز الكاشير'), /^[\x20-\x7e]+$/, 'printable ASCII only');
  assert.equal(deviceNameHeader(''), '');
  assert.equal(deviceNameHeader(null), '');
});

test('without a device id (config not read yet) only the LAN key is added; the name never travels alone', () => {
  const session = fakeSession();
  installSecretHeader(session, { origin: 'http://192.168.1.10:5055', secret: 'SECRET-1234', deviceName: 'PC' });
  const headers = session.send();
  assert.equal(headers[LAN_KEY_HEADER], 'SECRET-1234');
  assert.equal(DEVICE_ID_HEADER in headers, false);
  assert.equal(DEVICE_NAME_HEADER in headers, false);
});

test('the id sent is the config instanceId of this PC: main.js builds it from state.config and exposes it as deviceId', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /deviceId: state\.config \? state\.config\.instanceId : null/);
  assert.match(main, /deviceName: os\.hostname\(\)/);
  assert.match(main, /deviceId: state\.config\.instanceId,\s*\n\s*deviceName: os\.hostname\(\)/, 'the runtime config hands the id to Angular');
  assert.equal((main.match(/installSecretHeader\(session\.defaultSession, deviceHeaderOptions\(\)\)/g) || []).length, 4, 'main PC (owner), attached session, client start and address change all send it');
  assert.equal(/installSecretHeader\(session\.defaultSession, \{ origin: state\.apiOrigin, secret: state\.secret \}\)/.test(main), false, 'no call site is left without the device');
});

test('a client PC sends its OWN id, never the main PC\'s (mainInstanceId): the default drawer follows the cashier PC', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('function deviceHeaderOptions()'), main.indexOf('function registerIpc()'));
  assert.match(block, /state\.config\.instanceId/);
  assert.equal(/mainInstanceId/.test(block), false);
  // The client's config keeps both: its own instanceId and the main PC's mainInstanceId.
  const store = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'config-store.js'), 'utf8');
  assert.match(store, /instanceId: raw\.instanceId/);
  assert.match(store, /config\.mainInstanceId/);
});

test('the open-shift float hint no longer says the float posts nothing: a confirmed difference is posted to cash over/short', () => {
  const i18n = (language) => fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'assets', 'i18n', `${language}.json`), 'utf8');
  const en = JSON.parse(i18n('en')).cashbox.shift;
  const ar = JSON.parse(i18n('ar')).cashbox.shift;
  assert.match(en.openingFloatHint, /over\/short/);
  assert.equal(/posts no entry/i.test(en.openingFloatHint), false);
  assert.equal(/ومش بيسجل/.test(ar.openingFloatHint), false);
});
