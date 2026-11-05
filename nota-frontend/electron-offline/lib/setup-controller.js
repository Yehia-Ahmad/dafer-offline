'use strict';

// First-run setup (pages/setup.html): choose main PC or client PC, then save config.json.
// All validation and every action (restoring a backup, testing a client connection) happens
// here in the main process; the page only collects input and shows results.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDITION = require('../edition.json');
const { DEFAULT_PORT, MONGOD_PORT, validPort, writeConfig } = require('./config-store');
const { protectSecret } = require('./secret-store');
const { isPortFree } = require('./net-utils');
const { discoverServers, otherMainPcs } = require('./discovery');
const { isValidHost, probeServer } = require('./client-link');
const { ArchiveError, readArchiveSummary } = require('./backup-archive');
const { MongodManager } = require('./mongod-manager');
const { BackupService, describeArchive } = require('./backup-service');

// No 0/O, 1/I/L: the code is read aloud and typed on every client PC.
const SECRET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 100;

function generateSecret() {
  const group = () => Array.from({ length: 4 }, () => SECRET_ALPHABET[crypto.randomInt(SECRET_ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

function hasExistingData(dbPath) {
  return fs.existsSync(path.join(dbPath, 'WiredTiger'));
}

class SetupError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'SetupError';
    this.field = field;
  }
}

function normalizeSecret(value) {
  const secret = typeof value === 'string' ? value.trim() : '';
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new SetupError(`كلمة سر الشبكة يجب ألا تقل عن ${MIN_SECRET_LENGTH} أحرف.`, 'secret');
  }
  if (secret.length > MAX_SECRET_LENGTH) throw new SetupError('كلمة سر الشبكة طويلة جداً.', 'secret');
  return secret;
}

function normalizePort(value) {
  const port = Number(value);
  if (!validPort(port)) {
    throw new SetupError('رقم المنفذ غير صالح. استخدم رقماً بين 1024 و65535 (المنفذ 5055 مناسب في أغلب الحالات).', 'port');
  }
  return port;
}

class SetupController {
  constructor({ paths, resources, log, appVersion, getServerLock, loadDriver, loadBson }) {
    this.paths = paths;
    this.resources = resources;
    this.log = log;
    this.appVersion = appVersion;
    this.getServerLock = getServerLock; // () => Promise<server | null>
    this.loadDriver = loadDriver;
    this.loadBson = loadBson;
  }

  info() {
    return {
      appVersion: this.appVersion,
      computerName: os.hostname(),
      defaultPort: DEFAULT_PORT,
      suggestedSecret: generateSecret(),
      hasExistingData: hasExistingData(this.paths.dbPath),
    };
  }

  generateSecret() {
    return generateSecret();
  }

  async checkPort(value) {
    const port = normalizePort(value);
    if (!(await isPortFree(port, '0.0.0.0'))) {
      throw new SetupError(`المنفذ ${port} مستخدم من برنامج آخر على هذا الجهاز. اختر منفذاً آخر.`, 'port');
    }
    return { port };
  }

  async inspectBackup(file) {
    return describeArchive(await readArchiveSummary(file, this.loadBson()));
  }

  discover() {
    return discoverServers();
  }

  // Stage 15: main PCs already answering on the LAN, before this PC becomes a main PC.
  // ownInstanceId: this PC's id when it was set up before (its own answer is not another PC).
  async findOtherMainPcs(ownInstanceId, discover = discoverServers) {
    return otherMainPcs(await discover(), { ownInstanceId });
  }

  // Main PC: optionally restore a backup, then save the config.
  async completeMain(input, onProgress) {
    const shopName = String(input.shopName || '').trim().slice(0, 60) || os.hostname();
    const secret = normalizeSecret(input.secret);
    const { port } = await this.checkPort(input.port);
    const dataChoice = input.dataChoice;
    if (!['empty', 'existing', 'restore'].includes(dataChoice)) throw new SetupError('اختر مصدر البيانات.', 'dataChoice');

    const existing = hasExistingData(this.paths.dbPath);
    if (dataChoice === 'empty' && existing) {
      throw new SetupError('يوجد بيانات سابقة على هذا الجهاز. اختر الاحتفاظ بها أو الاستعادة من نسخة احتياطية.', 'dataChoice');
    }

    if (!(await this.getServerLock())) {
      throw new SetupError('البرنامج يعمل كجهاز رئيسي من حساب Windows آخر على هذا الجهاز.');
    }

    if (dataChoice === 'restore') {
      let archive;
      try {
        archive = await this.inspectBackup(input.backupPath);
      } catch (error) {
        throw new SetupError(error instanceof ArchiveError ? error.message : 'تعذر قراءة النسخة الاحتياطية.', 'backup');
      }
      await this.restoreArchive(archive, existing, onProgress);
    }

    onProgress({ phase: 'saving' });
    const config = writeConfig(this.paths.config, {
      schemaVersion: 1,
      role: 'main',
      instanceId: crypto.randomUUID(),
      lanSecretProtected: protectSecret(secret),
      port,
      shopName,
      startWithWindows: input.startWithWindows !== false,
    });
    this.log.info(`set up as main PC on port ${port}`);
    return { config, secret };
  }

  // Replaces the whole database with the backup. Data already on this PC is backed up first
  // into the backups folder, and put back if the restore fails.
  async restoreArchive(archive, existing, onProgress) {
    const mongod = new MongodManager({
      mongodPath: path.join(this.resources.mongodbBin, 'mongod.exe'),
      dbPath: this.paths.dbPath,
      logFile: path.join(this.paths.logs, 'mongod.log'),
      pidFile: path.join(this.paths.run, 'mongod.pid'),
      port: MONGOD_PORT,
      mongodb: this.loadDriver(),
      log: this.log,
    });
    onProgress({ phase: 'starting-database' });
    await mongod.start();
    try {
      const backups = new BackupService({
        mongodbBin: this.resources.mongodbBin,
        port: MONGOD_PORT,
        backupsDir: this.paths.backups,
        mongodb: this.loadDriver(),
        bson: this.loadBson(),
        log: this.log,
      });
      await backups.restore(archive, { safety: existing, onProgress });
    } finally {
      await mongod.stop();
    }
  }

  // Client PC: check the address and secret against the main PC, then save the config.
  async completeClient(input, existingConfig) {
    const host = String(input.host || '').trim();
    if (!isValidHost(host)) throw new SetupError('عنوان الجهاز الرئيسي غير صالح. مثال: 192.168.1.10', 'host');
    const port = normalizePort(input.port);
    const secret = normalizeSecret(input.secret);

    const result = await probeServer({ host, port, secret });
    if (result.status === 'unauthorized') throw new SetupError('كلمة سر الشبكة غير صحيحة.', 'secret');
    if (result.status === 'unreachable') {
      throw new SetupError('تعذر الوصول إلى الجهاز الرئيسي. تأكد أنه يعمل ومتصل بنفس الشبكة، وأن العنوان صحيح.', 'host');
    }
    if (result.status !== 'ok') throw new SetupError(`هذا العنوان لا يخص جهاز ${EDITION.nameAr} رئيسي.`, 'host');

    const config = writeConfig(this.paths.config, {
      schemaVersion: 1,
      role: 'client',
      instanceId: existingConfig && existingConfig.role === 'client' ? existingConfig.instanceId : crypto.randomUUID(),
      lanSecretProtected: protectSecret(secret),
      port,
      shopName: typeof input.shopName === 'string' ? input.shopName.slice(0, 60) : '',
      mainHost: host,
      mainInstanceId: result.info.instanceId || '',
      startWithWindows: false,
    });
    this.log.info(`set up as client PC of ${host}:${port}`);
    return { config, secret, info: result.info };
  }
}

module.exports = { SetupController, SetupError, generateSecret, hasExistingData };
