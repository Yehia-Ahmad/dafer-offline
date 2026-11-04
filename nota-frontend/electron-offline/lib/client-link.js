'use strict';

// Client PC side of the connection to the main PC: checking the address and secret, finding a
// main PC again after its IP address changed, and watching the connection while the app runs.

const { EventEmitter } = require('node:events');
const { LAN_KEY_HEADER } = require('./lan-auth');
const { discoverServers } = require('./discovery');

const PROBE_TIMEOUT_MS = 3000;
const CHECK_INTERVAL_MS = 10000;
const RECOVERY_INTERVAL_MS = 3000;
const REDISCOVER_EVERY_FAILURES = 3;

function isValidHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  // Computer names such as SHOP-PC also work on most LANs.
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(value);
}

// result.status: ok | unauthorized | unreachable | not-nota
async function probeServer({ host, port, secret, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(`http://${host}:${port}/api/lan/info`, {
      headers: { [LAN_KEY_HEADER]: secret },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { status: 'unreachable', detail: error.cause ? error.cause.code || error.cause.message : error.message };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON: not our server
  }
  if (response.status === 401 && body && body.code === 'LAN_KEY_INVALID') return { status: 'unauthorized' };
  if (response.ok && body && body.app === 'nota-backend' && body.lanMode === true) {
    return { status: 'ok', info: body };
  }
  return { status: 'not-nota', detail: `HTTP ${response.status}` };
}

// Watches the link to the main PC and reports changes. When the main PC stops answering it
// probes more often, and every few failures it looks for the same main PC (by instance ID)
// at a new address, in case its IP address changed.
class ConnectionMonitor extends EventEmitter {
  constructor({ getTarget, log, discover = discoverServers, timers = { setTimeout, clearTimeout } }) {
    super();
    this.getTarget = getTarget; // () => ({ host, port, secret, instanceId })
    this.log = log;
    this.discover = discover;
    this.timers = timers;
    this.connected = true;
    this.failures = 0;
    this.timer = null;
    this.running = false;
    this.checking = null;
  }

  start() {
    this.running = true;
    this.schedule(CHECK_INTERVAL_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (!this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.check();
    }, delay);
  }

  // Also called by the retry button.
  check() {
    if (!this.checking) {
      this.checking = this.runCheck().finally(() => {
        this.checking = null;
      });
    }
    return this.checking;
  }

  async runCheck() {
    const target = this.getTarget();
    const result = await probeServer(target);

    if (result.status === 'ok') {
      this.failures = 0;
      if (!this.connected) {
        this.connected = true;
        this.log.info('main PC reachable again');
        this.emit('change', { connected: true });
      }
      this.schedule(CHECK_INTERVAL_MS);
      return result;
    }

    this.failures += 1;
    if (this.connected || result.status === 'unauthorized') {
      this.connected = false;
      this.log.warn(`main PC not reachable: ${result.status} ${result.detail || ''}`);
      this.emit('change', { connected: false, reason: result.status });
    }

    if (result.status === 'unreachable' && this.failures % REDISCOVER_EVERY_FAILURES === 0 && target.instanceId) {
      const servers = await this.discover();
      const same = servers.find((server) => server.instanceId === target.instanceId);
      if (same && (same.address !== target.host || same.port !== target.port)) {
        this.log.info(`main PC found at a new address ${same.address}:${same.port}`);
        this.emit('moved', { host: same.address, port: same.port });
      }
    }
    this.schedule(RECOVERY_INTERVAL_MS);
    return result;
  }
}

module.exports = { ConnectionMonitor, isValidHost, probeServer };
