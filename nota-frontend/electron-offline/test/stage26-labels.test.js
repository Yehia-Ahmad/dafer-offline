'use strict';

// Stage 26: barcode labels in the main process (lib/print-service.js, lib/label-settings.js, lib/print-handlers.js), with a fake
// BrowserWindow / dialog / printer list: the label printer setting, silent printing to it at the label's exact size, the test
// label, the A4 outline sheet (no page margin) on the A4 printer, every label setting clamped, and the per-device prefs channel.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { IPC_RULES, PRODUCTS_PRINT_LABELS, SESSION } = require('../lib/ipc-guard');
const { normalizeRoll, normalizeSheet, normalizeLabelOptions } = require('../lib/label-settings');
const { createPrintHandlers } = require('../lib/print-handlers');
const { DEFAULT_SETTINGS, PREF_KEYS, createPrintService, normalizeSettings, validateJob } = require('../lib/print-service');

const root = path.resolve(__dirname, '..');
const quietLog = { info() {}, warn() {}, error() {} };
const PRINTERS = [
  { name: 'EPSON TM-T20', displayName: 'Epson receipt', isDefault: false },
  { name: 'Zebra ZD220', displayName: 'Zebra labels', isDefault: false },
  { name: 'HP LaserJet', displayName: 'HP', isDefault: true },
];
const HTML = '<!doctype html><html><body>label</body></html>';
const LABEL_PAGE = { widthMm: 38, heightMm: 25 };
const microns = (mm) => Math.round(mm * 1000);

function harness({ printOutcome = { success: true } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-label-test-'));
  const prints = [];
  class FakeWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = {
        on() {},
        setWindowOpenHandler() {},
        session: { webRequest: { onBeforeRequest() {} } },
        print: (options, callback) => { prints.push(options); callback(printOutcome.success, printOutcome.reason); },
        printToPDF: async () => Buffer.from('%PDF'),
        getPrintersAsync: async () => PRINTERS,
      };
    }
    async loadFile() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const mainWindow = { webContents: { getPrintersAsync: async () => PRINTERS } };
  const service = createPrintService({ BrowserWindow: FakeWindow, dialog: {}, getMainWindow: () => mainWindow, settingsPath: path.join(dir, 'print-settings.json'), tempDir: dir, log: quietLog });
  return { service, dir, prints };
}
const cleanup = (h) => fs.rmSync(h.dir, { recursive: true, force: true });

test('the label settings have safe defaults: no label printer, 38×25, 3×8 sheet, retail price, sounds on', () => {
  assert.equal(DEFAULT_SETTINGS.labelPrinter, '');
  assert.deepEqual(DEFAULT_SETTINGS.labelRoll, { preset: '38x25', widthMm: 38, heightMm: 25, offsetXmm: 0, offsetYmm: 0, gapMm: 0 });
  assert.equal(DEFAULT_SETTINGS.labelSheet.preset, '3x8');
  assert.equal(DEFAULT_SETTINGS.labelSheet.columns * DEFAULT_SETTINGS.labelSheet.rows, 24);
  assert.deepEqual(DEFAULT_SETTINGS.labelOptions, { target: 'roll', shopName: true, price: 'retail', internalCode: false });
  assert.equal(DEFAULT_SETTINGS.scanSoundMuted, false);
  // A settings file from before Stage 26 (none of these keys) reads as the defaults for them.
  const old = normalizeSettings({ receiptPrinter: 'EPSON TM-T20', receiptCopies: 2 });
  assert.equal(old.receiptPrinter, 'EPSON TM-T20');
  assert.deepEqual(old.labelRoll, DEFAULT_SETTINGS.labelRoll);
  assert.equal(old.labelPrinter, '');
});

test('every roll preset and a custom size normalise; numbers are clamped; text, objects and CSS strings fall back (no CSS injection)', () => {
  for (const [preset, [w, h]] of Object.entries({ '38x25': [38, 25], '40x30': [40, 30], '50x25': [50, 25], '50x30': [50, 30], '58x40': [58, 40] })) {
    assert.deepEqual(normalizeRoll({ preset }), { preset, widthMm: w, heightMm: h, offsetXmm: 0, offsetYmm: 0, gapMm: 0 });
  }
  assert.deepEqual(normalizeRoll({ preset: 'custom', widthMm: 99999, heightMm: -4, offsetXmm: 500, offsetYmm: '-500', gapMm: 80 }), { preset: 'custom', widthMm: 110, heightMm: 15, offsetXmm: 5, offsetYmm: -5, gapMm: 10 });
  assert.deepEqual(normalizeRoll({ preset: 'custom', widthMm: 'abc', heightMm: {}, offsetXmm: null, offsetYmm: NaN, gapMm: [] }), { preset: 'custom', widthMm: 38, heightMm: 25, offsetXmm: 0, offsetYmm: 0, gapMm: 0 });
  assert.equal(normalizeRoll({ preset: 'x;} body{display:none}' }).preset, '38x25');
  assert.equal(normalizeRoll({ offsetXmm: '1mm;color:red' }).offsetXmm, 0);
  assert.equal(normalizeRoll({ offsetXmm: 0.7 }).offsetXmm, 0.5, 'half-millimetre steps');
  assert.deepEqual(normalizeRoll(null), normalizeRoll({}));
  assert.deepEqual(normalizeRoll('38x25'), normalizeRoll({}));
});

test('the A4 sheet presets and a custom grid that is clamped to fit the page', () => {
  assert.deepEqual(['3x7', '3x8', '4x10', '5x13'].map((preset) => { const s = normalizeSheet({ preset }); return [s.columns * s.rows, s.labelWidthMm, s.labelHeightMm]; }), [[21, 70, 42.3], [24, 70, 37], [40, 52.5, 29.7], [65, 38.1, 21.2]]);
  const big = normalizeSheet({ preset: 'custom', columns: 99, rows: 99, labelWidthMm: 9999, labelHeightMm: 9999, marginTopMm: 999, marginSideMm: 999, gapXmm: 999, gapYmm: 999 });
  assert.equal(big.columns, 10);
  assert.equal(big.rows, 30);
  assert.ok(2 * big.marginSideMm + big.columns * big.labelWidthMm + (big.columns - 1) * big.gapXmm <= 210.5);
  assert.ok(2 * big.marginTopMm + big.rows * big.labelHeightMm + (big.rows - 1) * big.gapYmm <= 297.5);
  const custom = normalizeSheet({ preset: 'custom', columns: 2, rows: 3, labelWidthMm: 90, labelHeightMm: 60, marginTopMm: 12, marginSideMm: 10, gapXmm: 5, gapYmm: 4 });
  assert.deepEqual(custom, { preset: 'custom', columns: 2, rows: 3, labelWidthMm: 90, labelHeightMm: 60, marginTopMm: 12, marginSideMm: 10, gapXmm: 5, gapYmm: 4 });
  assert.equal(normalizeSheet({ preset: 'a;}b{c' }).preset, '3x8');
  assert.equal(normalizeSheet({ preset: 'custom', columns: 'x', rows: {} }).columns, 3);
});

test('label content options are whitelisted', () => {
  assert.deepEqual(normalizeLabelOptions({ target: 'sheet', shopName: false, price: 'discounted', internalCode: true }), { target: 'sheet', shopName: false, price: 'discounted', internalCode: true });
  assert.deepEqual(normalizeLabelOptions({ target: 'x', shopName: 'yes', price: 'cost', internalCode: 1 }), { target: 'roll', shopName: true, price: 'retail', internalCode: false });
  assert.deepEqual(normalizeLabelOptions(null), DEFAULT_SETTINGS.labelOptions);
});

test('the label printer must be installed on this PC; the roll, sheet and options are saved normalised', async () => {
  const h = harness();
  await assert.rejects(h.service.setSettings({ labelPrinter: 'Ghost' }), (error) => error.code === 'PRINTER_NOT_FOUND');
  const saved = await h.service.setSettings({ labelPrinter: 'Zebra ZD220', labelRoll: { preset: 'custom', widthMm: 45, heightMm: 32.5, gapMm: 3, offsetXmm: 1.5 }, labelSheet: { preset: '5x13' }, scanSoundMuted: true });
  assert.equal(saved.labelPrinter, 'Zebra ZD220');
  assert.deepEqual(saved.labelRoll, { preset: 'custom', widthMm: 45, heightMm: 32.5, offsetXmm: 1.5, offsetYmm: 0, gapMm: 3 });
  assert.equal(saved.labelSheet.preset, '5x13');
  assert.equal(h.service.getSettings().scanSoundMuted, true);
  assert.equal(h.service.getSettings().receiptPrinter, '', 'the other printers are untouched');
  cleanup(h);
});

test('a label prints silently to the label printer at the label size (+ gap) in microns, no margins, one copy', async () => {
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', labelPrinter: 'Zebra ZD220', receiptCopies: 3 });
  const result = await h.service.printLabels({ html: HTML, paper: 'label', labelPage: { widthMm: 38, heightMm: 27 } });
  assert.deepEqual(result, { printed: true, silent: true, printer: 'Zebra ZD220' });
  const options = h.prints[0];
  assert.equal(options.silent, true);
  assert.equal(options.deviceName, 'Zebra ZD220');
  assert.deepEqual(options.pageSize, { width: microns(38), height: microns(27) });
  assert.deepEqual(options.margins, { marginType: 'none' });
  assert.equal(options.copies, 1, 'the receipt copies setting does not apply to labels');
  cleanup(h);
});

test('every label preset prints at exactly its size; a custom size is clamped', async () => {
  const h = harness();
  await h.service.setSettings({ labelPrinter: 'Zebra ZD220' });
  for (const [w, h2] of [[38, 25], [40, 30], [50, 25], [50, 30], [58, 40]]) {
    await h.service.printLabels({ html: HTML, paper: 'label', labelPage: { widthMm: w, heightMm: h2 } });
    assert.deepEqual(h.prints.at(-1).pageSize, { width: microns(w), height: microns(h2) });
  }
  await h.service.printLabels({ html: HTML, paper: 'label', labelPage: { widthMm: 5000, heightMm: -1 } });
  assert.deepEqual(h.prints.at(-1).pageSize, { width: microns(110), height: microns(15) });
  await h.service.printLabels({ html: HTML, paper: 'label', labelPage: { widthMm: 'url(x)', heightMm: {} } });
  assert.deepEqual(h.prints.at(-1).pageSize, { width: microns(38), height: microns(25) });
  cleanup(h);
});

test('with no label printer configured a label shows the system dialog (not silent, no printer chosen for it)', async () => {
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', documentPrinter: 'HP LaserJet' });
  const result = await h.service.printLabels({ html: HTML, paper: 'label', labelPage: LABEL_PAGE });
  assert.deepEqual(result, { printed: true, silent: false, printer: null });
  assert.equal(h.prints[0].silent, false);
  assert.equal('deviceName' in h.prints[0], false);
  cleanup(h);
});

test('the generic print service rejects label paper; only printLabels can reach the label printer', async () => {
  const h = harness();
  await h.service.setSettings({ labelPrinter: 'Zebra ZD220' });
  await assert.rejects(
    h.service.print({ html: HTML, paper: 'label', labelPage: LABEL_PAGE }),
    (error) => error.code === 'INVALID_INPUT'
  );
  assert.equal(h.prints.length, 0);
  await h.service.printLabels({ html: HTML, paper: 'label', labelPage: LABEL_PAGE });
  assert.equal(h.prints.length, 1);
  cleanup(h);
});

test('a label job needs its page size; unknown papers are still refused', () => {
  assert.throws(() => validateJob({ html: HTML, paper: 'label' }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateJob({ html: HTML, paper: 'label', labelPage: 'big' }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => validateJob({ html: HTML, paper: 'A3' }), (error) => error.code === 'INVALID_INPUT');
  assert.deepEqual(validateJob({ html: HTML, paper: 'label', labelPage: LABEL_PAGE }).labelPage, LABEL_PAGE);
  assert.equal(validateJob({ html: HTML, paper: 'A4', noMargins: true }).noMargins, true);
  assert.equal('noMargins' in validateJob({ html: HTML, paper: 'A5', noMargins: true }), false, 'only A4 sticker sheets are margin-free');
  assert.equal('noMargins' in validateJob({ html: HTML, paper: 'A4' }), false);
});

test('A4 sticker sheets print with no page margin on the A4 printer, preselected in the dialog (never silent); normal A4 keeps its margins', async () => {
  const h = harness();
  await h.service.setSettings({ documentPrinter: 'HP LaserJet', labelPrinter: 'Zebra ZD220' });
  const sheet = await h.service.print({ html: HTML, paper: 'A4', noMargins: true });
  assert.deepEqual(sheet, { printed: true, silent: false, printer: 'HP LaserJet' });
  assert.equal(h.prints[0].pageSize, 'A4');
  assert.deepEqual(h.prints[0].margins, { marginType: 'none' });
  assert.equal(h.prints[0].silent, false);
  assert.equal(h.prints[0].deviceName, 'HP LaserJet');
  await h.service.print({ html: HTML, paper: 'A4' });
  assert.deepEqual(h.prints[1].margins, { marginType: 'default' });
  cleanup(h);
});

test('the test label goes to the label printer (the one picked now, else the saved one) at the label size; the outline sheet to the A4 printer with no margin', async () => {
  const h = harness();
  await h.service.setSettings({ labelPrinter: 'Zebra ZD220', documentPrinter: 'HP LaserJet' });
  const label = await h.service.printTestPage({ kind: 'label', html: HTML, labelPage: { widthMm: 50, heightMm: 30 } });
  assert.deepEqual(label, { printed: true, printer: 'Zebra ZD220' });
  assert.equal(h.prints[0].silent, true);
  assert.equal(h.prints[0].deviceName, 'Zebra ZD220');
  assert.deepEqual(h.prints[0].pageSize, { width: microns(50), height: microns(30) });
  assert.deepEqual(h.prints[0].margins, { marginType: 'none' });
  // The printer picked in the dropdown right now wins; an unknown one is refused.
  await h.service.printTestPage({ kind: 'label', html: HTML, labelPage: LABEL_PAGE, printer: 'HP LaserJet' });
  assert.equal(h.prints[1].deviceName, 'HP LaserJet');
  await assert.rejects(h.service.printTestPage({ kind: 'label', html: HTML, labelPage: LABEL_PAGE, printer: 'Ghost' }), (error) => error.code === 'PRINTER_NOT_FOUND');
  await assert.rejects(h.service.printTestPage({ kind: 'label', html: HTML }), (error) => error.code === 'INVALID_INPUT');

  const outline = await h.service.printTestPage({ kind: 'sheet', html: HTML });
  assert.deepEqual(outline, { printed: true, printer: 'HP LaserJet' });
  assert.equal(h.prints.at(-1).pageSize, 'A4');
  assert.deepEqual(h.prints.at(-1).margins, { marginType: 'none' });
  assert.equal(h.prints.at(-1).deviceName, 'HP LaserJet');
  // The old kinds still work and an unknown kind is refused.
  await h.service.printTestPage({ kind: 'document', html: HTML });
  assert.deepEqual(h.prints.at(-1).margins, { marginType: 'default' });
  await assert.rejects(h.service.printTestPage({ kind: 'poster', html: HTML }), (error) => error.code === 'INVALID_INPUT');
  cleanup(h);
});

test('print:prefs-set keeps only the two whitelisted keys: it can never change a printer, the label geometry or the receipt calibration', async () => {
  assert.deepEqual([...PREF_KEYS].sort(), ['labelOptions', 'scanSoundMuted']);
  const h = harness();
  await h.service.setSettings({ receiptPrinter: 'EPSON TM-T20', labelPrinter: 'Zebra ZD220', labelRoll: { preset: '50x30' } });
  const next = h.service.setPrefs({
    scanSoundMuted: true,
    labelOptions: { target: 'sheet', shopName: false, price: 'wholesale', internalCode: true },
    labelPrinter: 'HP LaserJet', receiptPrinter: '', documentPrinter: 'HP LaserJet', labelRoll: { preset: '58x40' }, labelSheet: { preset: '5x13' }, receiptOffsetMm: 9, autoPrintReceipt: true, receiptCopies: 5,
  });
  assert.equal(next.scanSoundMuted, true);
  assert.deepEqual(next.labelOptions, { target: 'sheet', shopName: false, price: 'wholesale', internalCode: true });
  assert.equal(next.labelPrinter, 'Zebra ZD220');
  assert.equal(next.receiptPrinter, 'EPSON TM-T20');
  assert.equal(next.documentPrinter, '');
  assert.equal(next.labelRoll.preset, '50x30');
  assert.equal(next.labelSheet.preset, '3x8');
  assert.equal(next.receiptOffsetMm, 0);
  assert.equal(next.autoPrintReceipt, false);
  assert.equal(next.receiptCopies, 1);
  // Hostile values are normalised; non-objects are refused.
  assert.deepEqual(h.service.setPrefs({ labelOptions: { target: '<script>', price: 'cost' }, scanSoundMuted: 'yes' }).labelOptions, { target: 'roll', shopName: true, price: 'retail', internalCode: false });
  assert.equal(h.service.getSettings().scanSoundMuted, false);
  assert.throws(() => h.service.setPrefs(null), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => h.service.setPrefs('x'), (error) => error.code === 'INVALID_INPUT');
  cleanup(h);
});

function handlerHarness(permissions) {
  const calls = [];
  const service = new Proxy({}, { get: (_target, name) => async (...args) => { calls.push([name, ...args]); return { name }; } });
  const backend = { me: async () => ({ user: { name: 'u' }, permissions }) };
  return { calls, handlers: createPrintHandlers({ service, backend: () => backend, log: quietLog }) };
}
const TOKEN = 'valid-token-0123456789';

test('print:prefs-set needs only a session (a storekeeper or a cashier keeps their own options); settings-set and test-page still need shop.manage', async () => {
  assert.equal(IPC_RULES['print:prefs-set'], SESSION);
  assert.equal(IPC_RULES['print:settings-set'], 'shop.manage');
  assert.equal(IPC_RULES['print:test-page'], 'shop.manage');
  const storekeeper = handlerHandlerFor(['products.printLabels']);
  assert.equal((await storekeeper.handlers['print:prefs-set'](TOKEN, { scanSoundMuted: true })).ok, true);
  assert.deepEqual(storekeeper.calls[0], ['setPrefs', { scanSoundMuted: true }]);
  for (const channel of ['print:settings-set', 'print:test-page']) {
    const refused = await storekeeper.handlers[channel](TOKEN, { kind: 'label' });
    assert.deepEqual([refused.ok, refused.error.code], [false, 'FORBIDDEN'], channel);
  }
  const none = await handlerHarness([]).handlers['print:prefs-set'](undefined, { scanSoundMuted: true });
  assert.deepEqual([none.ok, none.error.code], [false, 'SESSION_EXPIRED']);
});

test('print:labels checks the session and products.printLabels before a label reaches the printer', async () => {
  assert.equal(IPC_RULES['print:labels'], PRODUCTS_PRINT_LABELS);
  const allowed = handlerHarness(['products.printLabels']);
  assert.equal((await allowed.handlers['print:labels'](TOKEN, { paper: 'label' })).ok, true);
  assert.deepEqual(allowed.calls, [['printLabels', { paper: 'label' }]]);
  const refused = handlerHarness([]);
  const result = await refused.handlers['print:labels'](TOKEN, { paper: 'label' });
  assert.deepEqual([result.ok, result.error.code], [false, 'FORBIDDEN']);
  assert.deepEqual(refused.calls, []);
});

test('print:print refuses label paper even with a valid session and never calls the print service', async () => {
  const caller = handlerHarness([]);
  const result = await caller.handlers['print:print'](TOKEN, { paper: 'label' });
  assert.deepEqual([result.ok, result.error.code], [false, 'INVALID_INPUT']);
  assert.deepEqual(caller.calls, []);
});
function handlerHandlerFor(permissions) { return handlerHarness(permissions); }

test('the preload exposes setPrefs with the token first, and the label printer is validated like the others', () => {
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  assert.ok(preload.includes("'print:prefs-set', token"));
  assert.ok(preload.includes("'print:labels', token"));
  const source = fs.readFileSync(path.join(root, 'lib', 'print-service.js'), 'utf8');
  assert.match(source, /\['receiptPrinter', 'documentPrinter', 'labelPrinter'\]/);
  assert.ok(!/javascript:\s*true/.test(source), 'the print window never enables JavaScript');
});
