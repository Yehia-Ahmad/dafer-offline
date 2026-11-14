'use strict';

// Run by test/stage24-protection.test.js under the REAL Electron: with the production settings (devTools: false + lib/hardening),
// DevTools cannot be opened by code, and the blocked shortcuts are prevented. Prints a JSON report between @@REPORT@@ and @@END@@.
const { BrowserWindow, app } = require('electron');
const { devToolsAllowed, hardenContents } = require('../../lib/hardening');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const report = { errors: [] };

  const locked = new BrowserWindow({ show: false, webPreferences: { devTools: devToolsAllowed(true), sandbox: true } });
  hardenContents(locked.webContents, { isPackaged: true });
  await locked.loadURL('data:text/html,<body>production</body>');
  locked.webContents.openDevTools();
  await sleep(800);
  report.productionDevToolsOpened = locked.webContents.isDevToolsOpened();

  // Keys, through the real event path where Electron allows it.
  const seen = {};
  locked.webContents.on('before-input-event', (event, input) => { seen[`${input.control ? 'C+' : ''}${input.shift ? 'S+' : ''}${input.key}`] = event.defaultPrevented; });
  for (const key of ['F12', 'F5']) locked.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
  locked.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] });
  locked.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
  locked.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' }); // a normal key must NOT be blocked
  await sleep(500);
  report.seen = seen;

  // The context menu: suppressed.
  let menuEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  locked.webContents.emit('context-menu', menuEvent, {});
  report.contextMenuPrevented = menuEvent.prevented;

  // Development keeps DevTools (not packaged).
  const dev = new BrowserWindow({ show: false, webPreferences: { devTools: devToolsAllowed(false), sandbox: true } });
  hardenContents(dev.webContents, { isPackaged: false });
  await dev.loadURL('data:text/html,<body>development</body>');
  dev.webContents.openDevTools({ mode: 'detach' });
  await sleep(1500);
  report.developmentDevToolsOpened = dev.webContents.isDevToolsOpened();
  return report;
}

main()
  .catch((error) => ({ errors: [String(error && error.stack ? error.stack : error)] }))
  .then((report) => {
    process.stdout.write(`@@REPORT@@${JSON.stringify(report)}@@END@@\n`);
    app.exit(0);
  });
