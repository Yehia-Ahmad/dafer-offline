'use strict';

// Stage 24: mongod runs with --auth and a keyFile. This module creates and upgrades the credentials.
//
// Files (<home>/security/):
//   mongo-credentials.dpapi admin + app user and their random 32-byte passwords, protected with Windows DPAPI in MACHINE scope (the same
//                           scope as the LAN and session-token secrets in lib/secret-store.js), so every Windows account on this PC can run Nota
//   mongo-credentials.bin   LEGACY: the first Stage 24 build encrypted them per Windows account (Electron safeStorage). If this account can
//                           still decrypt that file it is re-saved machine-scope and removed; if not, nothing is touched (DB_CREDENTIALS_UNREADABLE)
//   mongo-keyfile           the replica-set keyFile (random, restricted file permissions)
//   db-auth.json            the upgrade state (phase + the pids of mongod processes this module started). No secrets.
//
// ensure() is the whole job and is SAFE TO RE-RUN after a crash at any point (nothing is ever wiped, nothing locks the database):
//   1. stop a leftover mongod from the pre-auth version (the caller's stopOrphan), and any temporary mongod of a crashed attempt
//   2. make the material (credentials, keyFile) and SAVE IT before the database is touched; an existing material is reused, never replaced
//   3. start a temporary mongod WITHOUT auth, standalone, on a random port of 127.0.0.1 (nothing else can reach it: loopback only)
//   4. create-or-update the admin user (root) and the app user (readWrite on the Nota database only)
//   5. stop the temporary mongod cleanly
//   6. start a mongod exactly as in production (--auth --keyFile --replSet) and VERIFY: admin and app can sign in, a connection with
//      no credentials is refused; stop it; only then mark the state "complete"
// An existing database is never changed apart from the two users in the admin database.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitFor, sleep } = require('./net-utils');
const { REPLICA_SET, mongoUri } = require('./mongo-uri');
const { processImagePath, samePath } = require('./mongod-manager');

const DATABASE_NAME = 'nota';
const ADMIN_USER = 'nota_admin';
const APP_USER = 'nota_app';
const STATE_VERSION = 1;
const START_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 30000;

class DbAuthError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'DbAuthError';
    this.code = code;
    this.detail = detail || '';
  }
}

/** The vault the credentials are protected with: Windows DPAPI, machine scope. protect(text) -> base64 text, unprotect(base64 text) -> text (lib/secret-store.js). */
function createMachineScopeVault({ protect, unprotect }) {
  return {
    encrypt(text) { return Buffer.from(protect(text), 'utf8'); },
    decrypt(buffer) { return unprotect(buffer.toString('utf8')); },
  };
}

/** The LEGACY per-account vault (only used to migrate an old mongo-credentials.bin). `safeStorage` is Electron's (main process, after app ready). */
function createSafeStorageVault(safeStorage) {
  const available = () => {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new DbAuthError('SAFE_STORAGE_UNAVAILABLE', 'تعذر تشفير كلمة سر قاعدة البيانات على هذا الجهاز (Windows لا يوفر التشفير الآن).');
    }
  };
  return {
    encrypt(text) { available(); return safeStorage.encryptString(text); },
    decrypt(buffer) { available(); return safeStorage.decryptString(buffer); },
  };
}

const randomPassword = () => crypto.randomBytes(32).toString('base64url'); // 43 characters, 256 bits

function writeFileAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function hardKill(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/**
 * Only this PC's Windows accounts (BUILTIN\Users, read) and SYSTEM may read the keyFile; inheritance is removed, so no network or
 * foreign account gets it. Every account must be able to read it: any of them may be the one that starts the server (the credentials
 * are machine-scope for the same reason). Failing to restrict it is logged, not fatal (the file alone opens nothing).
 */
function restrictFile(file, log) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', '*S-1-5-32-545:(R)', '/grant:r', '*S-1-5-18:(F)'], { windowsHide: true, encoding: 'utf8' });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || '').trim());
    } else {
      fs.chmodSync(file, 0o600);
    }
  } catch (error) {
    if (log) log.warn(`could not restrict permissions on ${path.basename(file)}: ${error.message}`);
  }
}

class DbAuth {
  /**
   * @param {object} o
   * @param {string} o.securityDir   <home>/security
   * @param {string} o.mongodPath    bundled mongod.exe
   * @param {string} o.dbPath        the data folder
   * @param {string} o.logDir        where mongod-upgrade.log goes
   * @param {number} o.port          the real (final) mongod port, used only for the verification start
   * @param {object} o.mongodb       the MongoDB driver module bundled with the backend
   * @param {object} o.vault         { encrypt(text) -> Buffer, decrypt(Buffer) -> text }: machine-scope DPAPI
   * @param {object} [o.legacyVault] same shape: the per-account safeStorage vault, only to migrate an old mongo-credentials.bin
   * @param {object} o.log
   */
  constructor({ securityDir, mongodPath, dbPath, logDir, port, mongodb, vault, legacyVault = null, log, processImagePath: imagePathOf = processImagePath }) {
    this.processImagePath = imagePathOf; // replaceable in tests only
    this.securityDir = securityDir;
    this.mongodPath = mongodPath;
    this.dbPath = dbPath;
    this.logDir = logDir;
    this.port = port;
    this.mongodb = mongodb;
    this.vault = vault;
    this.legacyVault = legacyVault;
    this.log = log;
    this.credentialsFile = path.join(securityDir, 'mongo-credentials.dpapi');
    this.legacyCredentialsFile = path.join(securityDir, 'mongo-credentials.bin');
    this.keyFile = path.join(securityDir, 'mongo-keyfile');
    this.stateFile = path.join(securityDir, 'db-auth.json');
  }

  // ---- state ----------------------------------------------------------------------------------------------------------

  readState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (state && state.v === STATE_VERSION && (state.phase === 'prepared' || state.phase === 'complete')) return { running: [], ...state };
    } catch { /* none or unreadable: the upgrade starts over, which is always safe */ }
    return { v: STATE_VERSION, phase: 'none', running: [] };
  }

  writeState(state) {
    fs.mkdirSync(this.securityDir, { recursive: true });
    writeFileAtomic(this.stateFile, `${JSON.stringify({ ...state, v: STATE_VERSION })}\n`);
  }

  // ---- material -------------------------------------------------------------------------------------------------------

  parseCredentials(text) {
    const credentials = JSON.parse(text);
    const valid = ['admin', 'app'].every((key) => credentials[key] && typeof credentials[key].user === 'string' && typeof credentials[key].password === 'string' && credentials[key].password.length >= 32);
    if (!valid) throw new Error('the saved credentials are incomplete');
    return credentials;
  }

  /** { status: 'ok', credentials } | { status: 'missing' } | { status: 'unreadable', error } */
  loadCredentials() {
    let blob;
    try { blob = fs.readFileSync(this.credentialsFile); } catch { return this.migrateLegacyCredentials(); }
    try {
      const credentials = this.parseCredentials(this.vault.decrypt(blob));
      fs.rmSync(this.legacyCredentialsFile, { force: true }); // a stale per-account copy of the same credentials
      return { status: 'ok', credentials };
    } catch (error) {
      return { status: 'unreadable', error };
    }
  }

  /**
   * The first Stage 24 build kept the credentials per Windows account (safeStorage). If this account can still decrypt that file, the
   * SAME credentials are re-saved machine-scope, read back, and only then is the old file removed. Passwords are never regenerated for a
   * database that already has users; a file this account cannot decrypt is reported as unreadable and nothing is touched.
   */
  migrateLegacyCredentials() {
    let legacy;
    try { legacy = fs.readFileSync(this.legacyCredentialsFile); } catch { return { status: 'missing' }; }
    let credentials;
    try {
      if (!this.legacyVault) throw new Error('no per-account vault to read the old credentials file with');
      credentials = this.parseCredentials(this.legacyVault.decrypt(legacy));
    } catch (error) {
      return { status: 'unreadable', error };
    }
    try {
      this.saveCredentials(credentials);
      const back = this.parseCredentials(this.vault.decrypt(fs.readFileSync(this.credentialsFile)));
      if (back.admin.password !== credentials.admin.password || back.app.password !== credentials.app.password) throw new Error('the machine-scope copy does not match');
    } catch (error) {
      fs.rmSync(this.credentialsFile, { force: true }); // the old file stays: nothing is lost
      return { status: 'unreadable', error };
    }
    fs.rmSync(this.legacyCredentialsFile, { force: true });
    this.log.info('database credentials migrated from per-account to machine-scope protection');
    return { status: 'ok', credentials };
  }

  saveCredentials(credentials) {
    fs.mkdirSync(this.securityDir, { recursive: true });
    writeFileAtomic(this.credentialsFile, this.vault.encrypt(JSON.stringify(credentials)));
  }

  ensureKeyFile() {
    if (fs.existsSync(this.keyFile)) return;
    fs.mkdirSync(this.securityDir, { recursive: true });
    // MongoDB: 6 to 1024 characters of base64. 756 random bytes = 1008 characters.
    writeFileAtomic(this.keyFile, `${crypto.randomBytes(756).toString('base64')}\n`);
    restrictFile(this.keyFile, this.log);
  }

  result(credentials) {
    return { keyFile: this.keyFile, admin: credentials.admin, app: credentials.app };
  }

  // ---- the whole job --------------------------------------------------------------------------------------------------

  /**
   * Returns { keyFile, admin: { user, password }, app: { user, password } }, upgrading first when needed.
   * `stopOrphan` stops a leftover mongod of the pre-auth version; `hook(step)` is called after each step (tests kill the process there).
   */
  async ensure({ stopOrphan = async () => {}, hook = async () => {} } = {}) {
    const state = this.readState();
    if (state.phase === 'complete') {
      const loaded = this.loadCredentials();
      if (loaded.status === 'ok') {
        this.ensureKeyFile();
        return this.result(loaded.credentials);
      }
      if (loaded.status === 'unreadable') {
        // The file exists but this account cannot decrypt it (another Windows account, or the data folder was copied to another PC).
        // Never make new passwords here: that would lock the other account out.
        this.log.error(`database credentials cannot be read: ${loaded.error.message}`);
        throw new DbAuthError('DB_CREDENTIALS_UNREADABLE',
          'تعذر قراءة كلمة سر قاعدة البيانات على هذا الجهاز (ملفات الحماية اتنسخت من جهاز تاني أو اتغيّرت). اتصل بالدعم الفني. (بياناتك لم تتأثر)',
          loaded.error.message);
      }
      this.log.warn('database credentials file is missing: rebuilding the credentials (the data is not touched)');
    }
    return this.upgrade({ stopOrphan, hook });
  }

  async upgrade({ stopOrphan, hook }) {
    const step = async (name, extra = {}) => { await hook(name, { ...extra, auth: this }); };
    await stopOrphan();
    await this.cleanupLeftovers();

    // 2. the material is saved BEFORE the database is touched; an existing one is reused so a re-run keeps the same passwords
    const loaded = this.loadCredentials();
    if (loaded.status === 'unreadable') {
      throw new DbAuthError('DB_CREDENTIALS_UNREADABLE', 'تعذر قراءة كلمة سر قاعدة البيانات على هذا الجهاز.', loaded.error.message);
    }
    const credentials = loaded.status === 'ok'
      ? loaded.credentials
      : { admin: { user: ADMIN_USER, password: randomPassword() }, app: { user: APP_USER, password: randomPassword() } };
    if (loaded.status !== 'ok') this.saveCredentials(credentials);
    this.ensureKeyFile();
    this.writeState({ ...this.readState(), phase: 'prepared' });
    await step('material');

    // 3 to 5. the temporary mongod: no auth, standalone, random loopback port
    const tempPort = await freePort();
    const temp = await this.startMongod({ kind: 'temp', port: tempPort, args: ['--port', String(tempPort)] });
    try {
      await step('temp-started', { pid: temp.child.pid });
      const client = new this.mongodb.MongoClient(mongoUri({ port: tempPort, replicaSet: null }), { directConnection: true, serverSelectionTimeoutMS: 20000, maxPoolSize: 1 });
      try {
        await this.upsertUser(client, credentials.admin, [{ role: 'root', db: 'admin' }]);
        await step('admin-user');
        await this.upsertUser(client, credentials.app, [{ role: 'readWrite', db: DATABASE_NAME }]);
        await step('app-user');
      } finally {
        await client.close().catch(() => {});
      }
      await this.stopMongod(temp, { auth: null });
      await step('temp-stopped');
    } catch (error) {
      // A simulated crash (tests) leaves everything as it is, like a real one. Any other failure cleans up its own process.
      if (!error || !error.simulatedCrash) await this.stopMongod(temp, { auth: null, force: true }).catch(() => {});
      throw error;
    }

    // 6. the verification start: the production configuration
    await this.verifyFinal(credentials, step);
    this.writeState({ ...this.readState(), phase: 'complete', running: [] });
    this.log.info('database authentication is on (users created, keyFile ready, connection verified)');
    return this.result(credentials);
  }

  // ---- mongod processes -----------------------------------------------------------------------------------------------

  async startMongod({ kind, port, args }) {
    fs.mkdirSync(this.logDir, { recursive: true });
    const common = ['--dbpath', this.dbPath, '--bind_ip', '127.0.0.1', '--logpath', path.join(this.logDir, 'mongod-upgrade.log'), '--logappend', '--wiredTigerCacheSizeGB', '0.5'];
    const child = spawn(this.mongodPath, [...common, ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code === null ? signal : code)));
    const handle = { kind, port, child, exited };
    const state = this.readState();
    this.writeState({ ...state, running: [...state.running.filter((entry) => entry.pid !== child.pid), { kind, pid: child.pid, port }] });
    // Ready = the driver can talk to it (any answer, including "unauthorized").
    const ready = await waitFor(async () => {
      if (child.exitCode !== null) return false;
      const client = new this.mongodb.MongoClient(mongoUri({ port, replicaSet: null }), { directConnection: true, serverSelectionTimeoutMS: 1000, maxPoolSize: 1 });
      try { await client.db('admin').command({ hello: 1 }); return true; } catch { return false; } finally { await client.close().catch(() => {}); }
    }, { timeoutMs: START_TIMEOUT_MS, intervalMs: 300, isCancelled: () => child.exitCode !== null });
    if (!ready) {
      if (child.exitCode === null) hardKill(child.pid);
      await exited;
      this.forget(child.pid);
      throw new DbAuthError('MONGOD_UPGRADE_FAILED', 'تعذر تشغيل قاعدة البيانات لتجهيز الحماية.', stderr.split(/\r?\n/).filter(Boolean).slice(-4).join('\n'));
    }
    return handle;
  }

  forget(pid) {
    const state = this.readState();
    this.writeState({ ...state, running: state.running.filter((entry) => entry.pid !== pid) });
  }

  /** Clean shutdown (admin command), then a hard kill if it does not exit. `auth` = admin credentials for an authenticated mongod. */
  async stopMongod(handle, { auth, force = false }) {
    const { child, port, exited } = handle;
    if (child.exitCode === null) {
      const client = new this.mongodb.MongoClient(mongoUri({ port, replicaSet: null, auth }), { directConnection: true, serverSelectionTimeoutMS: 5000, maxPoolSize: 1 });
      try {
        await client.db('admin').command({ shutdown: 1, force: true });
      } catch { /* the connection drops while mongod exits: expected */ } finally {
        await client.close().catch(() => {});
      }
      const stopped = await Promise.race([exited.then(() => true), sleep(force ? 5000 : STOP_TIMEOUT_MS).then(() => false)]);
      if (!stopped && child.exitCode === null) { hardKill(child.pid); await exited; }
    }
    this.forget(child.pid);
  }

  /** Mongod processes this module started in an attempt that died: stop them (clean first, then hard). */
  async cleanupLeftovers() {
    const state = this.readState();
    for (const entry of state.running) {
      if (!isAlive(entry.pid)) continue;
      // The recorded pid may belong to an unrelated process by now (pids are reused after a reboot): only a process that runs THIS app's
      // mongod.exe is touched, exactly the rule MongodManager.stopOrphan uses. Anything else is left alone.
      const image = this.processImagePath(entry.pid);
      if (!image || !samePath(image, this.mongodPath)) {
        this.log.warn(`not touching pid ${entry.pid}: it runs ${image ? `"${image}"` : 'a program this account cannot inspect'}, not this app's mongod`);
        continue;
      }
      this.log.warn(`stopping a leftover mongod from an interrupted upgrade (pid ${entry.pid})`);
      const client = new this.mongodb.MongoClient(mongoUri({ port: entry.port, replicaSet: null }), { directConnection: true, serverSelectionTimeoutMS: 1500, maxPoolSize: 1 });
      try { await client.db('admin').command({ shutdown: 1, force: true }); } catch { /* unauthorized or gone */ } finally { await client.close().catch(() => {}); }
      const gone = await waitFor(async () => !isAlive(entry.pid), { timeoutMs: 10000, intervalMs: 300 });
      if (!gone) hardKill(entry.pid);
      await waitFor(async () => !isAlive(entry.pid), { timeoutMs: 10000, intervalMs: 300 });
    }
    this.writeState({ ...state, running: [] });
  }

  // ---- users, verification --------------------------------------------------------------------------------------------

  async upsertUser(client, { user, password }, roles) {
    const admin = client.db('admin');
    const info = await admin.command({ usersInfo: { user, db: 'admin' } });
    if (info.users && info.users.length) await admin.command({ updateUser: user, pwd: password, roles });
    else await admin.command({ createUser: user, pwd: password, roles });
  }

  async verifyFinal(credentials, step) {
    const port = this.port;
    const handle = await this.startMongod({
      kind: 'verify', port,
      args: ['--port', String(port), '--auth', '--keyFile', this.keyFile, '--replSet', REPLICA_SET],
    });
    try {
      const open = (auth) => new this.mongodb.MongoClient(mongoUri({ port, replicaSet: null, auth }), { directConnection: true, serverSelectionTimeoutMS: 15000, maxPoolSize: 1 });
      // admin signs in
      const asAdmin = open(credentials.admin);
      try {
        const status = await asAdmin.db('admin').command({ connectionStatus: 1 });
        const names = (status.authInfo.authenticatedUsers || []).map((u) => u.user);
        if (!names.includes(credentials.admin.user)) throw new Error('the admin user could not sign in');
      } finally { await asAdmin.close().catch(() => {}); }
      // the app user signs in, with its one role
      const asApp = open(credentials.app);
      try {
        const status = await asApp.db('admin').command({ connectionStatus: 1, showPrivileges: false });
        const names = (status.authInfo.authenticatedUsers || []).map((u) => u.user);
        const roles = (status.authInfo.authenticatedUserRoles || []).map((r) => `${r.role}@${r.db}`);
        if (!names.includes(credentials.app.user)) throw new Error('the app user could not sign in');
        if (roles.length !== 1 || roles[0] !== `readWrite@${DATABASE_NAME}`) throw new Error(`the app user has unexpected roles: ${roles.join(', ')}`);
      } finally { await asApp.close().catch(() => {}); }
      // a connection with no credentials is refused
      const anonymous = open(null);
      try {
        let refused = false;
        try { await anonymous.db(DATABASE_NAME).listCollections().toArray(); } catch (error) { refused = error.code === 13 || /requires authentication|not authorized|Unauthorized/i.test(error.message || ''); }
        if (!refused) throw new Error('a connection without credentials was NOT refused');
      } finally { await anonymous.close().catch(() => {}); }
    } catch (error) {
      if (!error.simulatedCrash) await this.stopMongod(handle, { auth: credentials.admin, force: true }).catch(() => {});
      throw new DbAuthError('DB_AUTH_VERIFY_FAILED', 'تعذر التحقق من حماية قاعدة البيانات. لم يتم تغيير بياناتك، وسيُعاد المحاولة عند التشغيل التالي.', error.message);
    }
    await step('verified-running', { pid: handle.child.pid });
    await this.stopMongod(handle, { auth: credentials.admin });
    await step('verified');
  }
}

module.exports = { DbAuth, DbAuthError, createSafeStorageVault, createMachineScopeVault, ADMIN_USER, APP_USER, DATABASE_NAME };
