'use strict';

// Finds the main PC on the shop LAN with a UDP broadcast (no mDNS, no extra libraries).
//
// Client PCs send a small probe to UDP port 5056 on every local network; the main PC answers
// with its name, HTTP port, version and a fixed instance ID. The LAN secret is never sent.

const dgram = require('node:dgram');
const os = require('node:os');

const DISCOVERY_PORT = 5056;
const PROBE = 'NOTA_OFFLINE_DISCOVER_V1';
const REPLY_TYPE = 'nota-offline-server';
const MAX_REPLY_BYTES = 2048;

function ipToInt(ip) {
  return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

// Directed broadcast addresses of the PC's IPv4 networks, plus the global broadcast address.
// Some routers and Windows setups drop 255.255.255.255, so both are used.
function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const addresses = new Set(['255.255.255.255']);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal || !entry.netmask) continue;
      const mask = ipToInt(entry.netmask);
      addresses.add(intToIp((ipToInt(entry.address) & mask) | (~mask >>> 0)));
    }
  }
  return [...addresses];
}

// This PC's LAN addresses, shown on the main PC so they can be typed on a client by hand.
function localIPv4Addresses(interfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) result.push({ name, address: entry.address });
    }
  }
  return result;
}

function parseReply(message) {
  if (message.length > MAX_REPLY_BYTES) return null;
  let reply;
  try {
    reply = JSON.parse(message.toString('utf8'));
  } catch {
    return null;
  }
  if (!reply || reply.type !== REPLY_TYPE || reply.v !== 1) return null;
  if (typeof reply.instanceId !== 'string' || !Number.isInteger(reply.port)) return null;
  return {
    instanceId: reply.instanceId,
    shopName: typeof reply.shopName === 'string' ? reply.shopName.slice(0, 100) : '',
    port: reply.port,
    appVersion: typeof reply.appVersion === 'string' ? reply.appVersion.slice(0, 40) : '',
  };
}

// Runs on the main PC while it holds the server lock.
class DiscoveryResponder {
  constructor({ getInfo, log, port = DISCOVERY_PORT }) {
    this.getInfo = getInfo;
    this.log = log;
    this.port = port;
    this.socket = null;
  }

  start() {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      socket.on('message', (message, remote) => {
        if (message.length !== PROBE.length || message.toString('utf8') !== PROBE) return;
        const reply = Buffer.from(JSON.stringify({ type: REPLY_TYPE, v: 1, ...this.getInfo() }));
        socket.send(reply, remote.port, remote.address);
      });
      socket.once('error', (error) => {
        // Discovery is a convenience: clients can still connect by typing the address.
        this.log.warn(`discovery responder unavailable: ${error.message}`);
        socket.close();
        this.socket = null;
        resolve();
      });
      socket.bind({ port: this.port, address: '0.0.0.0', exclusive: true }, () => {
        this.socket = socket;
        this.log.info(`discovery responder listening on UDP ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (!this.socket) return Promise.resolve();
    const socket = this.socket;
    this.socket = null;
    return new Promise((resolve) => socket.close(() => resolve()));
  }
}

// Broadcasts a few probes and collects the answers. Each main PC appears once.
function discoverServers({ timeoutMs = 2500, port = DISCOVERY_PORT, targets, interfaces } = {}) {
  const destinations = targets || [...broadcastAddresses(interfaces), '127.0.0.1'];
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket('udp4');
    const timers = [];

    const finish = () => {
      timers.forEach(clearTimeout);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };

    socket.on('message', (message, remote) => {
      const reply = parseReply(message);
      if (!reply) return;
      const known = found.get(reply.instanceId);
      // Prefer a LAN address over the loopback answer of a main PC on this very computer.
      if (!known || (known.address === '127.0.0.1' && remote.address !== '127.0.0.1')) {
        found.set(reply.instanceId, { ...reply, address: remote.address });
      }
    });
    socket.on('error', finish);

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const probe = Buffer.from(PROBE);
      const sendAll = () => {
        for (const address of destinations) socket.send(probe, port, address, () => {});
      };
      // UDP can drop packets, so probe three times.
      sendAll();
      timers.push(setTimeout(sendAll, 400), setTimeout(sendAll, 1000), setTimeout(finish, timeoutMs));
    });
  });
}

module.exports = {
  DISCOVERY_PORT,
  DiscoveryResponder,
  PROBE,
  broadcastAddresses,
  discoverServers,
  localIPv4Addresses,
  parseReply,
};
