'use strict';

// Run by test/stage24-protection.test.js under the REAL Electron. It does what main.js does in an installed build, on its first line:
// if a debugging switch is on the command line, exit at once (before the app is ready). With NOTA_PROOF_GUARD=0 the guard is off
// (the control run: proves Chromium really opens the port for that spelling, so "never opens" means something).
const { app } = require('electron');
const { hasDebugSwitch } = require('../../lib/hardening');

if (process.env.NOTA_PROOF_GUARD !== '0' && hasDebugSwitch(process.argv, app.commandLine)) app.exit(1);

app.whenReady().then(() => {
  // Stay up long enough for the test to look for the port.
  setTimeout(() => app.exit(0), 3000);
});
