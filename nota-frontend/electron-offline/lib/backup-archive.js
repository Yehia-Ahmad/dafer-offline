'use strict';

// Reads the header ("prelude") of a mongodump archive file without a running database, so the
// setup screen can show what a backup contains and which database to restore from.
//
// Archive layout (mongo-tools): int32 magic 0x8199e26d, a header BSON document, one BSON
// document per collection, then int32 0xffffffff. The whole file may be gzip-compressed.

const fs = require('node:fs');
const zlib = require('node:zlib');

const MAGIC = 0x8199e26d;
const TERMINATOR = 0xffffffff;
const MAX_PRELUDE_BYTES = 32 * 1024 * 1024;
const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

function isGzipFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    return head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    fs.closeSync(fd);
  }
}

// Collects bytes until parse() succeeds or the limit is reached.
function readPrefix(file, gzip, parse) {
  return new Promise((resolve, reject) => {
    const source = fs.createReadStream(file);
    const stream = gzip ? source.pipe(zlib.createGunzip()) : source;
    let buffer = Buffer.alloc(0);
    let done = false;

    const finish = (error, value) => {
      if (done) return;
      done = true;
      source.destroy();
      if (gzip) stream.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let result;
      try {
        result = parse(buffer);
      } catch (error) {
        finish(error);
        return;
      }
      if (result) finish(null, result);
      else if (buffer.length > MAX_PRELUDE_BYTES) {
        finish(new ArchiveError('NOT_AN_ARCHIVE', 'الملف المختار ليس نسخة احتياطية صالحة.'));
      }
    });
    stream.on('error', () => finish(new ArchiveError('NOT_AN_ARCHIVE', 'الملف المختار تالف أو ليس نسخة احتياطية صالحة.')));
    stream.on('end', () => finish(new ArchiveError('NOT_AN_ARCHIVE', 'الملف المختار غير مكتمل أو ليس نسخة احتياطية صالحة.')));
  });
}

function parsePrelude(buffer, bson) {
  if (buffer.length < 4) return null;
  if (buffer.readUInt32LE(0) !== MAGIC) {
    throw new ArchiveError('NOT_AN_ARCHIVE', 'الملف المختار ليس نسخة احتياطية من نوع mongodump archive.');
  }

  let offset = 4;
  const readDocument = () => {
    if (buffer.length < offset + 4) return undefined;
    const size = buffer.readInt32LE(offset);
    if (size >>> 0 === TERMINATOR) {
      offset += 4;
      return null;
    }
    if (size < 5 || size > 16 * 1024 * 1024) {
      throw new ArchiveError('NOT_AN_ARCHIVE', 'رأس النسخة الاحتياطية تالف.');
    }
    if (buffer.length < offset + size) return undefined;
    const document = bson.deserialize(buffer.subarray(offset, offset + size));
    offset += size;
    return document;
  };

  const header = readDocument();
  if (header === undefined) return null;
  if (header === null) throw new ArchiveError('NOT_AN_ARCHIVE', 'رأس النسخة الاحتياطية تالف.');

  const collections = [];
  for (;;) {
    const entry = readDocument();
    if (entry === undefined) return null; // need more bytes
    if (entry === null) break;
    if (typeof entry.db === 'string' && typeof entry.collection === 'string') {
      collections.push({ db: entry.db, collection: entry.collection, type: entry.type || 'collection' });
    }
  }

  return {
    serverVersion: typeof header.server_version === 'string' ? header.server_version : '',
    toolVersion: typeof header.tool_version === 'string' ? header.tool_version : '',
    collections,
  };
}

async function readArchiveSummary(file, bson) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ArchiveError('NOT_FOUND', 'تعذر فتح الملف المختار.');
  }
  const gzip = isGzipFile(file);
  const prelude = await readPrefix(file, gzip, (buffer) => parsePrelude(buffer, bson));

  const databases = {};
  for (const { db, collection, type } of prelude.collections) {
    if (SYSTEM_DATABASES.has(db) || type === 'view' || collection.startsWith('system.')) continue;
    (databases[db] = databases[db] || []).push(collection);
  }
  return { file, sizeBytes: stat.size, gzip, serverVersion: prelude.serverVersion, toolVersion: prelude.toolVersion, databases };
}

// The archive must hold exactly one application database; its name may differ from ours
// (the VPS uses kapoInventory), and the restore renames it.
function chooseSourceDatabase(summary) {
  const names = Object.keys(summary.databases);
  if (names.length === 0) {
    throw new ArchiveError('EMPTY_ARCHIVE', 'النسخة الاحتياطية لا تحتوي على أي بيانات.');
  }
  if (names.length > 1) {
    throw new ArchiveError(
      'MULTIPLE_DATABASES',
      `النسخة الاحتياطية تحتوي على أكثر من قاعدة بيانات (${names.join('، ')}). أنشئ نسخة لقاعدة بيانات واحدة فقط.`
    );
  }
  return names[0];
}

module.exports = { ArchiveError, chooseSourceDatabase, isGzipFile, parsePrelude, readArchiveSummary };
