'use strict';

// Runs the Nota backend in an Electron utility process (Electron's own Node.js, so no
// node.exe is bundled) and stops it through the backend's graceful shutdown message.

const { EventEmitter } = require('node:events');
const EDITION = require('../edition.json');
const { ServiceError } = require('./mongod-manager');
const { sleep } = require('./net-utils');

const START_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 15000;

// Only what the backend needs. Nothing else from this process's environment is passed on,
// so stray variables from the user's environment can never reach it.
const PASSTHROUGH_ENV = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'PATH'];

// jwtSecret (Stage 13): the main PC's session-token secret, passed as NOTA_JWT_SECRET.
// NOTA_AUTH=1 (Stage 14): login and permissions are enforced. The backend refuses to start
// without a usable secret; main.js never starts it without one.
function buildBackendEnv({ port, mongoUri, secret, jwtSecret, appVersion, instanceId, sessionsValidAfter, auditInbox, sourceEnv = process.env }) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  return {
    ...env,
    NODE_ENV: 'production',
    PORT: String(port),
    NOTA_LISTEN_HOST: '0.0.0.0',
    MONGO_URI: mongoUri,
    NOTA_LAN_MODE: '1',
    NOTA_LAN_SECRET: secret,
    // Stage 14: users and permissions are on (login, permissions, cost stripping, audit).
    NOTA_AUTH: '1',
    ...(jwtSecret ? { NOTA_JWT_SECRET: jwtSecret } : {}),
    NOTA_APP_VERSION: appVersion,
    NOTA_INSTANCE_ID: instanceId,
    // Stage 15: tokens issued before the last restore are refused; backup audit entries written
    // while the backend was stopped are read from this file at startup.
    ...(sessionsValidAfter ? { NOTA_SESSIONS_VALID_AFTER: String(sessionsValidAfter) } : {}),
    ...(auditInbox ? { NOTA_AUDIT_INBOX: auditInbox } : {}),
  };
}

class BackendManager extends EventEmitter {
  constructor({ utilityProcess, serverPath, cwd, env, port, log, output }) {
    super();
    this.utilityProcess = utilityProcess;
    this.serverPath = serverPath;
    this.cwd = cwd;
    this.env = env;
    this.port = port;
    this.log = log;
    this.output = output; // receives the backend's console output
    this.child = null;
    this.stopping = false;
  }

  get running() {
    return Boolean(this.child);
  }

  // Stage 15: e.g. NOTA_SESSIONS_VALID_AFTER after a restore. Used from the next start on.
  updateEnv(patch) {
    this.env = { ...this.env, ...patch };
  }

  start() {
    if (this.child) return Promise.resolve();
    this.stopping = false;
    this.log.info(`starting backend on port ${this.port}`);

    return new Promise((resolve, reject) => {
      const child = this.utilityProcess.fork(this.serverPath, [], {
        cwd: this.cwd, // holds no .env file, so dotenv loads nothing
        env: this.env,
        stdio: 'pipe',
        serviceName: `${EDITION.productName} Server`,
      });
      this.child = child;
      if (child.stdout) child.stdout.on('data', this.output);
      if (child.stderr) child.stderr.on('data', this.output);

      let settled = false;
      let reportedError = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.error('backend did not report ready in time');
        child.kill();
        reject(new ServiceError('BACKEND_TIMEOUT', 'استغرق تشغيل الخادم وقتاً أطول من المتوقع.'));
      }, START_TIMEOUT_MS);

      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ready' && !settled) {
          settled = true;
          clearTimeout(timer);
          this.log.info(`backend is ready (pid ${child.pid})`);
          resolve();
        } else if (message.type === 'error') {
          reportedError = message;
        }
      });

      this.exited = new Promise((resolveExit) => {
        child.once('exit', (code) => {
          if (this.child === child) this.child = null;
          resolveExit(code);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(
              reportedError && reportedError.code === 'EADDRINUSE'
                ? new ServiceError(
                    'BACKEND_PORT_IN_USE',
                    `المنفذ ${this.port} مستخدم من برنامج آخر على هذا الجهاز. غيّر المنفذ من الإعدادات أو أغلق البرنامج الآخر.`
                  )
                : new ServiceError(
                    reportedError?.code || 'BACKEND_FAILED',
                    reportedError?.message || `تعذر تشغيل الخادم (رمز الخروج ${code}).`,
                    reportedError?.detail || reportedError?.message || ''
                  )
            );
            return;
          }
          if (!this.stopping) {
            this.log.error(`backend exited unexpectedly (code ${code})`);
            this.emit('exit', code);
          }
        });
      });
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.log.info('stopping backend');
    child.postMessage({ type: 'shutdown' });

    const timeout = sleep(STOP_TIMEOUT_MS).then(() => 'timeout');
    if ((await Promise.race([this.exited, timeout])) === 'timeout') {
      this.log.warn('backend did not exit in time, killing it');
      child.kill();
      await this.exited;
    }
    this.child = null;
    this.log.info('backend stopped');
  }
}

module.exports = { BackendManager, buildBackendEnv };
