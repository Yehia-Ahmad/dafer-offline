'use strict';

// Runs the bundled mongod.exe on 127.0.0.1 only and shuts it down cleanly.

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { rotateIfLarge } = require('./logger');
const { isPortFree, sleep, waitFor } = require('./net-utils');

const DATABASE_NAME = 'nota';
const REPLICA_SET_NAME = 'rs0';
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

// Full path of the program a process runs, or '' when it cannot be read (no such process, or
// one this Windows account may not inspect). UTF-8 output keeps non-English folder names intact.
function processImagePath(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (process.platform !== 'win32') {
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return '';
    }
  }
  const script =
    "$ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `$p = Get-Process -Id ${pid}; if ($p) { $p.Path }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  return (result.stdout || '').trim();
}

// True when two paths name the same file or folder. Both are resolved and lose any trailing
// separator; Windows paths compare case-insensitively and with either slash style
// (C:\ProgramData\Nota\db equals c:/programdata/nota/db/). Other platforms compare exactly.
function samePath(a, b, platform = process.platform) {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (file) => {
    let resolved = flavor.resolve(String(file));
    const root = flavor.parse(resolved).root;
    while (resolved.length > root.length && /[\\/]$/.test(resolved)) resolved = resolved.slice(0, -1);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function portInUseError(port) {
  return new ServiceError('MONGOD_PORT_IN_USE', `المنفذ ${port} الخاص بقاعدة البيانات مستخدم من برنامج آخر.`);
}

class MongodManager extends EventEmitter {
  constructor({
    mongodPath,
    dbPath,
    logFile,
    pidFile,
    port,
    mongodb,
    log,
    cacheSizeGB = 1,
    isPortFree: portCheck = isPortFree, // replaceable in tests only
    processImagePath: imagePathOf = processImagePath, // replaceable in tests only
    platform = process.platform, // replaceable in tests only (path comparison rules)
  }) {
    super();
    this.platform = platform;
    this.isPortFree = portCheck;
    this.processImagePath = imagePathOf;
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
    return `mongodb://127.0.0.1:${this.port}/${DATABASE_NAME}?replicaSet=${REPLICA_SET_NAME}&directConnection=true`;
  }

  get bootstrapUri() {
    return `mongodb://127.0.0.1:${this.port}/${DATABASE_NAME}`;
  }

  get running() {
    return Boolean(this.child);
  }

  // One connection only (maxPoolSize 1), so an identity check and the command after it go over
  // the same socket, to the same server.
  newClient(timeoutMs) {
    return new this.mongodb.MongoClient(this.bootstrapUri, {
      serverSelectionTimeoutMS: timeoutMs,
      directConnection: true,
      maxPoolSize: 1,
    });
  }

  async ensureReplicaSet() {
    const client = this.newClient(5000);
    try {
      const admin = client.db('admin');
      let hello = await admin.command({ hello: 1 });
      if (hello.setName && hello.setName !== REPLICA_SET_NAME) {
        throw new ServiceError('REPLICA_SET_WRONG', 'إعداد قاعدة البيانات غير صالح.', `expected ${REPLICA_SET_NAME}, found ${hello.setName}`);
      }
      if (!hello.setName) {
        try {
          await admin.command({
            replSetInitiate: {
              _id: REPLICA_SET_NAME,
              members: [{ _id: 0, host: `127.0.0.1:${this.port}` }],
            },
          });
          this.log.info(`initialized replica set ${REPLICA_SET_NAME}`);
        } catch (error) {
          if (!/already initialized|already initiated/i.test(error.message || '')) throw error;
        }
      }
      const primary = await waitFor(async () => {
        try {
          hello = await admin.command({ hello: 1 });
          return hello.setName === REPLICA_SET_NAME && hello.isWritablePrimary === true;
        } catch {
          return false;
        }
      }, { timeoutMs: START_TIMEOUT_MS });
      if (!primary) throw new ServiceError('REPLICA_SET_TIMEOUT', 'تعذر تجهيز قاعدة البيانات للمعاملات.');
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Which process answers on our port: { answered: false } when nothing does, otherwise
  // { answered: true, pid } with pid null when the server will not say (then it is not ours:
  // our mongod has no password and always reports its pid).
  async queryPid(client) {
    try {
      const status = await client.db('admin').command({ serverStatus: 1 });
      const pid = Number(status && status.pid);
      return { answered: true, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
    } catch (error) {
      const ServerError = this.mongodb.MongoServerError;
      return { answered: Boolean(ServerError) && error instanceof ServerError, pid: null };
    }
  }

  async whoAnswers(timeoutMs = 1000) {
    const client = this.newClient(timeoutMs);
    try {
      return await this.queryPid(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Shuts down the mongod whose process id is expectedPid; any other server answering on our
  // port is never sent the command. Normal shutdown, retried while index builds finish, then
  // forced. On a single server, force only aborts index builds (they resume on the next start);
  // the journal keeps data safe. Resolves to 'sent', 'unreachable' or 'foreign'.
  async sendShutdown(expectedPid) {
    const client = this.newClient(2000);
    const startedAt = Date.now();
    try {
      for (;;) {
        const answer = await this.queryPid(client);
        if (!answer.answered) return 'unreachable';
        if (answer.pid !== expectedPid) {
          this.log.warn(
            `not sending shutdown: the server on port ${this.port} is pid ${answer.pid === null ? 'unknown' : answer.pid}, not ${expectedPid}`
          );
          return 'foreign';
        }
        const force = Date.now() - startedAt >= SHUTDOWN_RETRY_MS;
        try {
          await client.db('admin').command(force ? { shutdown: 1, force: true } : { shutdown: 1 });
          return 'sent';
        } catch (error) {
          if (!force && /index builds in progress/i.test(error.message)) {
            this.log.info('index builds in progress, retrying shutdown');
            await sleep(1000);
            continue;
          }
          // The connection drops while mongod exits; that is the expected outcome.
          if (error.name === 'MongoNetworkError' || /ECONNRESET|closed|ECONNREFUSED/i.test(error.message)) return 'sent';
          this.log.warn(`shutdown command: ${error.message}`);
          return 'sent';
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  // A mongod left over from a crash of the app still holds the data folder. The pid file is
  // trusted only when that pid runs this app's own mongod.exe (full path): after a reboot the
  // pid may belong to any other process, including another MongoDB.
  async stopOrphan() {
    let pid = null;
    try {
      pid = Number(fs.readFileSync(this.pidFile, 'utf8').trim());
    } catch {
      // No pid file.
    }
    if (pid && isProcessAlive(pid)) {
      const image = this.processImagePath(pid);
      if (image && samePath(image, this.mongodPath, this.platform)) {
        this.log.warn(`found mongod from a previous run (pid ${pid}), shutting it down`);
        await this.sendShutdown(pid);
        const exited = await waitFor(async () => !isProcessAlive(pid), { timeoutMs: EXIT_TIMEOUT_MS });
        if (!exited) {
          this.log.warn(`mongod pid ${pid} did not exit, killing it`);
          spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
        }
      } else {
        this.log.warn(
          `stale pid file: pid ${pid} runs ${image ? `"${image}"` : 'a program this account cannot inspect'}, not this app's mongod; leaving it alone`
        );
      }
    }
    fs.rmSync(this.pidFile, { force: true });
    await this.stopServerOnOurDataFolder();
  }

  // A server on our port that runs on exactly our data folder is this app's own mongod, left
  // over from a crash under another Windows account (whose process path this account cannot
  // read): shut it down cleanly and wait for the port to free. Any other server stays foreign
  // and is left alone; start() then refuses the port.
  async stopServerOnOurDataFolder() {
    if (await this.isPortFree(this.port)) return;
    const client = this.newClient(1000);
    let answer = { answered: false, pid: null };
    let dbPath = null;
    try {
      answer = await this.queryPid(client);
      if (answer.pid !== null) {
        const options = await client.db('admin').command({ getCmdLineOpts: 1 });
        dbPath = options && options.parsed && options.parsed.storage ? options.parsed.storage.dbPath : null;
      }
    } catch {
      dbPath = null;
    } finally {
      await client.close().catch(() => {});
    }
    if (typeof dbPath !== 'string' || !dbPath || !samePath(dbPath, this.dbPath, this.platform)) return;

    this.log.warn(`mongod pid ${answer.pid} on port ${this.port} runs on our data folder; shutting it down`);
    if ((await this.sendShutdown(answer.pid)) !== 'sent') return;
    const freed = await waitFor(() => this.isPortFree(this.port), { timeoutMs: EXIT_TIMEOUT_MS });
    if (!freed) this.log.warn(`port ${this.port} is still in use after shutting down mongod pid ${answer.pid}`);
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    await this.stopOrphan();

    if (!fs.existsSync(this.mongodPath)) {
      throw new ServiceError('MONGOD_MISSING', 'ملف قاعدة البيانات غير موجود. أعد تثبيت البرنامج.', this.mongodPath);
    }
    if (!(await this.isPortFree(this.port))) throw portInUseError(this.port);

    rotateIfLarge(this.logFile, { maxBytes: 20 * 1024 * 1024, keep: 2 });
    fs.mkdirSync(this.dbPath, { recursive: true });

    const args = [
      '--dbpath', this.dbPath,
      '--port', String(this.port),
      '--bind_ip', '127.0.0.1',
      '--logpath', this.logFile,
      '--logappend',
      '--replSet', REPLICA_SET_NAME,
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

    // Ready only when the server answering on our port is our own child. Anything else (for
    // example another MongoDB listening on 0.0.0.0 of the same port) means the port is taken.
    let foreign = null;
    const ready = await waitFor(
      async () => {
        const answer = await this.whoAnswers();
        if (!answer.answered) return false;
        if (answer.pid === child.pid) return true;
        foreign = answer;
        return false;
      },
      { timeoutMs: START_TIMEOUT_MS, isCancelled: () => exitCode !== null || foreign !== null }
    );

    if (!ready) {
      if (exitCode === null) {
        child.kill();
        await exited;
      }
      this.child = null;
      removePidFileIfOwn(this.pidFile, child.pid);
      let error;
      if (foreign) {
        error = portInUseError(this.port);
        error.detail = `another server answers on 127.0.0.1:${this.port} (pid ${foreign.pid === null ? 'unknown' : foreign.pid})`;
      } else if (exitCode === null) {
        error = new ServiceError('MONGOD_TIMEOUT', 'استغرق تشغيل قاعدة البيانات وقتاً أطول من المتوقع.');
      } else {
        error = explainMongodExit(exitCode, `${stderr}\n${readTail(this.logFile)}`);
      }
      this.log.error(`mongod failed to start: ${error.code} ${error.detail}`);
      throw error;
    }

    try {
      await this.ensureReplicaSet();
    } catch (error) {
      child.kill();
      await exited;
      this.child = null;
      removePidFileIfOwn(this.pidFile, child.pid);
      throw error;
    }

    this.log.info(`mongod is PRIMARY in ${REPLICA_SET_NAME} (pid ${child.pid})`);
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
    const sent = await this.sendShutdown(child.pid);

    if (sent === 'foreign') {
      this.log.warn('another server answers on our port; stopping our mongod without the shutdown command');
      child.kill();
      await this.exited;
    } else if ((await Promise.race([this.exited, sleep(EXIT_TIMEOUT_MS).then(() => 'timeout')])) === 'timeout') {
      this.log.warn('mongod did not exit in time, killing it');
      child.kill();
      await this.exited;
    }
    this.child = null;
    this.log.info('mongod stopped');
  }
}

module.exports = { DATABASE_NAME, REPLICA_SET_NAME, MongodManager, ServiceError, explainMongodExit, processImagePath, samePath };
