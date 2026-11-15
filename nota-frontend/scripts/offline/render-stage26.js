#!/usr/bin/env node
// Development tool (not shipped): renders the Stage 26 label review PNGs into ../nota-review/stage-26/ and DECODES every barcode
// in them with @zxing/library (a dev dependency, used only here) running inside headless Chrome, so "the barcodes scan" is proved from
// the rendered pixels and not assumed.
//
//   node scripts/offline/render-stage26.js
//
// It bundles the real label code with esbuild (no Angular), builds the documents exactly as the app does, loads each in headless Chrome
// over the DevTools protocol (port 9336; never 27017/27217), screenshots at a high device scale, and decodes the label (or every cell of
// a sheet). Writes decode-report.txt next to the PNGs. Starts nothing else, touches no database, and removes its Chrome and temp files.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(ROOT, '..', 'nota-review', 'stage-26');
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9336;
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const ZXING = fs.readFileSync(path.join(ROOT, 'node_modules', '@zxing', 'library', 'umd', 'index.min.js'), 'utf8');
const ZXING_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@zxing', 'library', 'package.json'), 'utf8')).version;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const px = (mm) => Math.ceil((mm * 96) / 25.4);
const log = (message) => console.log(`[stage26] ${message}`);

let temp = '';
let chromeProcess = null;
const killChrome = () => {
  if (!chromeProcess || chromeProcess.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(chromeProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  else chromeProcess.kill('SIGKILL');
};
process.on('exit', killChrome);

const isPortOpen = (port) => new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', (data) => { const message = JSON.parse(String(data)); const waiting = message.id && this.pending.get(message.id); if (waiting) { this.pending.delete(message.id); if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result); } });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}

async function openPage() {
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  return cdp;
}

// The decoder page: zxing + a function that decodes a rectangle of a PNG.
const DECODER = `${ZXING}
window.decodeCrop = async (dataUrl, x, y, w, h) => {
  const image = new Image(); image.src = dataUrl; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.fillStyle = '#fff'; context.fillRect(0, 0, w, h); context.drawImage(image, x, y, w, h, 0, 0, w, h);
  const hints = new Map([[ZXing.DecodeHintType.TRY_HARDER, true], [ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.CODE_128]]]);
  const reader = new ZXing.MultiFormatReader(); reader.setHints(hints);
  try { const result = reader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)))); return { text: result.getText(), format: ZXing.BarcodeFormat[result.getBarcodeFormat()] }; }
  catch (error) { return { error: String(error && error.message || error) }; }
};
true;`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-stage26-'));
  // 1. the real label code, bundled for Node
  const bundle = path.join(temp, 'labels.cjs');
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'render-stage26.entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const L = require(bundle);

  const ctx = (lang) => ({ lang, shop: { name: lang === 'ar' ? 'النور للأدوات الكهربائية' : 'Al Nour Electrical', address: '', phones: [], logo: '', taxNumber: '', commercialRegister: '', invoiceFooter: '' }, printedBy: 'Stage 26', printedAt: new Date(2026, 10, 15, 12, 0), fontCss: '', copy: null });
  const item = (extra) => ({ name: 'لمبة LED ٩ وات', code: 'LED-9', barcode: '4006381333931', retailPrice: 45, wholesalePrice: 35, priceAfterDiscount: 40.5, vatExempt: false, ...extra });
  const A = item({});
  const B = item({ name: 'LED bulb 9W warm white', barcode: 'SKU-LED-9-WHT', code: 'LED-9W' });
  const LONG_AR = item({ name: 'كابل كهرباء نحاس خالص مقاس ٣ في ٢٫٥ ملم عزل مزدوج مقاوم للحرارة والرطوبة لفة ١٠٠ متر', code: 'CB-325', barcode: '2000000000015' });
  const LONG_CODE128 = item({ name: 'كابل كهرباء نحاس خالص مقاس ٣ في ٢٫٥ ملم عزل مزدوج مقاوم للحرارة والرطوبة', code: 'CB-325', barcode: 'CABLE-325-100M' });
  const EAN8 = item({ name: 'شاحن', code: 'CH-1', barcode: '96385074' });
  const UPCA = item({ name: 'USB charger', code: 'CH-2', barcode: '036000291452' });
  const options = { ...L.DEFAULT_LABEL_OPTIONS, internalCode: true };
  const vat = { enabled: true, rate: 14, pricesIncludeVat: true };

  // 2. the cases: [file, document, language, expected barcode texts per decode region]
  const cases = [];
  const roll = (file, preset, lang, product, extra = {}) => cases.push({ file, lang, kind: 'roll', preset, product, doc: L.productLabelRoll(ctx(lang), [{ item: product, copies: 1 }], { roll: L.normalizeRoll({ preset, ...extra }), options, vat }) });
  roll('01-roll-38x25-ar-ean13.png', '38x25', 'ar', A);
  roll('02-roll-38x25-en-ean13.png', '38x25', 'en', { ...A, name: 'LED bulb 9W', code: 'LED-9' });
  roll('03-roll-38x25-ar-code128-longname.png', '38x25', 'ar', LONG_CODE128);
  roll('04-roll-38x25-ar-ean13-longname.png', '38x25', 'ar', LONG_AR);
  roll('05-roll-50x30-ar-ean13.png', '50x30', 'ar', A);
  roll('06-roll-50x30-en-code128.png', '50x30', 'en', B);
  roll('07-roll-50x30-ar-longname-ean13.png', '50x30', 'ar', LONG_AR);
  roll('08-roll-50x30-en-ean8-upca.png', '50x30', 'en', EAN8);

  const sheetItems = [A, EAN8, UPCA, B, LONG_AR, LONG_CODE128];
  const sheet = (file, preset, lang, copies, startAt, outline) => {
    const layout = L.normalizeSheet({ preset });
    const entries = Array.from({ length: copies }, (_, index) => ({ item: sheetItems[index % sheetItems.length], copies: 1 }));
    cases.push({ file, lang, kind: 'sheet', layout, startAt, outline, entries, doc: L.productLabelSheet(ctx(lang), entries, { sheet: layout, options: { ...options, target: 'sheet' }, startAt, vat, outline }) });
  };
  sheet('10-sheet-3x8-start-at-5-ar.png', '3x8', 'ar', 20, 5, false);
  sheet('11-sheet-5x13-en.png', '5x13', 'en', 65, 1, false);
  sheet('12-outline-test-sheet-3x8.png', '3x8', 'ar', 0, 1, true);

  // 3. Chrome
  chromeProcess = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(temp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await isPortOpen(CDP_PORT)); i += 1) await sleep(200);
  const page = await openPage();
  const decoder = await openPage();
  await decoder.eval(DECODER);

  const report = [`Stage 26 label review: barcodes decoded from the rendered pixels with @zxing/library ${ZXING_VERSION} (dev dependency, this tool only)`, ''];
  let failures = 0;
  for (const entry of cases) {
    const html = L.buildPrintHtml(ctx(entry.lang), entry.doc);
    const htmlFile = path.join(temp, `${entry.file}.html`);
    fs.writeFileSync(htmlFile, html, 'utf8');
    const scale = entry.kind === 'sheet' ? 3 : 8;
    const size = entry.kind === 'sheet' ? { w: 210, h: 297 } : { w: entry.doc.labelPage.widthMm, h: entry.doc.labelPage.heightMm };
    const width = px(size.w); const height = px(size.h);
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await page.send('Page.navigate', { url: `file:///${htmlFile.replace(/\\/g, '/')}` });
    await sleep(500);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
    fs.writeFileSync(path.join(OUT, entry.file), Buffer.from(data, 'base64'));
    const dataUrl = `data:image/png;base64,${data}`;
    const decodeRegion = (x, y, w, h) => decoder.eval(`decodeCrop(${JSON.stringify(dataUrl)}, ${Math.floor(x)}, ${Math.floor(y)}, ${Math.ceil(w)}, ${Math.ceil(h)})`);

    if (entry.kind === 'roll') {
      const result = await decodeRegion(0, 0, width * scale, height * scale);
      const expected = entry.product.barcode;
      const pass = result.text === expected;
      if (!pass) failures += 1;
      const symbology = L.chooseSymbology(expected);
      const sizing = L.barcodeSizing(expected, entry.doc.labelPage.widthMm - 2, 'roll');
      report.push(`${entry.file}: expected ${expected} (${symbology}) → ${pass ? 'DECODED' : 'FAILED'} ${result.text || result.error} [${result.format || '-'}], module ${sizing.moduleMm} mm (${sizing.moduleMm / 0.125} dots), bars ${sizing.widthMm} mm incl. quiet zones${sizing.tooSmall ? ', TOO SMALL' : ''}`);
    } else if (entry.outline) {
      report.push(`${entry.file}: outline test sheet, ${L.normalizeSheet({ preset: '3x8' }).columns * 8} label borders, no barcodes (alignment check on plain paper)`);
    } else {
      let ok = 0; const bad = [];
      for (let index = 0; index < entry.entries.length; index += 1) {
        const cell = L.sheetCell(entry.layout, entry.startAt - 1 + index);
        if (entry.startAt - 1 + index >= entry.layout.columns * entry.layout.rows) break; // the next sheet
        const x = (cell.xMm * 96 / 25.4) * scale; const y = (cell.yMm * 96 / 25.4) * scale;
        const w = (entry.layout.labelWidthMm * 96 / 25.4) * scale; const h = (entry.layout.labelHeightMm * 96 / 25.4) * scale;
        const result = await decodeRegion(x, y, w, h);
        const expected = entry.entries[index].item.barcode;
        if (result.text === expected) ok += 1; else bad.push(`#${entry.startAt + index} ${expected} → ${result.text || result.error}`);
      }
      if (bad.length) failures += bad.length;
      const symbologies = [...new Set(entry.entries.map((one) => L.chooseSymbology(one.item.barcode)))].join(', ');
      report.push(`${entry.file}: ${entry.layout.columns}×${entry.layout.rows} sheet, labels from #${entry.startAt}, ${ok} of ${ok + bad.length} labels on this sheet decoded (${symbologies})${bad.length ? `; FAILED: ${bad.join('; ')}` : ''}`);
    }
    log(report[report.length - 1]);
  }
  report.push('', failures ? `${failures} barcode(s) did NOT decode` : 'every barcode decoded');
  fs.writeFileSync(path.join(OUT, 'decode-report.txt'), `${report.join('\n')}\n`, 'utf8');
  return failures;
}


/** Chrome keeps files open for a moment after it is killed: wait and retry; a leftover temp folder never changes the result. */
async function cleanTemp() {
  killChrome();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(500);
    try { fs.rmSync(temp, { recursive: true, force: true }); return; } catch { /* still open: try again */ }
  }
  log(`could not remove ${temp} (the OS temp folder will clear it)`);
}

main().then(
  async (failures) => { await cleanTemp(); process.exit(failures ? 1 : 0); },
  async (error) => { console.error(error); await cleanTemp(); process.exit(1); }
);
