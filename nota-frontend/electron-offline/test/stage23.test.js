'use strict';

// Stage 23: printing and PDF export in the main process (lib/print-service.js, lib/print-handlers.js), with a fake
// BrowserWindow / dialog / printer list: page size and printer per paper, silent printing only for 80mm with a configured
// printer, the locked-down hidden window, the save dialog, and the token + permission check of every print channel.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { IPC_RULES, SESSION } = require('../lib/ipc-guard');
const { createPrintHandlers } = require('../lib/print-handlers');
const { PrintError, createPrintService, normalizeSettings, readSettings, safeFileName, validateJob } = require('../lib/print-service');

const root = path.resolve(__dirname, '..');
const quietLog = { info() {}, warn() {}, error() {} };
const PRINTERS = [
  { name: 'EPSON TM-T20', displayName: 'Epson receipt', isDefault: false },
  { name: 'HP LaserJet', displayName: 'HP', isDefault: true },
];
const HTML = '<!doctype html><html><body>مرحبا</body></html>';

function harness({ printOutcome = { success: true }, saveResult, printers = PRINTERS, loadMode = 'ok', loadTimeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-print-test-'));
  const windows = [];
  const dialogCalls = [];
  const prints = [];
  const pdfs = [];
  const loads = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.handlers = {};
      this.requestFilter = null;
      const self = this;
      this.webContents = {
        on: (event, handler) => { self.handlers[event] = handler; },
        setWindowOpenHandler: (handler) => { self.openHandler = handler; },
        session: { webRequest: { onBeforeRequest: (filter) => { self.requestFilter = filter; } } },
        print: (printOptions, callback) => { prints.push(printOptions); self.printedFile = self.loaded; callback(printOutcome.success, printOutcome.reason); },
        printToPDF: async (pdfOptions) => { pdfs.push(pdfOptions); return Buffer.from('%PDF-fake'); },
        getPrintersAsync: async () => printers,
      };
      windows.push(this);
    }
    async loadFile(file) {
      this.loaded = file; this.htmlAtLoad = fs.readFileSync(file, 'utf8'); loads.push(file);
      // the request filter sees the job's own file while it loads
      if (this.requestFilter) this.requestFilter({ url: pathToFileURL(file).href }, (answer) => { this.ownFileVerdict = answer.cancel; });
      if (loadMode === 'hang') await new Promise(() => {});
      if (loadMode === 'fail') throw new Error('ERR_FAILED');
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const mainWindow = { webContents: { getPrintersAsync: async () => printers } };
  const dialog = { showSaveDialog: async (parent, options) => { dialogCalls.push({ parent, options }); return saveResult || { canceled: false, filePath: path.join(dir, 'out.pdf') }; } };
  const service = createPrintService({ BrowserWindow: FakeWindow, dialog, getMainWindow: () => mainWindow, settingsPath: path.join(dir, 'print-settings.json'), tempDir: dir, log: quietLog, loadTimeoutMs });
  return { service, dir, windows, dialogCalls, prints, pdfs, loads, mainWindow };
}
const cleanup = (h) => fs.rmSync(h.dir, { recursive: true, force: true });

test('an 80mm receipt prints silently to the configured receipt printer, at 80mm × the receipt height, with the configured copies', async () => {
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', receiptCopies: 2 });
  const result = await h.service.print({ html: HTML, paper: '80mm', heightMm: 143.2 });
  assert.deepEqual(result, { printed: true, silent: true, printer: 'EPSON TM-T20' });
  assert.equal(h.prints.length, 1);
  const options = h.prints[0];
  assert.equal(options.silent, true);
  assert.equal(options.deviceName, 'EPSON TM-T20');
  assert.equal(options.copies, 2);
  assert.deepEqual(options.pageSize, { width: 80000, height: 144000 }, 'microns: 80mm wide, the height rounded up to a whole mm');
  assert.deepEqual(options.margins, { marginType: 'none' });
  assert.equal(options.printBackground, true);
  cleanup(h);
});

test('an 80mm receipt with NO configured printer shows the system dialog (not silent, no device)', async () => {
  const h = harness();
  const result = await h.service.print({ html: HTML, paper: '80mm', heightMm: 120 });
  assert.deepEqual(result, { printed: true, silent: false, printer: null });
  assert.equal(h.prints[0].silent, false);
  assert.equal('deviceName' in h.prints[0], false);
  assert.equal(h.prints[0].copies, 1, 'one copy by default');
  cleanup(h);
});

test('A4 and A5 documents are NEVER silent; the chosen A4/A5 printer is only preselected in the system dialog (silent: false + deviceName); the page size is the paper', async () => {
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', documentPrinter: 'HP LaserJet', receiptCopies: 3 });
  for (const paper of ['A4', 'A5']) {
    const result = await h.service.print({ html: HTML, paper, copies: 4 });
    assert.equal(result.silent, false, paper);
    const options = h.prints[h.prints.length - 1];
    assert.equal(options.silent, false);
    assert.equal(options.pageSize, paper);
    assert.equal(options.copies, 1, 'the copies setting is for 80mm receipts only');
    assert.equal(options.deviceName, 'HP LaserJet', 'the A4/A5 printer is preselected, never the receipt printer');
    assert.deepEqual(result, { printed: true, silent: false, printer: 'HP LaserJet' });
  }
  // an 80mm receipt never takes the A4 printer
  const roll = await h.service.print({ html: HTML, paper: '80mm', heightMm: 100 });
  assert.equal(h.prints[h.prints.length - 1].deviceName, 'EPSON TM-T20');
  assert.equal(roll.silent, true);
  // no A4 printer chosen: the system dialog with its own default (no deviceName)
  await h.service.setSettings({ documentPrinter: '' });
  await h.service.print({ html: HTML, paper: 'A4' });
  assert.equal('deviceName' in h.prints[h.prints.length - 1], false);
  assert.equal(h.prints[h.prints.length - 1].silent, false);
  cleanup(h);
});

test('closing the system print dialog is not an error; a driver failure is', async () => {
  const cancelled = harness({ printOutcome: { success: false, reason: 'cancelled' } });
  assert.deepEqual(await cancelled.service.print({ html: HTML, paper: 'A4' }), { printed: false, silent: false, printer: null, cancelled: true });
  cleanup(cancelled);
  const failed = harness({ printOutcome: { success: false, reason: 'Printer offline' } });
  await assert.rejects(() => failed.service.print({ html: HTML, paper: 'A4' }), (error) => error instanceof PrintError && error.code === 'PRINT_FAILED' && /Printer offline/.test(error.message));
  assert.equal(failed.windows[0].destroyed, false, 'the hidden window is kept (destroying it broke the next print on Electron 35)');
  failed.printOutcomeOk = true;
  cleanup(failed);
});

test('the hidden print window is locked down: sandbox, no JavaScript, no preload, no Node, navigation and new windows blocked, network refused', async () => {
  const h = harness();
  await h.service.print({ html: HTML, paper: 'A4' });
  const win = h.windows[0];
  const prefs = win.options.webPreferences;
  assert.equal(win.options.show, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.javascript, false);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal('preload' in prefs, false);
  assert.equal(prefs.partition, 'nota-print', 'its own session: the default session of the app is never used');
  assert.equal(String(prefs.partition).startsWith('persist:'), false, 'in memory only');
  let prevented = 0;
  win.handlers['will-navigate']({ preventDefault: () => { prevented += 1; } });
  win.handlers['will-redirect']({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.deepEqual(win.openHandler(), { action: 'deny' });
  const verdict = (url) => { let result; win.requestFilter({ url }, (answer) => { result = answer; }); return result.cancel; };
  assert.equal(verdict('https://fonts.googleapis.com/css2?family=Alexandria'), true, 'Google Fonts is never loaded');
  assert.equal(verdict('http://192.168.1.5:5055/api/x'), true);
  assert.equal(verdict('data:font/woff2;base64,AAAA'), false);
  assert.equal(win.ownFileVerdict, false, 'the own temp file of the job is allowed while it loads');
  assert.equal(verdict('file:///C:/Users/x/AppData/Local/Temp/nota-print-1.html'), true, 'no other file: URL, and none once the job is over');
  assert.equal(verdict('about:blank'), false);
  assert.equal(verdict('blob:null/abc'), true);
  assert.equal(verdict('ws://127.0.0.1:5055/'), true);
  assert.match(win.htmlAtLoad, /مرحبا/, 'the document HTML is what was loaded');
  assert.equal(win.destroyed, false, 'one hidden window, reused: destroying a sandboxed window broke the next load');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(win.loaded), false, 'the temporary HTML file is removed');
  cleanup(h);
});

test('many prints reuse ONE hidden window and run one at a time, in order, even when started together; a failed job does not stop the next', async () => {
  const h = harness();
  const order = [];
  const results = await Promise.all([1, 2, 3, 4].map((n) => h.service.print({ html: `<html><body>job ${n}</body></html>`, paper: 'A4' }).then((r) => { order.push(n); return r; })));
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(h.windows.length, 1, 'a single window for all prints');
  assert.equal(results.every((r) => r.printed), true);
  assert.deepEqual(h.loads.length, 4);
  const saved = await h.service.savePdf({ html: HTML, paper: 'A5' });
  assert.equal(saved.saved, true);
  assert.equal(h.windows.length, 1, 'PDF export and test pages use the same window');
  cleanup(h);
  const failing = harness({ printOutcome: { success: false, reason: 'Printer offline' } });
  const first = failing.service.print({ html: HTML, paper: 'A4' }).catch((error) => error.code);
  const second = failing.service.print({ html: HTML, paper: 'A4' }).catch((error) => error.code);
  assert.deepEqual(await Promise.all([first, second]), ['PRINT_FAILED', 'PRINT_FAILED']);
  assert.equal(failing.windows.length, 1);
  cleanup(failing);
});

test('save PDF: printToPDF at the right page size (80mm × height in inches, A4, A5) and the document\'s own @page, then the save dialog', async () => {
  const h = harness();
  const roll = await h.service.savePdf({ html: HTML, paper: '80mm', heightMm: 200, title: 'INV-000125' }, { suggestedName: 'INV-000125' });
  assert.equal(roll.saved, true);
  assert.equal(fs.readFileSync(roll.path, 'utf8'), '%PDF-fake');
  const rollOptions = h.pdfs[0];
  assert.ok(Math.abs(rollOptions.pageSize.width - 80 / 25.4) < 1e-9);
  assert.ok(Math.abs(rollOptions.pageSize.height - 200 / 25.4) < 1e-9);
  assert.equal(rollOptions.preferCSSPageSize, true);
  assert.equal(rollOptions.printBackground, true);
  await h.service.savePdf({ html: HTML, paper: 'A4' });
  await h.service.savePdf({ html: HTML, paper: 'A5' });
  assert.deepEqual(h.pdfs.slice(1).map((entry) => entry.pageSize), ['A4', 'A5']);
  assert.equal(h.dialogCalls[0].options.defaultPath, 'INV-000125.pdf');
  assert.deepEqual(h.dialogCalls[0].options.filters, [{ name: 'PDF', extensions: ['pdf'] }]);
  assert.equal(h.dialogCalls[0].parent, h.mainWindow, 'the dialog belongs to the main window');
  cleanup(h);
});

test('save PDF: cancelling the save dialog writes nothing; a path without .pdf gets it; file-name characters are made safe', async () => {
  const cancelled = harness({ saveResult: { canceled: true } });
  assert.deepEqual(await cancelled.service.savePdf({ html: HTML, paper: 'A4' }), { saved: false });
  assert.deepEqual(fs.readdirSync(cancelled.dir).filter((name) => name.endsWith('.pdf')), []);
  cleanup(cancelled);
  const plain = harness();
  plain.dialogCalls.length = 0;
  const target = path.join(plain.dir, 'income');
  const again = harness({ saveResult: { canceled: false, filePath: target } });
  const saved = await again.service.savePdf({ html: HTML, paper: 'A4' });
  assert.equal(saved.path, `${target}.pdf`);
  assert.ok(fs.existsSync(`${target}.pdf`));
  assert.equal(safeFileName('قائمة/الدخل: أكتوبر*'), 'قائمة-الدخل- أكتوبر-.pdf');
  assert.equal(safeFileName(''), 'Nota.pdf');
  cleanup(plain); cleanup(again);
});

test('a job is validated: paper, html, a roll height, size', () => {
  assert.throws(() => validateJob(null), PrintError);
  assert.throws(() => validateJob({ html: '', paper: 'A4' }), /المستند فارغ/);
  assert.throws(() => validateJob({ html: HTML, paper: 'Letter' }), /مقاس الورق/);
  assert.throws(() => validateJob({ html: HTML, paper: '80mm' }), /ارتفاع الإيصال/);
  assert.throws(() => validateJob({ html: 'x'.repeat(26 * 1024 * 1024), paper: 'A4' }), /كبير جدًا/);
  assert.equal(validateJob({ html: HTML, paper: '80mm', heightMm: 5 }).heightMm, 40, 'a tiny roll is raised to the minimum');
  assert.equal(validateJob({ html: HTML, paper: '80mm', heightMm: 99999 }).heightMm, 1500);
  assert.equal(validateJob({ html: HTML, paper: 'A4', copies: 99 }).copies, 5);
});

test('print settings: stored per PC in print-settings.json; an unknown printer is refused; copies are 1..5; a damaged file means the defaults', async () => {
  const h = harness();
  assert.deepEqual(h.service.getSettings(), { schemaVersion: 1, receiptPrinter: '', documentPrinter: '', autoPrintReceipt: false, receiptCopies: 1 });
  const saved = await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', autoPrintReceipt: true, receiptCopies: 9 });
  assert.equal(saved.receiptCopies, 5);
  assert.deepEqual(readSettings(path.join(h.dir, 'print-settings.json')), saved);
  assert.equal(h.service.getSettings().autoPrintReceipt, true);
  await assert.rejects(() => h.service.setSettings({ receiptPrinter: 'Nope' }), (error) => error.code === 'PRINTER_NOT_FOUND');
  assert.equal(h.service.getSettings().receiptPrinter, 'EPSON TM-T20', 'a refused change keeps the old settings');
  const cleared = await h.service.setSettings({ receiptPrinter: '' });
  assert.equal(cleared.receiptPrinter, '');
  fs.writeFileSync(path.join(h.dir, 'print-settings.json'), '{not json');
  assert.equal(h.service.getSettings().receiptCopies, 1);
  assert.equal(normalizeSettings({ autoPrintReceipt: 'yes' }).autoPrintReceipt, false, 'only a real true turns auto-print on');
  assert.deepEqual((await h.service.listPrinters()).map((printer) => printer.name), ['EPSON TM-T20', 'HP LaserJet']);
  cleanup(h);
});

test('test pages go straight to the chosen printer: the receipt printer at 80mm, the A4 printer at A4; with none chosen the system dialog', async () => {
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', documentPrinter: 'HP LaserJet' });
  await h.service.printTestPage({ kind: 'receipt', html: HTML, heightMm: 90 });
  await h.service.printTestPage({ kind: 'document', html: HTML });
  assert.deepEqual([h.prints[0].silent, h.prints[0].deviceName, h.prints[0].pageSize], [true, 'EPSON TM-T20', { width: 80000, height: 90000 }]);
  assert.deepEqual([h.prints[1].silent, h.prints[1].deviceName, h.prints[1].pageSize], [true, 'HP LaserJet', 'A4']);
  await h.service.setSettings({ documentPrinter: '' });
  await h.service.printTestPage({ kind: 'document', html: HTML });
  assert.equal(h.prints[2].silent, false);
  await assert.rejects(() => h.service.printTestPage({ kind: 'x', html: HTML }), PrintError);
  cleanup(h);
});

test('test page: the printer picked in the dropdown is the one used (sent with the request), even before it is saved; an unknown one is refused', async () => {
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20' });
  await h.service.printTestPage({ kind: 'receipt', html: HTML, heightMm: 90, printer: 'HP LaserJet' });
  assert.deepEqual([h.prints[0].silent, h.prints[0].deviceName], [true, 'HP LaserJet'], 'the request wins over the saved printer');
  await h.service.printTestPage({ kind: 'document', html: HTML, printer: '' });
  assert.equal(h.prints[1].silent, false, 'an empty choice means the system dialog');
  assert.equal(h.prints[1].deviceName, undefined);
  await assert.rejects(() => h.service.printTestPage({ kind: 'document', html: HTML, printer: 'Ghost' }), (error) => error.code === 'PRINTER_NOT_FOUND');
  assert.equal(h.prints.length, 2);
  assert.equal(h.service.getSettings().receiptPrinter, 'EPSON TM-T20', 'nothing was saved by the test');
  cleanup(h);
});

test('a renderer crash destroys the hidden window and the next job gets a new one; the job that was running fails', async () => {
  const h = harness();
  await h.service.print({ html: HTML, paper: 'A4' });
  const first = h.windows[0];
  first.handlers['render-process-gone']();
  assert.equal(first.destroyed, true, 'the crashed window is destroyed');
  const result = await h.service.print({ html: HTML, paper: 'A4' });
  assert.equal(result.printed, true);
  assert.equal(h.windows.length, 2, 'a new window for the next job');
  assert.notEqual(h.windows[1], first);
  // a crash in the middle of a job fails that job, and the queue goes on
  const mid = harness();
  mid.windows.length = 0;
  const running = mid.service.print({ html: HTML, paper: 'A4' });
  await new Promise((resolve) => setImmediate(resolve));
  mid.windows[0].handlers['render-process-gone']();
  await running.catch(() => {});
  assert.equal((await mid.service.print({ html: HTML, paper: 'A4' })).printed, true);
  cleanup(h); cleanup(mid);
});

test('a load that never finishes times out (PRINT_TIMEOUT), the window is discarded, the queue is free and the temp file is gone', async () => {
  const h = harness({ loadMode: 'hang', loadTimeoutMs: 40 });
  const started = Date.now();
  await assert.rejects(() => h.service.print({ html: HTML, paper: 'A4' }), (error) => error.code === 'PRINT_TIMEOUT');
  assert.ok(Date.now() - started < 2000);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(fs.readdirSync(h.dir).filter((name) => name.startsWith('nota-print-')).length, 0, 'no temp file left');
  await assert.rejects(() => h.service.savePdf({ html: HTML, paper: 'A4' }), (error) => error.code === 'PRINT_TIMEOUT');
  assert.equal(h.windows.length, 2, 'each job after a timeout gets a fresh window and is not stuck behind the hung one');
  cleanup(h);
});

test('every job removes its temporary file right after it, on success, on a print failure and on a load failure', async () => {
  const left = (h) => fs.readdirSync(h.dir).filter((name) => name.startsWith('nota-print-'));
  const ok = harness();
  await ok.service.print({ html: HTML, paper: 'A4' });
  assert.deepEqual(left(ok), [], 'right after the job, no waiting');
  await ok.service.savePdf({ html: HTML, paper: 'A4' });
  assert.deepEqual(left(ok), []);
  const failing = harness({ printOutcome: { success: false, reason: 'Printer offline' } });
  await assert.rejects(() => failing.service.print({ html: HTML, paper: 'A4' }));
  assert.deepEqual(left(failing), []);
  const broken = harness({ loadMode: 'fail' });
  await assert.rejects(() => broken.service.print({ html: HTML, paper: 'A4' }));
  assert.deepEqual(left(broken), []);
  cleanup(ok); cleanup(failing); cleanup(broken);
});

function handlerHarness(permissions, { me } = {}) {
  const calls = [];
  const service = new Proxy({}, { get: (_target, name) => async (...args) => { calls.push([name, ...args]); return { name }; } });
  const backend = { me: async (token) => { if (token === 'x'.repeat(20)) throw Object.assign(new Error('expired'), { code: 'SESSION_EXPIRED' }); return me || { user: { name: 'u' }, permissions }; } };
  return { calls, handlers: createPrintHandlers({ service, backend: () => backend, log: quietLog }) };
}
const TOKEN = 'valid-token-0123456789';

test('every print channel is guarded in the main process: no token or an expired one → SESSION_EXPIRED and nothing runs', async () => {
  const { calls, handlers } = handlerHarness(['sales.create']);
  const jobs = { 'print:printers': [], 'print:settings-get': [], 'print:settings-set': [{}], 'print:test-page': [{}], 'print:print': [{}], 'print:pdf': [{}, {}] };
  for (const [channel, args] of Object.entries(jobs)) {
    for (const token of [undefined, '', 'short', 'x'.repeat(20)]) {
      const result = await handlers[channel](token, ...args);
      assert.equal(result.ok, false, `${channel} ${String(token)}`);
      assert.equal(result.error.code, 'SESSION_EXPIRED');
    }
  }
  assert.deepEqual(calls, [], 'the service was never called');
});

test('print:settings-set and print:test-page need shop.manage; printing, PDF, the printer list and reading the settings need only a session', async () => {
  const cashier = handlerHarness(['sales.create']);
  for (const channel of ['print:settings-set', 'print:test-page']) {
    const result = await cashier.handlers[channel](TOKEN, { receiptPrinter: 'x' });
    assert.deepEqual([result.ok, result.error.code], [false, 'FORBIDDEN'], channel);
  }
  assert.deepEqual(cashier.calls, []);
  for (const [channel, name, args] of [['print:printers', 'listPrinters', []], ['print:settings-get', 'getSettings', []], ['print:print', 'print', [{ html: HTML, paper: 'A4' }]], ['print:pdf', 'savePdf', [{ html: HTML, paper: 'A4' }, { suggestedName: 'a' }]]]) {
    const result = await cashier.handlers[channel](TOKEN, ...args);
    assert.equal(result.ok, true, channel);
    assert.equal(cashier.calls.at(-1)[0], name);
  }
  const manager = handlerHarness(['shop.manage']);
  assert.equal((await manager.handlers['print:settings-set'](TOKEN, { autoPrintReceipt: true })).ok, true);
  assert.deepEqual(manager.calls[0], ['setSettings', { autoPrintReceipt: true }]);
  assert.equal((await manager.handlers['print:test-page'](TOKEN, { kind: 'receipt' })).ok, true);
});

test('a print error comes back as { ok: false, error } with its Arabic message and code, never as a throw', async () => {
  const service = { print: async () => { throw new PrintError('PRINT_FAILED', 'تعذرت الطباعة: offline'); } };
  const handlers = createPrintHandlers({ service, backend: () => ({ me: async () => ({ user: {}, permissions: [] }) }), log: quietLog });
  assert.deepEqual(await handlers['print:print'](TOKEN, {}), { ok: false, error: { message: 'تعذرت الطباعة: offline', code: 'PRINT_FAILED' } });
});

test('the six print channels have IPC rules, the preload exposes them with the token first, and main.js registers them', () => {
  assert.equal(IPC_RULES['print:settings-set'], 'shop.manage');
  assert.equal(IPC_RULES['print:test-page'], 'shop.manage');
  for (const channel of ['print:printers', 'print:settings-get', 'print:print', 'print:pdf']) assert.equal(IPC_RULES[channel], SESSION, channel);
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  for (const channel of Object.keys(IPC_RULES).filter((name) => name.startsWith('print:'))) assert.ok(preload.includes(`'${channel}', token`), `preload: ${channel}`);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /registerPrintIpc\(\);/);
  assert.match(main, /print-settings\.json/);
  assert.ok(!/javascript:\s*true/.test(fs.readFileSync(path.join(root, 'lib', 'print-service.js'), 'utf8')), 'the print window never enables JavaScript');
});
