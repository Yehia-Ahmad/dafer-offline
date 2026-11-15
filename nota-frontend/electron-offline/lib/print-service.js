'use strict';

// Stage 23: printing and "save as PDF" for every document, from one place.
//
// The Angular app builds the document's complete HTML (fonts embedded, light palette, `@page`
// rules, page-number margin boxes) and sends it here. This module:
//   * renders it in a HIDDEN BrowserWindow with no preload, no Node, sandbox on, JavaScript off, its OWN in-memory
//     session (partition 'nota-print'), navigation and new windows blocked and every request refused except the
//     job's own temp file, data: and about:blank (prints work offline and never load Google Fonts);
//   * "طباعة": webContents.print(). 80mm receipts go silently to the configured receipt printer;
//     everything else (and a receipt with no printer configured) shows the system dialog;
//   * "حفظ PDF": webContents.printToPDF() (vector text, the right page size) saved through a save dialog;
//   * test pages for the receipt printer and the A4/A5 printer;
//   * the per-PC settings file (print-settings.json in the Nota home folder).
//
// Electron-free on purpose: `BrowserWindow`, `dialog` and the printer list are injected, so the
// tests drive it with fakes (test/stage23.test.js). main.js passes the real ones.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const labels = require('./label-settings');

const SETTINGS_VERSION = 1;
const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_VERSION,
  receiptPrinter: '', // '' = none configured (the system dialog is shown)
  documentPrinter: '', // A4/A5 printer; '' = the system default
  autoPrintReceipt: false,
  receiptCopies: 1,
  // Stage 25: how much of the 80mm roll this printer really prints (72 / 76 / 80 mm) and a sideways shift of the receipt (-10..10 mm, + = to the right).
  receiptWidthMm: 80,
  receiptOffsetMm: 0,
  // Stage 26: the label printer ('' = none: the system dialog), its roll size / calibration / gap, the A4 sticker sheet grid,
  // the remembered label content options and the scan sounds mute. All per PC.
  labelPrinter: '',
  labelRoll: labels.normalizeRoll({}),
  labelSheet: labels.normalizeSheet({}),
  labelOptions: labels.normalizeLabelOptions({}),
  scanSoundMuted: false,
});
const PREF_KEYS = Object.freeze(['scanSoundMuted', 'labelOptions']); // what a plain signed-in user may change (print:prefs-set)
const RECEIPT_WIDTHS_MM = Object.freeze([72, 76, 80]);
const MAX_OFFSET_MM = 10;
const MAX_COPIES = 5;
const MAX_HTML_BYTES = 25 * 1024 * 1024;
const PAPERS = Object.freeze({ '80mm': { widthMm: 80 }, A4: { name: 'A4' }, A5: { name: 'A5' }, label: { custom: true } });
const PRINT_PARTITION = 'nota-print';
const LOAD_TIMEOUT_MS = 30000;
const MIN_ROLL_MM = 40;
const MAX_ROLL_MM = 1500;

class PrintError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const badInput = (message) => new PrintError('INVALID_INPUT', message);
const mmToInches = (mm) => mm / 25.4;
const mmToMicrons = (mm) => Math.round(mm * 1000);
const normalizeWidthMm = (value) => (RECEIPT_WIDTHS_MM.includes(Number(value)) ? Number(value) : 80);
// Half-millimetre steps, never NaN: a damaged file or a hostile value becomes 0.
const normalizeOffsetMm = (value) => {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(MAX_OFFSET_MM, Math.max(-MAX_OFFSET_MM, number)) * 2) / 2;
};
const clampCopies = (value) => Math.min(MAX_COPIES, Math.max(1, Number.isInteger(value) ? value : 1));

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 256) : '');
  return {
    schemaVersion: SETTINGS_VERSION,
    receiptPrinter: text(source.receiptPrinter),
    documentPrinter: text(source.documentPrinter),
    autoPrintReceipt: source.autoPrintReceipt === true,
    receiptCopies: clampCopies(source.receiptCopies),
    receiptWidthMm: normalizeWidthMm(source.receiptWidthMm),
    receiptOffsetMm: normalizeOffsetMm(source.receiptOffsetMm),
    labelPrinter: text(source.labelPrinter),
    labelRoll: labels.normalizeRoll(source.labelRoll),
    labelSheet: labels.normalizeSheet(source.labelSheet),
    labelOptions: labels.normalizeLabelOptions(source.labelOptions),
    scanSoundMuted: source.scanSoundMuted === true,
  };
}

/** The settings of this PC. A missing or damaged file means the defaults (the system dialog, 1 copy, no auto-print). */
function readSettings(file) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw badInput('بيانات الطباعة غير صحيحة.');
  if (typeof job.html !== 'string' || !job.html.trim()) throw badInput('المستند فارغ.');
  if (Buffer.byteLength(job.html, 'utf8') > MAX_HTML_BYTES) throw badInput('المستند كبير جدًا للطباعة.');
  if (!Object.prototype.hasOwnProperty.call(PAPERS, job.paper)) throw badInput('مقاس الورق غير مدعوم.');
  const out = { html: job.html, paper: job.paper, title: typeof job.title === 'string' ? job.title.slice(0, 120) : 'Nota' };
  if (job.paper === '80mm') {
    const height = Number(job.heightMm);
    if (!Number.isFinite(height)) throw badInput('ارتفاع الإيصال غير محدد.');
    out.heightMm = Math.min(MAX_ROLL_MM, Math.max(MIN_ROLL_MM, Math.ceil(height)));
  }
  // Stage 26: a label roll page (its size is the label + gap, clamped) and A4 sticker sheets (no page margin).
  if (job.paper === 'label') {
    if (!job.labelPage || typeof job.labelPage !== 'object') throw badInput('مقاس الملصق غير محدد.');
    out.labelPage = labels.normalizeLabelPage(job.labelPage);
  }
  if (job.paper === 'A4' && job.noMargins === true) out.noMargins = true;
  if (job.copies !== undefined) out.copies = clampCopies(Number(job.copies));
  return out;
}

const safeFileName = (name) => {
  const cleaned = String(name || 'Nota').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${cleaned || 'Nota'}.pdf`;
};

/**
 * deps:
 *   BrowserWindow            Electron's class (or a fake)
 *   dialog                   { showSaveDialog(window, options) }
 *   getMainWindow()          the visible window (parent of the save dialog, source of the printer list)
 *   settingsPath             print-settings.json
 *   tempDir                  where the temporary HTML files go (default: the OS temp folder)
 *   log                      { info, warn, error }
 */
function createPrintService(deps) {
  const { BrowserWindow, dialog, getMainWindow, settingsPath, log } = deps;
  const tempDir = deps.tempDir || os.tmpdir();
  const loadTimeoutMs = deps.loadTimeoutMs || LOAD_TIMEOUT_MS;

  async function listPrinters() {
    const main = getMainWindow();
    if (!main || !main.webContents || typeof main.webContents.getPrintersAsync !== 'function') return [];
    const printers = await main.webContents.getPrintersAsync();
    return printers.map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      isDefault: Boolean(printer.isDefault),
    }));
  }

  const getSettings = () => readSettings(settingsPath);

  async function setSettings(patch) {
    if (!patch || typeof patch !== 'object') throw badInput('الإعدادات غير صحيحة.');
    const next = normalizeSettings({ ...getSettings(), ...patch });
    for (const key of ['receiptPrinter', 'documentPrinter', 'labelPrinter']) {
      if (!next[key]) continue;
      const known = (await listPrinters()).some((printer) => printer.name === next[key]);
      if (!known) throw new PrintError('PRINTER_NOT_FOUND', 'الطابعة المختارة غير موجودة على هذا الجهاز.');
    }
    writeSettings(settingsPath, next);
    return next;
  }

  /** Stage 26: the preferences any signed-in user may keep on this PC (label content options, scan sound mute). Whitelisted keys only: a printer or the label geometry needs setSettings (shop.manage). */
  function setPrefs(patch) {
    if (!patch || typeof patch !== 'object') throw badInput('الإعدادات غير صحيحة.');
    const picked = {};
    for (const key of PREF_KEYS) if (Object.prototype.hasOwnProperty.call(patch, key)) picked[key] = patch[key];
    const next = normalizeSettings({ ...getSettings(), ...picked });
    writeSettings(settingsPath, next);
    return next;
  }

  // ONE hidden window, created on the first print and reused for every later one (destroying a healthy sandboxed
  // window between jobs made the next load fail on Electron 35 / Windows; a reset to about:blank fails with ERR_FAILED
  // there too, so the previous document simply stays until the next job replaces it). It is destroyed only when its renderer crashes or a load times out; the next job makes a new one.
  // Jobs run one at a time (a queue), because they share that window.
  //
  // The window has its OWN in-memory session (partition 'nota-print': no "persist:" prefix, so nothing is written to
  // disk) and the request filter is installed on THAT session only. session.defaultSession (the app's own window and
  // its API calls) is never touched.
  let shared = null;
  let queue = Promise.resolve();
  let allowedUrl = ''; // the one file: URL the current job may load
  let abortJob = null; // rejects the running job (renderer crash)

  const sameUrl = (a, b) => a.toLowerCase() === b.toLowerCase();
  /** Only the job's own temp file, data: URIs (embedded fonts / images) and about:blank. Everything else is refused. */
  function allowRequest(url) {
    if (/^data:/i.test(url) || /^about:blank$/i.test(url)) return true;
    return Boolean(allowedUrl) && sameUrl(url, allowedUrl);
  }

  function discardWindow(win) {
    if (shared === win) shared = null;
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch (error) {
      log.warn(`print window destroy: ${error.message}`);
    }
  }

  function sharedWindow() {
    if (shared && !shared.isDestroyed()) return shared;
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { partition: PRINT_PARTITION, devTools: false, sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    const contents = win.webContents;
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('render-process-gone', () => {
      log.warn('print window renderer gone: window discarded, the next job makes a new one');
      const abort = abortJob;
      discardWindow(win);
      if (abort) abort(new PrintError('PRINT_FAILED', 'توقفت نافذة الطباعة. حاول مرة أخرى.'));
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // THIS window's own session (never defaultSession).
    if (contents.session && contents.session.webRequest) {
      contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowRequest(details.url) }));
    }
    shared = win;
    return win;
  }

  const withTimeout = (promise, ms, onTimeout) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); reject(new PrintError('PRINT_TIMEOUT', 'استغرق تجهيز المستند للطباعة وقتًا طويلًا.')); }, ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });

  /** Renders `html` in the locked-down hidden window; run(win) gets it loaded. The temp file is removed after every job, failed or not. */
  function withRenderedWindow(html, run) {
    const job = queue.then(async () => {
      const file = path.join(tempDir, `nota-print-${randomUUID()}.html`);
      let win = null;
      try {
        fs.writeFileSync(file, html, 'utf8');
        allowedUrl = pathToFileURL(file).href;
        win = sharedWindow();
        const current = win;
        const crashed = new Promise((_, reject) => { abortJob = reject; });
        crashed.catch(() => {});
        await Promise.race([withTimeout(current.loadFile(file), loadTimeoutMs, () => discardWindow(current)), crashed]);
        return await Promise.race([run(current), crashed]);
      } finally {
        abortJob = null;
        allowedUrl = '';
        try {
          fs.rmSync(file, { force: true });
        } catch (error) {
          log.warn(`print temp file: ${error.message}`);
        }
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  const pageOptions = (job) =>
    job.paper === '80mm' ? { width: mmToInches(80), height: mmToInches(job.heightMm) }
      : job.paper === 'label' ? { width: mmToInches(job.labelPage.widthMm), height: mmToInches(job.labelPage.heightMm) }
        : job.paper;

  /** Page size + margins for webContents.print(): rolls and labels are exact sizes with no margin; A4 sticker sheets have no margin either. */
  function printPageOptions(job) {
    if (job.paper === '80mm') return { pageSize: { width: mmToMicrons(80), height: mmToMicrons(job.heightMm) }, margins: { marginType: 'none' } };
    if (job.paper === 'label') return { pageSize: { width: mmToMicrons(job.labelPage.widthMm), height: mmToMicrons(job.labelPage.heightMm) }, margins: { marginType: 'none' } };
    return { pageSize: job.paper, margins: { marginType: job.paper === 'A4' && job.noMargins ? 'none' : 'default' } };
  }

  /** "طباعة": silent for an 80mm receipt with a configured receipt printer and for a label with a configured label printer. Resolves { printed, silent, printer }. */
  async function print(rawJob) {
    const job = validateJob(rawJob);
    const settings = getSettings();
    const silentPrinter = job.paper === '80mm' ? settings.receiptPrinter : job.paper === 'label' ? settings.labelPrinter : '';
    const silent = Boolean(silentPrinter);
    const options = { silent, printBackground: true, copies: job.paper === '80mm' ? clampCopies(job.copies ?? settings.receiptCopies) : 1 };
    if (silent) options.deviceName = silentPrinter;
    // A4/A5 is never silent: the chosen A4/A5 printer is only PRESELECTED in the system dialog (silent: false + deviceName).
    // A label with no label printer configured also shows the dialog (no preselection).
    const preselected = job.paper === 'A4' || job.paper === 'A5' ? settings.documentPrinter : '';
    if (preselected) options.deviceName = preselected;
    Object.assign(options, printPageOptions(job));
    return withRenderedWindow(job.html, (win) => new Promise((resolve, reject) => {
      win.webContents.print(options, (success, reason) => {
        if (success) return resolve({ printed: true, silent, printer: silent ? silentPrinter : preselected || null });
        // The user closing the system dialog is not an error.
        if (/cancel/i.test(String(reason))) return resolve({ printed: false, silent, printer: null, cancelled: true });
        log.warn(`print failed: ${reason}`);
        return reject(new PrintError('PRINT_FAILED', `تعذرت الطباعة: ${reason || 'خطأ غير معروف'}`));
      });
    }));
  }

  /** "حفظ PDF": a vector PDF at the document's page size, written where the user picks. */
  async function savePdf(rawJob, { suggestedName } = {}) {
    const job = validateJob(rawJob);
    const pdf = await withRenderedWindow(job.html, (win) =>
      // The document's own @page (size, margins, page-number boxes) wins; pageSize is the fallback.
      win.webContents.printToPDF({ pageSize: pageOptions(job), printBackground: true, preferCSSPageSize: true }));
    const picked = await dialog.showSaveDialog(getMainWindow() || undefined, {
      title: 'حفظ PDF',
      defaultPath: safeFileName(suggestedName || job.title),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (picked.canceled || !picked.filePath) return { saved: false };
    const target = /\.pdf$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.pdf`;
    fs.writeFileSync(target, pdf);
    return { saved: true, path: target, bytes: pdf.length };
  }

  /** A test page to the chosen printer ("receipt" = 80mm, "document" = A4), always silent: that is the point of the button. */
  async function printTestPage({ kind, html, heightMm, labelPage, printer: chosen }) {
    // Stage 26: 'label' = a test label on the label printer, 'sheet' = the A4 outline test sheet (no page margin) on the A4/A5 printer.
    if (!['receipt', 'document', 'label', 'sheet'].includes(kind)) throw badInput('نوع صفحة التجربة غير صحيح.');
    const settings = getSettings();
    // The printer picked in the dropdown right now (sent with the request); the saved one only when none is sent.
    let printer = kind === 'receipt' ? settings.receiptPrinter : kind === 'label' ? settings.labelPrinter : settings.documentPrinter;
    if (typeof chosen === 'string') {
      printer = chosen.trim().slice(0, 256);
      if (printer && !(await listPrinters()).some((entry) => entry.name === printer)) throw new PrintError('PRINTER_NOT_FOUND', 'الطابعة المختارة غير موجودة على هذا الجهاز.');
    }
    const paper = kind === 'receipt' ? '80mm' : kind === 'label' ? 'label' : 'A4';
    const job = validateJob({
      html, paper, title: 'Nota test page',
      heightMm: kind === 'receipt' ? heightMm : undefined,
      labelPage: kind === 'label' ? labelPage : undefined,
      noMargins: kind === 'sheet',
    });
    const options = { silent: Boolean(printer), printBackground: true, copies: 1 };
    if (printer) options.deviceName = printer;
    Object.assign(options, printPageOptions(job));
    return withRenderedWindow(job.html, (win) => new Promise((resolve, reject) => {
      win.webContents.print(options, (success, reason) => {
        if (success) return resolve({ printed: true, printer: printer || null });
        if (/cancel/i.test(String(reason))) return resolve({ printed: false, printer: null, cancelled: true });
        return reject(new PrintError('PRINT_FAILED', `تعذرت الطباعة: ${reason || 'خطأ غير معروف'}`));
      });
    }));
  }

  return { getSettings, listPrinters, print, printTestPage, savePdf, setPrefs, setSettings };
}

module.exports = {
  DEFAULT_SETTINGS,
  PREF_KEYS,
  MAX_COPIES,
  PAPERS,
  PrintError,
  createPrintService,
  normalizeSettings,
  RECEIPT_WIDTHS_MM,
  MAX_OFFSET_MM,
  readSettings,
  safeFileName,
  validateJob,
  writeSettings,
};
