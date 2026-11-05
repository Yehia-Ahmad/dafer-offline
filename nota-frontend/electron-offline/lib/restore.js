'use strict';

// Restores a mongodump archive into the local mongod with the bundled mongorestore.exe.
// Collections in the archive replace the existing ones (--drop); the source database is
// renamed to ours when the names differ.

const { spawn } = require('node:child_process');
const { ServiceError } = require('./mongod-manager');
const { REPLICA_SET_NAME } = require('./mongod-manager');

function buildRestoreArgs({ port, archivePath, gzip, sourceDb, targetDb }) {
  const args = [
    `--uri=mongodb://127.0.0.1:${port}/?replicaSet=${REPLICA_SET_NAME}&directConnection=true`,
    `--archive=${archivePath}`,
    '--drop',
    '--stopOnError',
    `--nsInclude=${sourceDb}.*`,
  ];
  if (gzip) args.push('--gzip');
  if (sourceDb !== targetDb) args.push(`--nsFrom=${sourceDb}.*`, `--nsTo=${targetDb}.*`);
  return args;
}

// mongorestore reports progress on stderr, e.g.
//   finished restoring vpsInventory.products (120 documents, 0 failures)
//   123 document(s) restored successfully. 0 document(s) failed to restore.
function parseRestoreOutput(text) {
  const finished = [...text.matchAll(/finished restoring (\S+) \((\d+) documents?, (\d+) failures?\)/g)].map((m) => ({
    namespace: m[1],
    documents: Number(m[2]),
    failures: Number(m[3]),
  }));
  const summary = /(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore/.exec(text);
  return {
    finished,
    restored: summary ? Number(summary[1]) : null,
    failed: summary ? Number(summary[2]) : null,
  };
}

function runRestore({ mongorestorePath, port, archivePath, gzip, sourceDb, targetDb, totalCollections, log, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const args = buildRestoreArgs({ port, archivePath, gzip, sourceDb, targetDb });
    log.info(`restoring ${archivePath} (${sourceDb} -> ${targetDb})`);
    const child = spawn(mongorestorePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    const collect = (chunk) => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) output = output.slice(-1024 * 1024);
      const { finished } = parseRestoreOutput(output);
      onProgress({ done: finished.length, total: totalCollections });
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => reject(new ServiceError('RESTORE_FAILED', 'تعذر تشغيل أداة الاستعادة.', error.message)));

    child.once('exit', (code) => {
      const result = parseRestoreOutput(output);
      const tail = output.trim().split(/\r?\n/).slice(-5).join('\n');
      if (code !== 0 || result.failed > 0) {
        log.error(`mongorestore failed (exit ${code}): ${tail}`);
        reject(new ServiceError('RESTORE_FAILED', 'فشلت استعادة النسخة الاحتياطية.', tail));
        return;
      }
      log.info(`restore finished: ${result.restored} documents in ${result.finished.length} collections`);
      resolve({ restored: result.restored || 0, collections: result.finished.length });
    });
  });
}

module.exports = { buildRestoreArgs, parseRestoreOutput, runRestore };
