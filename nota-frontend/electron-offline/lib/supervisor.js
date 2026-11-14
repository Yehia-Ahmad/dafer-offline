'use strict';

// Starts mongod then the backend, restarts whichever one crashes, and stops them in the
// reverse order. Knows nothing about Electron, so it is unit-tested with fake services.

const { EventEmitter } = require('node:events');

// Delays before restart attempts 1, 2, 3 ... After the last one the supervisor gives up and
// reports "failed" until the user presses retry.
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

// Stage 24: the code that is about to run must be what the installer put there. A damaged installation is final: no retries.
function damagedError(problems) {
  const error = new Error('ملفات البرنامج اتغيّرت أو ناقصة، فالتثبيت تالف. أعد تثبيت البرنامج (بياناتك على الجهاز مش هتتأثر). / The installation is damaged. Reinstall the app; your data is not affected.');
  error.code = 'INSTALLATION_DAMAGED';
  error.detail = (problems || []).slice(0, 5).join('\n');
  return error;
}

// The status for a start that failed: "damaged" (the reinstall screen) or the usual "failed".
function failureStatus(error) {
  if (error && error.code === 'INSTALLATION_DAMAGED') return { state: 'damaged', code: error.code, message: error.message, detail: error.detail };
  return { state: 'failed', code: (error && error.code) || 'START_FAILED', message: error && error.message, detail: error && error.detail };
}
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
    // Stage 24: () => ({ ok, problems }), run before EVERY backend start (first start, crash restarts, after a backup or restore).
    verifyInstallation = null,
  }) {
    super();
    this.verifyInstallation = verifyInstallation;
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

  // The only way the backend is started: the installation is checked first, every time, so a file changed after the app started is
  // caught at the next restart (a crash, a backup, a restore).
  async startBackend() {
    if (this.verifyInstallation) {
      const check = await this.verifyInstallation(); // sync or async
      if (!check.ok) throw damagedError(check.problems);
    }
    await this.backend.start();
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
      await this.startBackend();
      if (this.stopping) return;
      this.lastHealthyAt = this.now();
      this.setStatus({ state: 'running' });
    } catch (error) {
      this.log.error(`start failed: ${error.code || ''} ${error.message}`);
      await this.backend.stop().catch(() => {});
      await this.mongod.stop().catch(() => {});
      this.setStatus(failureStatus(error));
    }
  }

  // Runs task with the backend stopped and mongod running (backups and restores, so nothing
  // writes meanwhile), then starts the backend again, whether or not the task succeeded.
  // Client PCs are cut off meanwhile. reason ('backup', 'auto-backup', 'restore') is reported
  // in the status.
  runMaintenance(task, { reason = 'restore', recoverRestart } = {}) {
    if (this.status.state !== 'running' || this.maintenancePromise) {
      const error = new Error('الخادم غير جاهز الآن أو توجد عملية أخرى قيد التنفيذ. حاول مرة أخرى بعد قليل.');
      error.code = 'SERVER_BUSY';
      return Promise.reject(error);
    }
    this.maintenancePromise = (async () => {
      this.setStatus({ state: 'maintenance', reason });
      let result;
      let failure;
      try {
        await this.backend.stop();
        result = await task();
      } catch (error) {
        failure = error;
      }
      if (!this.stopping) {
        try {
          if (!this.mongod.running) await this.mongod.start();
          await this.startBackend();
          this.lastHealthyAt = this.now();
          this.setStatus({ state: 'running' });
        } catch (error) {
          if (!failure && recoverRestart && error.code !== 'INSTALLATION_DAMAGED') {
            try {
              failure = await recoverRestart(error, result) || error;
              if (!this.mongod.running) await this.mongod.start();
              await this.startBackend();
              this.lastHealthyAt = this.now();
              this.setStatus({ state: 'running' });
            } catch (recoveryError) {
              failure = recoveryError;
            }
          } else {
            failure = failure || error;
          }
          if (this.status.state !== 'running') {
            this.log.error(`could not restart after maintenance: ${error.message}`);
            this.setStatus(failureStatus(failure));
          }
        }
      }
      this.maintenancePromise = null;
      if (failure) throw failure;
      return result;
    })();
    return this.maintenancePromise;
  }

  onServiceExit(name) {
    if (this.stopping || this.status.state === 'failed' || this.status.state === 'damaged') return;
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
      if (!this.backend.running) await this.startBackend();
      if (this.stopping) return;
      this.lastHealthyAt = this.now();
      this.log.info(`${name} restarted`);
      this.setStatus({ state: 'running' });
    } catch (error) {
      this.log.error(`restart of ${name} failed: ${error.message}`);
      if (error.code === 'INSTALLATION_DAMAGED') {
        // Not retried: the files must be reinstalled. mongod keeps running only until the app is closed (no backend, so nothing reaches it).
        this.setStatus(failureStatus(error));
        return;
      }
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

module.exports = { MainPcSupervisor, RESTART_DELAYS_MS, STABLE_AFTER_MS, damagedError, failureStatus };
