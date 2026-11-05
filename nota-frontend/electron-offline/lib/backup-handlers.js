'use strict';

// Stage 15: the backup page's IPC handlers, with the caller checked in the main process.
//
// Every handler gets the page's session token as its first argument. Before anything runs:
//   1. only the copy that runs the server (main PC) may back up or restore;
//   2. checkCaller asks the local backend who the token belongs to and checks IPC_RULES
//      (backup.manage, or any valid session for backup:status);
//   3. restore also re-checks the user's password (POST /api/auth/verify-password), before the
//      file dialog, before the server is paused and before any data is touched.
// Results are { ok: true, value } or { ok: false, error: { message, code, detail } }; value is null
// when the user cancelled a dialog. Electron-free, so it is unit-tested with fakes
// (test/backup-handlers.test.js); main.js passes the real dialogs, services and backend client.

const fs = require('node:fs');
const path = require('node:path');

const { GuardError, IPC_RULES, checkCaller } = require('./ipc-guard');
const { BACKUP_SUFFIX } = require('./backup-service');

const NOT_SERVER_COPY = 'النسخ الاحتياطي متاح فقط على حساب Windows الذي يشغّل الخادم.';

const asError = (error) => ({
  message: error.code ? error.message : `حدث خطأ غير متوقع: ${error.message}`,
  code: error.code,
  detail: error.detail,
});

const serverNotReady = () =>
  Object.assign(new Error('الخادم غير جاهز الآن. حاول مرة أخرى بعد قليل.'), { code: 'SERVER_BUSY' });

/**
 * deps:
 *   isServerCopy(), serverRunning(), isBusy(), busyError()
 *   backend: { me(token), verifyPassword(token, password) }   (ipc-guard createBackendClient)
 *   chooseSavePath(defaultPath), chooseOpenPath(), chooseFolder(), confirmRestore(archive)
 *   defaultBackupPath(), createBackup(file, { caller, onProgress }), recordManual(result)
 *   inspect(file), restoreArchive(archive, { caller, onProgress })
 *   copyFolderInvalid(folder), setCopyFolder(folder), copyNow(), summary()
 *   showItemInFolder(file), openBackupsFolder()
 *   onProgress(value), onRestored(result), log
 */
function createBackupHandlers(deps) {
  const guarded = (channel, handler) => async (token, ...args) => {
    if (!deps.isServerCopy()) return { ok: false, error: { message: NOT_SERVER_COPY, code: 'NOT_SERVER_COPY' } };
    try {
      const caller = await checkCaller({ channel, token, backend: deps.backend() });
      return { ok: true, value: await handler({ caller, token }, ...args) };
    } catch (error) {
      if (!(error instanceof GuardError) && !error.code) deps.log.error(`${channel}: ${error.stack || error.message}`);
      else if (error instanceof GuardError) deps.log.warn(`${channel} refused: ${error.code}`);
      return { ok: false, error: asError(error) };
    }
  };

  const handlers = {
    'backup:create': guarded('backup:create', async ({ caller }) => {
      if (deps.isBusy()) throw deps.busyError();
      if (!deps.serverRunning()) throw serverNotReady();
      const file = await deps.chooseSavePath(deps.defaultBackupPath());
      if (!file) return null;
      const result = await deps.createBackup(file, { caller, onProgress: deps.onProgress });
      // On the data folder's drive it is not a copy outside this PC; the page says so.
      const outside = await deps.recordManual(result);
      return { ...result, sameDrive: !outside };
    }),

    // The password is checked first: a wrong one stops here, before any dialog or pause.
    'backup:restore': guarded('backup:restore', async ({ caller, token }, password) => {
      if (deps.isBusy()) throw deps.busyError();
      await deps.backend().verifyPassword(token, password);
      const file = await deps.chooseOpenPath();
      if (!file) return null;
      const archive = await deps.inspect(file);
      if (!(await deps.confirmRestore(archive))) return null;
      const result = await deps.restoreArchive(archive, { caller, onProgress: deps.onProgress });
      deps.onRestored(result);
      return result;
    }),

    'backup:status': guarded('backup:status', () => deps.summary()),

    'backup:choose-copy-folder': guarded('backup:choose-copy-folder', async () => {
      const folder = await deps.chooseFolder();
      if (!folder) return null;
      if (deps.copyFolderInvalid(folder)) {
        throw Object.assign(new Error('اختر مجلداً خارج مجلد بيانات البرنامج، ويفضل على فلاشة أو قرص آخر.'), { code: 'COPY_FOLDER_INVALID' });
      }
      deps.setCopyFolder(folder);
      await deps.copyNow(); // copies today's backup there right away
      return deps.summary();
    }),

    'backup:clear-copy-folder': guarded('backup:clear-copy-folder', async () => {
      deps.setCopyFolder('');
      return deps.summary();
    }),

    // Only an existing backup file (never an arbitrary path from the page).
    'backup:show-file': guarded('backup:show-file', (_ctx, file) => {
      if (typeof file === 'string' && path.isAbsolute(file) && file.endsWith(BACKUP_SUFFIX) && fs.existsSync(file)) {
        deps.showItemInFolder(file);
      }
      return true;
    }),

    'backup:open-folder': guarded('backup:open-folder', () => deps.openBackupsFolder().then(() => true)),
  };

  // Every guarded handler has a rule and every rule has a handler.
  for (const channel of Object.keys(IPC_RULES)) {
    if (!handlers[channel]) throw new Error(`missing handler for ${channel}`);
  }
  return handlers;
}

module.exports = { NOT_SERVER_COPY, createBackupHandlers };
