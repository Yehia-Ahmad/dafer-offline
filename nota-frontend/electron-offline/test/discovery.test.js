'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DiscoveryResponder, broadcastAddresses, discoverServers, parseReply } = require('../lib/discovery');

const silentLog = { info() {}, warn() {}, error() {} };

test('broadcast addresses come from each IPv4 network plus 255.255.255.255', () => {
  const addresses = broadcastAddresses({
    Ethernet: [
      { family: 'IPv4', address: '192.168.1.37', netmask: '255.255.255.0', internal: false },
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
    ],
    'Wi-Fi': [{ family: 'IPv4', address: '10.0.12.5', netmask: '255.255.0.0', internal: false }],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  });
  assert.deepEqual(addresses.sort(), ['10.0.255.255', '192.168.1.255', '255.255.255.255']);
});

test('replies are validated and never trusted blindly', () => {
  const good = Buffer.from(JSON.stringify({ type: 'nota-offline-server', v: 1, instanceId: 'id', port: 5055, shopName: 'Shop', appVersion: '1.0.0' }));
  assert.deepEqual(parseReply(good), { instanceId: 'id', shopName: 'Shop', port: 5055, appVersion: '1.0.0' });
  assert.equal(parseReply(Buffer.from('not json')), null);
  assert.equal(parseReply(Buffer.from(JSON.stringify({ type: 'other', v: 1, instanceId: 'id', port: 1 }))), null);
  assert.equal(parseReply(Buffer.from(JSON.stringify({ type: 'nota-offline-server', v: 1, port: '5055' }))), null);
  assert.equal(parseReply(Buffer.alloc(5000, 32)), null);
});

test('a client finds the responder over UDP and gets no secret', async () => {
  const port = 25056;
  const responder = new DiscoveryResponder({
    port,
    log: silentLog,
    getInfo: () => ({ instanceId: 'main-1', shopName: 'المحل', port: 5055, appVersion: '1.0.0' }),
  });
  await responder.start();
  try {
    const found = await discoverServers({ port, timeoutMs: 1200, targets: ['127.0.0.1'] });
    assert.equal(found.length, 1, 'three probes still give one entry');
    assert.deepEqual(found[0], { instanceId: 'main-1', shopName: 'المحل', port: 5055, appVersion: '1.0.0', address: '127.0.0.1' });
  } finally {
    await responder.stop();
  }
});

test('a second responder on the same port stays off instead of failing', async () => {
  const port = 25057;
  const getInfo = () => ({ instanceId: 'x', port: 5055 });
  const first = new DiscoveryResponder({ port, log: silentLog, getInfo });
  const second = new DiscoveryResponder({ port, log: silentLog, getInfo });
  await first.start();
  await second.start();
  assert.ok(first.socket);
  assert.equal(second.socket, null);
  await first.stop();
});

test('discovery with nobody answering returns an empty list', async () => {
  assert.deepEqual(await discoverServers({ port: 25058, timeoutMs: 600, targets: ['127.0.0.1'] }), []);
});
