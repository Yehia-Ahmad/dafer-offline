'use strict';

// Runs the bundled mongod.exe on 127.0.0.1 only and shuts it down cleanly.

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { rotateIfLarge } = require('./logger');
const { isPortFree, sleep, waitFor } = require('./net-utils');

const DATABASE_NAME = 'nota';
const START_TIMEOUT_MS = 120000; // crash recovery on a large database can take a while
const SHUTDOWN_RETRY_MS = 10000; // retry a normal shutdown while index builds finish
const EXIT_TIMEOUT_MS = 30000;

// Windows NTSTATUS exit codes worth explaining to the user.
const STATUS_ILLEGAL_INSTRUCTION = 0xc000001d; // CPU without AVX
const STATUS_DLL_NOT_FOUND = 0xc0000135; // Visual C++ runtime missing

class ServiceError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.detail = detail || '';
  }
}

function explainMongodExit(exitCode, logTail = '') {
  const code = exitCode >>> 0;
  if (code === STATUS_ILLEGAL_INSTRUCTION) {
    return new ServiceError(
      'CPU_UNSUPPORTED',
      'معالج هذا الجهاز لا يدعم قاعدة البيانات (يلزم معالج يدعم AVX). استخدم جهازاً أحدث كجهاز رئيسي.'
    );
  }
  if (code === STATUS_DLL_NOT_FOUND) {
    return new ServiceError(
      'RUNTIME_MISSING',
      'مكتبة Microsoft Visual C++ غير مثبتة على هذا الجهاز. أعد تشغيل برنامج التثبيت.'
    );
  }
  if (/DBPathInUse/.test(logTail)) {
    return new ServiceError('DATA_IN_USE', 'مجلد البيانات مستخدم من نسخة أخرى من قاعدة البيانات.');
  }
  return new ServiceError(
    'MONGOD_FAILED',
    `تعذر تشغيل قاعدة البيانات (رمز الخروج ${exitCode}).`,
    logTail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n')
  );
}

function readTail(file, bytes = 16384) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Removes the pid file only while it still names this process; a newer mongod may own it.
function removePidFileIfOwn(pidFile, pid) {
  try {
    if (Number(fs.readFileSync(pidFile, 'utf8').trim()) === pid) fs.rmSync(pidFile, { force: true });
  } catch {
    // Already gone.
  }
}

function processImageName(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const match = /^"([^"]+)"/.exec((result.stdout || '').trim());
  return match ? match[1].toLowerCase() : '';
}

class MongodManager extends EventEmitter {
  constructor({ mongodPath, dbPath, logFile, pidFile, port, mongodb, log, cacheSizeGB = 1 }) {
    super();
    this.mongodPath = mongodPath;
    this.dbPath = dbPath;
    this.logFile = logFile;
    this.pidFile = pidFile;
    this.port = port;
    this.mongodb = mongodb; // the MongoDB driver module bundled with the backend
    this.log = log;
    this.cacheSizeGB = cacheSizeGB;
    this.child = null;
    this.stopping = false;
  }

  get uri() {
    return `mongodb://127.0.0.1:${this.port}/${DATABASE_NAME}`;
  }

  get running() {
    return Boolean(this.child);
  }

  async ping(timeoutMs = 1000) {
    const client = new this.mongodb.MongoClient(this.uri, {
      serverSelectionTimeoutMS: timeoutMs,
      directConnection: true,
    });
    try {
      await client.db('admin').command({ ping: 1 });
      return true;
    } catch {
      return false;
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Normal shutdown, retried while index builds finish, then forced. On a single server,
  // force only aborts index builds (they resume on the next start); the journal keeps data safe.
  async sendShutdown() {
    const client = new this.mongodb.MongoClient(this.uri, {
      serverSelectionTimeoutMS: 2000,
      directConnection: true,
    });
    const startedAt = Date.now();
    try {
      for (;;) {
        const force = Date.now() - startedAt >= SHUTDOWN_RETRY_MS;
        try {
          await client.db('admin').command(force ? { shutdown: 1, force: true } : { shutdown: 1 });
          return;
        } catch (error) {
          if (!force && /index builds in progress/i.test(error.message)) {
            this.log.info('index builds in progress, retrying shutdown');
            await sleep(1000);
            continue;
          }
          // The connection drops while mongod exits; that is the expected outcome.
          if (error.name === 'MongoNetworkError' || /ECONNRESET|closed|ECONNREFUSED/i.test(error.message)) return;
          this.log.warn(`shutdown command: ${error.message}`);
          return;
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  // A mongod left over from a crash of the app still holds the data folder.
  async stopOrphan() {
    let pid;
    try {
      pid = Number(fs.readFileSync(this.pidFile, 'utf8').trim());
    } catch {
      return;
    }
    if (pid && isProcessAlive(pid) && processImageName(pid) === 'mongod.exe') {
      this.log.warn(`found mongod from a previous run (pid ${pid}), shutting it down`);
      if (await this.ping()) await this.sendShutdown();
      const exited = await waitFor(async () => !isProcessAlive(pid), { timeoutMs: EXIT_TIMEOUT_MS });
      if (!exited) {
        this.log.warn(`mongod pid ${pid} did not exit, killing it`);
        spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
      }
    }
    fs.rmSync(this.pidFile, { force: true });
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    await this.stopOrphan();

    if (!fs.existsSync(this.mongodPath)) {
      throw new ServiceError('MONGOD_MISSING', 'ملف قاعدة البيانات غير موجود. أعد تثبيت البرنامج.', this.mongodPath);
    }
    if (!(await isPortFree(this.port))) {
      throw new ServiceError(
        'MONGOD_PORT_IN_USE',
        `المنفذ ${this.port} الخاص بقاعدة البيانات مستخدم من برنامج آخر.`
      );
    }

    rotateIfLarge(this.logFile, { maxBytes: 20 * 1024 * 1024, keep: 2 });
    fs.mkdirSync(this.dbPath, { recursive: true });

    const args = [
      '--dbpath', this.dbPath,
      '--port', String(this.port),
      '--bind_ip', '127.0.0.1',
      '--logpath', this.logFile,
      '--logappend',
      '--wiredTigerCacheSizeGB', String(this.cacheSizeGB),
    ];
    this.log.info(`starting ${this.mongodPath} on 127.0.0.1:${this.port}`);
    const child = spawn(this.mongodPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    let exitCode = null;
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        exitCode = code === null ? signal : code;
        resolve();
      });
    });
    child.once('error', (error) => this.log.error(`mongod process error: ${error.message}`));
    fs.writeFileSync(this.pidFile, String(child.pid));

    const ready = await waitFor(() => this.ping(), {
      timeoutMs: START_TIMEOUT_MS,
      isCancelled: () => exitCode !== null,
    });

    if (!ready) {
      if (exitCode === null) {
        child.kill();
        await exited;
      }
      this.child = null;
      removePidFileIfOwn(this.pidFile, child.pid);
      const error =
        exitCode === null
          ? new ServiceError('MONGOD_TIMEOUT', 'استغرق تشغيل قاعدة البيانات وقتاً أطول من المتوقع.')
          : explainMongodExit(exitCode, `${stderr}\n${readTail(this.logFile)}`);
      this.log.error(`mongod failed to start: ${error.code} ${error.detail}`);
      throw error;
    }

    this.log.info(`mongod is ready (pid ${child.pid})`);
    exited.then(() => {
      if (this.child === child) this.child = null;
      removePidFileIfOwn(this.pidFile, child.pid);
      if (!this.stopping) {
        this.log.error(`mongod exited unexpectedly (code ${exitCode})`);
        this.emit('exit', exitCode);
      }
    });
    this.exited = exited;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.log.info('stopping mongod');
    await this.sendShutdown();

    const timeout = sleep(EXIT_TIMEOUT_MS).then(() => 'timeout');
    if ((await Promise.race([this.exited, timeout])) === 'timeout') {
      this.log.warn('mongod did not exit in time, killing it');
      child.kill();
      await this.exited;
    }
    this.child = null;
    this.log.info('mongod stopped');
  }
}

module.exports = { DATABASE_NAME, MongodManager, ServiceError, explainMongodExit };
