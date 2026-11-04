'use strict';

// Backup and restore of the main PC's database with the bundled mongodump/mongorestore.
//
// Backup: one gzip'd mongodump archive file. It is written as .partial, checked by reading
// its header back, and only then renamed, so a half-written file never looks like a backup.
// Restore: replaces the whole database with the archive. A safety backup of the current data
// is taken first; if the restore fails, that safety backup is put back automatically.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { chooseSourceDatabase, readArchiveSummary } = require('./backup-archive');
const { DATABASE_NAME, ServiceError } = require('./mongod-manager');
const { runRestore } = require('./restore');

const SAFETY_PREFIX = 'before-restore-';
const BACKUP_SUFFIX = '.archive.gz';
const KEEP_SAFETY_BACKUPS = 5;

const pad = (value) => String(value).padStart(2, '0');

// 2026-11-02 (local date)
const localDateStamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// kapomatic-backup-2026-11-02_213005.archive.gz (local time, sorts by date)
function backupFileName(prefix = 'kapomatic-backup-', date = new Date()) {
  const stamp = `${localDateStamp(date)}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${prefix}${stamp}${BACKUP_SUFFIX}`;
}

// mongodump prints e.g. "done dumping kapomatic_warehouse.products (12 documents)".
function parseDumpOutput(text) {
  return [...text.matchAll(/done dumping (\S+) \((\d+) documents?\)/g)].map((match) => ({
    namespace: match[1],
    documents: Number(match[2]),
  }));
}

function describeArchive(summary) {
  const sourceDb = chooseSourceDatabase(summary);
  return {
    path: summary.file,
    name: path.basename(summary.file),
    sizeMb: Math.round((summary.sizeBytes / 1048576) * 10) / 10,
    gzip: summary.gzip,
    sourceDb,
    collections: summary.databases[sourceDb].length,
    serverVersion: summary.serverVersion,
  };
}

class BackupService {
  constructor({ mongodbBin, port, backupsDir, mongodb, bson, log, dbName = DATABASE_NAME, keepSafety = KEEP_SAFETY_BACKUPS }) {
    this.mongodbBin = mongodbBin;
    this.port = port;
    this.backupsDir = backupsDir;
    this.mongodb = mongodb;
    this.bson = bson;
    this.log = log;
    this.dbName = dbName;
    this.keepSafety = keepSafety;
  }

  async withClient(callback) {
    const client = new this.mongodb.MongoClient(`mongodb://127.0.0.1:${this.port}`, {
      directConnection: true,
      serverSelectionTimeoutMS: 5000,
    });
    try {
      return await callback(client.db(this.dbName));
    } finally {
      await client.close().catch(() => {});
    }
  }

  async countCollections() {
    return this.withClient(async (db) => {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      return collections.filter((c) => !c.name.startsWith('system.') && c.type !== 'view').length;
    });
  }

  async inspect(file) {
    return describeArchive(await readArchiveSummary(file, this.bson));
  }

  async createBackup(outputPath, onProgress = () => {}) {
    const total = await this.countCollections();
    const partial = `${outputPath}.partial`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.rmSync(partial, { force: true });
    onProgress({ phase: 'backup', done: 0, total });
    this.log.info(`backup to ${outputPath}`);

    const dumped = await new Promise((resolve, reject) => {
      const child = spawn(
        path.join(this.mongodbBin, 'mongodump.exe'),
        ['--host=127.0.0.1', `--port=${this.port}`, `--db=${this.dbName}`, `--archive=${partial}`, '--gzip'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let output = '';
      const collect = (chunk) => {
        output = (output + chunk).slice(-1024 * 1024);
        onProgress({ phase: 'backup', done: parseDumpOutput(output).length, total });
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => reject(new ServiceError('BACKUP_FAILED', 'تعذر تشغيل أداة النسخ الاحتياطي.', error.message)));
      child.once('exit', (code) => {
        if (code !== 0) {
          const tail = output.trim().split(/\r?\n/).slice(-5).join('\n');
          this.log.error(`mongodump failed (exit ${code}): ${tail}`);
          reject(new ServiceError('BACKUP_FAILED', 'فشل إنشاء النسخة الاحتياطية.', tail));
          return;
        }
        resolve(parseDumpOutput(output));
      });
    }).catch((error) => {
      fs.rmSync(partial, { force: true });
      throw error;
    });

    // Read the header back: the file must list at least the collections counted before the dump
    // (one created meanwhile by the running server can add to it).
    const summary = await readArchiveSummary(partial, this.bson).catch(() => null);
    const listed = summary && summary.databases[this.dbName] ? summary.databases[this.dbName].length : 0;
    if (!summary || listed < total) {
      fs.rmSync(partial, { force: true });
      throw new ServiceError('BACKUP_FAILED', 'فشل التحقق من ملف النسخة الاحتياطية.', `expected ${total} collections, found ${listed}`);
    }

    fs.rmSync(outputPath, { force: true });
    fs.renameSync(partial, outputPath);
    const result = {
      path: outputPath,
      sizeMb: Math.round((fs.statSync(outputPath).size / 1048576) * 10) / 10,
      collections: listed,
      documents: dumped.reduce((sum, entry) => sum + entry.documents, 0),
    };
    this.log.info(`backup done: ${result.collections} collections, ${result.documents} documents, ${result.sizeMb} MB`);
    return result;
  }

  async createSafetyBackup(onProgress) {
    const file = path.join(this.backupsDir, backupFileName(SAFETY_PREFIX));
    const result = await this.createBackup(file, onProgress);
    this.pruneSafetyBackups();
    return result;
  }

  listSafetyBackups() {
    let names = [];
    try {
      names = fs.readdirSync(this.backupsDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.startsWith(SAFETY_PREFIX) && name.endsWith(BACKUP_SUFFIX))
      .sort()
      .map((name) => path.join(this.backupsDir, name));
  }

  pruneSafetyBackups() {
    const files = this.listSafetyBackups();
    for (const file of files.slice(0, Math.max(0, files.length - this.keepSafety))) {
      fs.rmSync(file, { force: true });
      this.log.info(`removed old safety backup ${path.basename(file)}`);
    }
  }

  // Drops the whole database, then restores the archive into it.
  async replaceWith(archive, onProgress = () => {}) {
    await this.withClient((db) => db.dropDatabase());
    onProgress({ phase: 'restoring', done: 0, total: archive.collections });
    return runRestore({
      mongorestorePath: path.join(this.mongodbBin, 'mongorestore.exe'),
      port: this.port,
      archivePath: archive.path,
      gzip: archive.gzip,
      sourceDb: archive.sourceDb,
      targetDb: this.dbName,
      totalCollections: archive.collections,
      log: this.log,
      onProgress: ({ done, total }) => onProgress({ phase: 'restoring', done, total }),
    });
  }

  // archive: the result of inspect(). safety: back up the current data first (and roll back to it).
  async restore(archive, { safety = true, onProgress = () => {} } = {}) {
    let safetyBackup = null;
    if (safety) {
      safetyBackup = await this.createSafetyBackup((progress) => onProgress({ ...progress, phase: 'safety-backup' }));
    }

    try {
      const result = await this.replaceWith(archive, onProgress);
      return { ...result, safetyPath: safetyBackup ? safetyBackup.path : null };
    } catch (error) {
      if (!safetyBackup) throw error;
      this.log.error(`restore failed, putting the previous data back: ${error.message}`);
      onProgress({ phase: 'rolling-back' });
      try {
        await this.replaceWith(await this.inspect(safetyBackup.path));
      } catch (rollbackError) {
        this.log.error(`rollback failed: ${rollbackError.message}`);
        throw new ServiceError(
          'RESTORE_ROLLBACK_FAILED',
          `فشلت الاستعادة وتعذر إرجاع البيانات السابقة تلقائياً. نسخة البيانات السابقة محفوظة في: ${safetyBackup.path}`,
          `${error.detail || error.message}\n${rollbackError.detail || rollbackError.message}`
        );
      }
      throw new ServiceError(
        'RESTORE_FAILED_ROLLED_BACK',
        'فشلت استعادة النسخة الاحتياطية، وتمت إعادة البيانات السابقة كما كانت.',
        error.detail || error.message
      );
    }
  }
}

module.exports = { BACKUP_SUFFIX, BackupService, SAFETY_PREFIX, backupFileName, describeArchive, localDateStamp, parseDumpOutput };
