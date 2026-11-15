'use strict';

// Stage 25: the "export diagnostics" IPC handler. Owner or manager only (shop.manage, checked in the main process with the page's session
// token like every dangerous handler); it asks where to save, then writes the zip. Nothing is sent anywhere.
//
// deps: backend(), collect({ token }) -> { zip: Buffer, fileName }, chooseSavePath(defaultName), canExportLocal() -> boolean, log
//
// 'diagnostics:export-local' is for the FAILURE screens (the server did not start: SCHEMA_TOO_NEW, the upgrade backup, database authentication, a
// damaged installation, MAIN_TOKEN_UNAVAILABLE...). The app is not running, so there is no session to check: it works only while canExportLocal() says
// the app is in such a failed state, collects without any token (no health report, no database read through the backend), and the file is the same
// redacted allowlisted zip.

const fs = require('node:fs');

const { GuardError, checkCaller } = require('./ipc-guard');

const asError = (error) => ({
  message: error.code ? error.message : `حدث خطأ غير متوقع: ${error.message}`,
  code: error.code,
  detail: error.detail,
});

async function saveZip(deps, who, { zip, fileName }) {
  const target = await deps.chooseSavePath(fileName);
  if (!target) return { ok: true, value: null }; // cancelled
  const partial = `${target}.partial`;
  fs.writeFileSync(partial, zip);
  fs.rmSync(target, { force: true });
  fs.renameSync(partial, target);
  deps.log.info(`diagnostics exported by ${who}: ${target} (${zip.length} bytes)`);
  return { ok: true, value: { path: target, bytes: zip.length } };
}

function createDiagnosticsHandlers(deps) {
  return {
    'diagnostics:export-local': async () => {
      try {
        if (!deps.canExportLocal || !deps.canExportLocal()) {
          return { ok: false, error: { message: 'هذا الخيار متاح فقط عند فشل تشغيل البرنامج. من داخل البرنامج استخدم الإعدادات ← عن البرنامج.', code: 'NOT_FAILED' } };
        }
        return await saveZip(deps, 'the failure screen', await deps.collect({ token: null }));
      } catch (error) {
        deps.log.error(`diagnostics:export-local: ${error.stack || error.message}`);
        return { ok: false, error: asError(error) };
      }
    },

    'diagnostics:export': async (token) => {
      try {
        const caller = await checkCaller({ channel: 'diagnostics:export', token, backend: deps.backend() });
        const { zip, fileName } = await deps.collect({ token });
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
