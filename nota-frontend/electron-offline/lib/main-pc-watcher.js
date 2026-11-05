'use strict';

// Stage 15: one main PC per shop. While this PC runs the server, it looks for another main PC on
// the LAN (the same UDP discovery the client PCs use) at startup and then every few minutes. A
// second main PC means two databases: invoices made on one never reach the other. It only warns
// (the banner for users with shop.manage); it never stops either PC.

const { EventEmitter } = require('node:events');
const { otherMainPcs } = require('./discovery');

const FIRST_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const sameList = (a, b) =>
  a.length === b.length && a.every((item, i) => item.instanceId === b[i].instanceId && item.address === b[i].address);

class MainPcWatcher extends EventEmitter {
  constructor({
    discover,
    ownInstanceId,
    log,
    firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
    checkIntervalMs = CHECK_INTERVAL_MS,
    timers = { setTimeout, clearTimeout },
  }) {
    super();
    this.discover = discover;
    this.ownInstanceId = ownInstanceId;
    this.log = log;
    this.firstCheckDelayMs = firstCheckDelayMs;
    this.checkIntervalMs = checkIntervalMs;
    this.timers = timers;
    this.timer = null;
    this.running = false;
    this.others = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(this.firstCheckDelayMs);
  }

  stop() {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay) {
    if (!this.running) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.check().finally(() => this.schedule(this.checkIntervalMs));
    }, delay);
  }

  async check() {
    let found;
    try {
      found = await this.discover();
    } catch (error) {
      this.log.warn(`main PC check failed: ${error.message}`);
      return this.others;
    }
    const others = otherMainPcs(found, { ownInstanceId: this.ownInstanceId })
      .map(({ instanceId, shopName, address, port }) => ({ instanceId, shopName, address, port }))
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    if (!sameList(others, this.others)) {
      if (others.length) this.log.warn(`another main PC answers on the LAN: ${others.map((o) => `${o.shopName} ${o.address}:${o.port}`).join(', ')}`);
      else if (this.others.length) this.log.info('the other main PC no longer answers');
      this.others = others;
      this.emit('change', others);
    }
    return others;
  }
}

module.exports = { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, MainPcWatcher };
