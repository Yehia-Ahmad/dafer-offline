'use strict';

// Run by test/stage23-electron.test.js under the REAL Electron (not Node): the proof that the hidden print window
// has its own session and never disturbs the app's. It prints a JSON report on stdout.
//
//   * a local HTTP server plays the backend (/api/ping) and also counts hits on /leak.png;
//   * the main window (default session) loads a page from that server and calls /api/ping with fetch();
//   * the real createPrintService runs a print and a PDF save in its real hidden window
//     (only the physical printer is stubbed: webContents.print answers success, there is no printer in CI);
//   * /api/ping from the main window must answer 200 before, after the print and after the PDF save;
//   * the document tries to load /leak.png from the network: the print window's request filter must refuse it.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { BrowserWindow, app, session } = require('electron');
const { createPrintService } = require('../../lib/print-service');

const created = [];
const report = { steps: {}, errors: [] };
let leakHits = 0;
let pingHits = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/api/ping') { pingHits += 1; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.url.startsWith('/leak.png')) { leakHits += 1; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.alloc(0)); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body>main</body></html>');
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  const mainWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await mainWindow.loadURL(`${base}/`);
  const ping = async () => mainWindow.webContents.executeJavaScript("fetch('/api/ping').then((r) => r.status).catch((e) => 'ERR ' + e.message)");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-print-electron-'));
  const pdfTarget = path.join(dir, 'out.pdf');
  class ProofWindow extends BrowserWindow {
    constructor(options) {
      super(options);
      created.push(this);
      this.webContents.print = (_options, callback) => callback(true, ''); // no physical printer in CI
    }
  }
  const service = createPrintService({
    BrowserWindow: ProofWindow,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: pdfTarget }) },
    getMainWindow: () => mainWindow,
    settingsPath: path.join(dir, 'print-settings.json'),
    tempDir: dir,
    log: { info() {}, warn(m) { report.errors.push(`warn: ${m}`); }, error(m) { report.errors.push(`error: ${m}`); } },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4}</style></head><body><p>مرحبا</p><img src="${base}/leak.png?x=1"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>`;

  report.steps.pingBefore = await ping();
  report.steps.print = await service.print({ html, paper: 'A4' });
  report.steps.pingAfterPrint = await ping();
  report.steps.pdf = await service.savePdf({ html, paper: 'A4', title: 'proof' });
  report.steps.pingAfterPdf = await ping();
  report.steps.pdfStartsWithMagic = fs.existsSync(pdfTarget) && fs.readFileSync(pdfTarget).subarray(0, 4).toString() === '%PDF';
  // a second print after the PDF: the window is reused and still works
  report.steps.printAgain = await service.print({ html, paper: 'A4' });
  report.steps.pingAtEnd = await ping();

  const printWindows = created.filter((win) => !win.isDestroyed());
  report.steps.printWindowCount = printWindows.length;
  const printSession = printWindows[0] && printWindows[0].webContents.session;
  report.steps.sessionsDiffer = Boolean(printSession) && printSession !== mainWindow.webContents.session && printSession !== session.defaultSession;
  report.steps.printSessionPersistent = printSession ? printSession.isPersistent() : null;
  report.steps.leakHits = leakHits;
  report.steps.pingHits = pingHits;
  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(
  () => { process.stdout.write(`\n@@REPORT@@${JSON.stringify(report)}@@END@@\n`); app.exit(0); },
  (error) => { report.errors.push(String(error && error.stack || error)); process.stdout.write(`\n@@REPORT@@${JSON.stringify(report)}@@END@@\n`); app.exit(1); },
);
