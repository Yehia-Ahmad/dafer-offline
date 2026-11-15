'use strict';

// Stage 25, step E: the receipt printer calibration settings kept by the desktop app (print-settings.json): width 72 / 76 / 80 and the offset.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeSettings, createPrintService } = require('../lib/print-service');

test('defaults: an older settings file (no width or offset) becomes 80 mm and no shift', () => {
  const settings = normalizeSettings({ schemaVersion: 1, receiptPrinter: 'EPSON', documentPrinter: '', autoPrintReceipt: true, receiptCopies: 2 });
  assert.equal(settings.receiptWidthMm, 80);
  assert.equal(settings.receiptOffsetMm, 0);
  assert.equal(settings.receiptCopies, 2);
  assert.equal(normalizeSettings(null).receiptWidthMm, 80);
});

test('only 72, 76 and 80 are accepted as the width; anything else is 80', () => {
  for (const [input, expected] of [[72, 72], [76, 76], [80, 80], ['72', 72], [58, 80], [0, 80], [-76, 80], [NaN, 80], [null, 80], [undefined, 80], ['wide', 80], [76.5, 80], [{}, 80]]) {
    assert.equal(normalizeSettings({ receiptWidthMm: input }).receiptWidthMm, expected, String(input));
  }
});

test('the offset is -10..10 in half-millimetre steps; garbage is 0', () => {
  for (const [input, expected] of [[0, 0], [1.5, 1.5], [2.26, 2.5], [2.24, 2], [-3.7, -3.5], [10, 10], [99, 10], [-99, -10], [NaN, 0], [Infinity, 0], ['5', 0], [null, 0], [undefined, 0], ['x', 0], [{}, 0]]) {
    assert.equal(normalizeSettings({ receiptOffsetMm: input }).receiptOffsetMm, expected, String(input));
  }
});

test('saving through the service stores the calibration and reading it back gives the same values; a bad patch keeps the old valid ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-printset-'));
  try {
    const service = createPrintService({
      BrowserWindow: class {}, dialog: {}, getMainWindow: () => null, settingsPath: path.join(dir, 'print-settings.json'),
      log: { info() {}, warn() {}, error() {} },
    });
    assert.equal(service.getSettings().receiptWidthMm, 80);
    const saved = await service.setSettings({ receiptWidthMm: 72, receiptOffsetMm: -2 });
    assert.equal(saved.receiptWidthMm, 72);
    assert.equal(saved.receiptOffsetMm, -2);
    assert.deepEqual({ w: service.getSettings().receiptWidthMm, o: service.getSettings().receiptOffsetMm }, { w: 72, o: -2 });
    const next = await service.setSettings({ receiptWidthMm: 66, receiptOffsetMm: 'left' });
    assert.equal(next.receiptWidthMm, 80, 'an invalid width falls back to 80');
    assert.equal(next.receiptOffsetMm, 0);
    fs.writeFileSync(path.join(dir, 'print-settings.json'), '{"receiptWidthMm": 12, "receiptOffsetMm": 400');
    assert.equal(service.getSettings().receiptWidthMm, 80, 'a damaged file means the defaults');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
