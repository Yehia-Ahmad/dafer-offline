'use strict';

// Stage 23: the print IPC handlers, with the caller checked in the main process (Stage 15 rule).
//
//   print:printers       SESSION      the installed printers
//   print:settings-get   SESSION      this PC's print settings (the cashier needs auto-print / copies)
//   print:settings-set   shop.manage  receipt printer, A4/A5 printer, auto-print, copies
//   print:test-page      shop.manage  a test page on the chosen printer
//   print:print          SESSION      "طباعة"
//   print:pdf            SESSION      "حفظ PDF"
//
// The main process never fetches document data: the page sends the finished HTML, which was built
// from API responses the backend already filtered by permission (cost fields, journal lines ...).
// The token is checked here so a stray page cannot drive printers or write files without a session.
// Results are { ok: true, value } or { ok: false, error: { message, code } }.

const { GuardError, IPC_RULES, checkCaller } = require('./ipc-guard');
const { PrintError } = require('./print-service');

const asError = (error) => ({
  message: error.code ? error.message : `حدث خطأ غير متوقع: ${error.message}`,
  code: error.code,
});

/** deps: { service (createPrintService), backend() (ipc-guard createBackendClient), log } */
function createPrintHandlers(deps) {
  const guarded = (channel, handler) => async (token, ...args) => {
    try {
      const caller = await checkCaller({ channel, token, backend: deps.backend() });
      return { ok: true, value: await handler({ caller }, ...args) };
    } catch (error) {
      if (error instanceof GuardError) deps.log.warn(`${channel} refused: ${error.code}`);
      else if (!(error instanceof PrintError)) deps.log.error(`${channel}: ${error.stack || error.message}`);
      return { ok: false, error: asError(error) };
    }
  };

  const handlers = {
    'print:printers': guarded('print:printers', () => deps.service.listPrinters()),
    'print:settings-get': guarded('print:settings-get', () => deps.service.getSettings()),
    'print:settings-set': guarded('print:settings-set', (_context, patch) => deps.service.setSettings(patch)),
    'print:test-page': guarded('print:test-page', (_context, request) => deps.service.printTestPage(request || {})),
    'print:print': guarded('print:print', (_context, job) => deps.service.print(job)),
    'print:pdf': guarded('print:pdf', (_context, job, options) => deps.service.savePdf(job, options || {})),
  };
  // Every print rule has a handler and every handler has a rule.
  for (const channel of Object.keys(IPC_RULES).filter((name) => name.startsWith('print:'))) {
    if (!handlers[channel]) throw new Error(`missing handler for ${channel}`);
  }
  for (const channel of Object.keys(handlers)) {
    if (!IPC_RULES[channel]) throw new Error(`no IPC rule for ${channel}`);
  }
  return handlers;
}

module.exports = { createPrintHandlers };
