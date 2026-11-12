'use strict';

// Stage 23 review: the hidden print window against the REAL Electron (no fake session). The main window's API calls must
// keep working before and after a print and after a PDF save: the print window has its own in-memory session and its
// request filter is never installed on session.defaultSession. The work happens in test/fixtures/print-session-proof.js.

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

let electronPath = null;
try {
  electronPath = require('electron');
} catch {
  electronPath = null;
}
const skip = typeof electronPath === 'string' ? false : 'electron is not installed';

test('real Electron: the app window keeps its API access before and after a print and a PDF save; the print window has its own in-memory session and refuses the network', { skip, timeout: 120000 }, () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronPath, [path.join(__dirname, 'fixtures', 'print-session-proof.js')], { encoding: 'utf8', env, timeout: 100000 });
  const match = /@@REPORT@@(.*)@@END@@/s.exec(result.stdout || '');
  assert.ok(match, `no report from electron (status ${result.status}): ${result.stderr || result.stdout}`);
  const { steps, errors } = JSON.parse(match[1]);
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(steps.pingBefore, 200, 'API call before any print');
  assert.equal(steps.print.printed, true);
  assert.equal(steps.pingAfterPrint, 200, 'API call after a print');
  assert.equal(steps.pdf.saved, true);
  assert.equal(steps.pdfStartsWithMagic, true, 'the saved file is a real PDF');
  assert.equal(steps.pingAfterPdf, 200, 'API call after a PDF save');
  assert.equal(steps.printAgain.printed, true, 'the window is reused for a later job');
  assert.equal(steps.pingAtEnd, 200);
  assert.equal(steps.printWindowCount, 1, 'one hidden print window');
  assert.equal(steps.sessionsDiffer, true, 'the print window is not on the app session');
  assert.equal(steps.printSessionPersistent, false, 'the print session is in memory only');
  assert.equal(steps.leakHits, 0, 'the document could not reach the network');
});
