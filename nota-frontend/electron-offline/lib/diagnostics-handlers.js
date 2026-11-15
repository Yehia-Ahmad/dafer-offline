'use strict';

// Stage 25: the "export diagnostics" IPC handler. Owner or manager only (shop.manage, checked in the main process with the page's session
// token like every dangerous handler); it asks where to save, then writes the zip. Nothing is sent anywhere.
//
// deps: backend(), collect() -> { zip: Buffer, fileName }, chooseSavePath(defaultName), log

const fs = require('node:fs');

const { GuardError, checkCaller } = require('./ipc-guard');

const asError = (error) => ({
  message: error.code ? error.message : `حدث خطأ غير متوقع: ${error.message}`,
  code: error.code,
  detail: error.detail,
});

function createDiagnosticsHandlers(deps) {
  return {
    'diagnostics:export': async (token) => {
      try {
        const caller = await checkCaller({ channel: 'diagnostics:export', token, backend: deps.backend() });
        const { zip, fileName } = await deps.collect();
        const target = await deps.chooseSavePath(fileName);
        if (!target) return { ok: true, value: null }; // cancelled
        const partial = `${target}.partial`;
        fs.writeFileSync(partial, zip);
        fs.rmSync(target, { force: true });
        fs.renameSync(partial, target);
        deps.log.info(`diagnostics exported by ${caller.user && caller.user.username ? caller.user.username : 'a manager'}: ${target} (${zip.length} bytes)`);
        return { ok: true, value: { path: target, bytes: zip.length } };
      } catch (error) {
        if (error instanceof GuardError) deps.log.warn(`diagnostics:export refused: ${error.code}`);
        else deps.log.error(`diagnostics:export: ${error.stack || error.message}`);
        return { ok: false, error: asError(error) };
      }
    },
  };
}

module.exports = { createDiagnosticsHandlers };
