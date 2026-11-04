'use strict';

// Starts mongod then the backend, restarts whichever one crashes, and stops them in the
// reverse order. Knows nothing about Electron, so it is unit-tested with fake services.

const { EventEmitter } = require('node:events');

// Delays before restart attempts 1, 2, 3 ... After the last one the supervisor gives up and
// reports "failed" until the user presses retry.
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
// A service that stays up this long counts as healthy again, which resets the delays.
const STABLE_AFTER_MS = 120000;

class MainPcSupervisor extends EventEmitter {
  constructor({
    mongod,
    backend,
    log,
    restartDelaysMs = RESTART_DELAYS_MS,
    stableAfterMs = STABLE_AFTER_MS,
    timers = { setTimeout, clearTimeout },
    now = Date.now,
  }) {
    super();
    this.mongod = mongod;
    this.backend = backend;
    this.log = log;
    this.restartDelaysMs = restartDelaysMs;
    this.stableAfterMs = stableAfterMs;
    this.timers = timers;
    this.now = now;
    this.status = { state: 'stopped' };
    this.attempts = 0;
    this.lastHealthyAt = 0;
    this.restartTimer = null;
    this.stopping = false;
    this.startPromise = null;
    this.maintenancePromise = null;

    mongod.on('exit', () => this.onServiceExit('mongod'));
    backend.on('exit', () => this.onServiceExit('backend'));
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.run().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async run() {
    this.stopping = false;
    this.attempts = 0;
    this.setStatus({ state: 'starting' });
    try {
      await this.mongod.start();
      if (this.stopping) return;
      await this.backend.start();
      if (this.stopping) return;
      this.lastHealthyAt = this.now();
      this.setStatus({ state: 'running' });
    } catch (error) {
      this.log.error(`start failed: ${error.code || ''} ${error.message}`);
      await this.backend.stop().catch(() => {});
      await this.mongod.stop().catch(() => {});
      this.setStatus({ state: 'failed', code: error.code || 'START_FAILED', message: error.message, detail: error.detail });
    }
  }

  // Runs task with the backend stopped and mongod running (backups and restores, so nothing
  // writes meanwhile), then starts the backend again, whether or not the task succeeded.
  // Client PCs are cut off meanwhile. reason ('backup', 'auto-backup', 'restore') is reported
  // in the status.
  runMaintenance(task, { reason = 'restore' } = {}) {
    if (this.status.state !== 'running' || this.maintenancePromise) {
      const error = new Error('الخادم غير جاهز الآن أو توجد عملية أخرى قيد التنفيذ. حاول مرة أخرى بعد قليل.');
      error.code = 'SERVER_BUSY';
      return Promise.reject(error);
    }
    this.maintenancePromise = (async () => {
      this.setStatus({ state: 'maintenance', reason });
      try {
        await this.backend.stop();
        return await task();
      } finally {
        if (!this.stopping) {
          try {
            if (!this.mongod.running) await this.mongod.start();
            await this.backend.start();
            this.lastHealthyAt = this.now();
            this.setStatus({ state: 'running' });
          } catch (error) {
            this.log.error(`could not restart after maintenance: ${error.message}`);
            this.setStatus({ state: 'failed', code: error.code || 'START_FAILED', message: error.message, detail: error.detail });
          }
        }
        this.maintenancePromise = null;
      }
    })();
    return this.maintenancePromise;
  }

  onServiceExit(name) {
    if (this.stopping || this.status.state === 'failed') return;
    // During maintenance the task fails on its own and the server is restarted afterwards.
    if (this.maintenancePromise) {
      this.log.warn(`${name} stopped during maintenance`);
      return;
    }
    // Only a crash after a long healthy run starts the delays over; failed restarts do not.
    if (this.status.state === 'running' && this.now() - this.lastHealthyAt >= this.stableAfterMs) {
      this.attempts = 0;
    }

    if (this.attempts >= this.restartDelaysMs.length) {
      this.log.error(`${name} keeps stopping, giving up`);
      this.setStatus({
        state: 'failed',
        code: 'RESTART_LIMIT',
        message: 'يتوقف الخادم بشكل متكرر. راجع السجلات ثم اضغط إعادة المحاولة.',
      });
      return;
    }

    const delay = this.restartDelaysMs[this.attempts];
    this.attempts += 1;
    this.log.warn(`${name} stopped; restart attempt ${this.attempts} in ${delay} ms`);
    this.setStatus({ state: 'restarting', service: name, attempt: this.attempts });

    if (this.restartTimer) this.timers.clearTimeout(this.restartTimer);
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      this.restart(name);
    }, delay);
  }

  async restart(name) {
    if (this.stopping) return;
    try {
      // mongod first: the backend's driver reconnects on its own once mongod is back.
      if (!this.mongod.running) await this.mongod.start();
      if (!this.backend.running) await this.backend.start();
      if (this.stopping) return;
      this.lastHealthyAt = this.now();
      this.log.info(`${name} restarted`);
      this.setStatus({ state: 'running' });
    } catch (error) {
      this.log.error(`restart of ${name} failed: ${error.message}`);
      this.onServiceExit(name);
    }
  }

  // Backend first, so no request is cut off mid-write, then mongod.
  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      this.timers.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.startPromise) await this.startPromise.catch(() => {});
    // Let a running restore finish (or roll back) before the database stops.
    if (this.maintenancePromise) await this.maintenancePromise.catch(() => {});
    this.setStatus({ state: 'stopping' });
    try {
      await this.backend.stop();
    } catch (error) {
      this.log.error(`backend stop failed: ${error.message}`);
    }
    try {
      await this.mongod.stop();
    } catch (error) {
      this.log.error(`mongod stop failed: ${error.message}`);
    }
    this.setStatus({ state: 'stopped' });
  }
}

module.exports = { MainPcSupervisor, RESTART_DELAYS_MS, STABLE_AFTER_MS };
