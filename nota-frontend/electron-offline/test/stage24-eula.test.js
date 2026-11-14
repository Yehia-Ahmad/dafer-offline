'use strict';

// Stage 24: the license agreement (EULA): accepted once on first run and stored with the date; the installer's license page is built
// from the same text. The wording is a DRAFT until the vendor approves it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EULA, eulaStatus, recordAcceptance } = require('../lib/eula');
const { buildRtf, OUTPUT } = require('../../scripts/offline/make-eula');
const { layout } = require('../lib/paths');

const FRONTEND = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nota-eula-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('first run: not accepted; accepting stores the version and the date; later runs are not asked again', () => {
  const file = path.join(tmp, 'home', 'eula.json');
  assert.deepEqual(eulaStatus(file), { accepted: false, acceptedAt: null });
  const when = new Date('2026-11-14T10:20:30.000Z');
  assert.deepEqual(recordAcceptance(file, when), { accepted: true, acceptedAt: '2026-11-14T10:20:30.000Z' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: EULA.version, acceptedAt: '2026-11-14T10:20:30.000Z' });
  assert.deepEqual(eulaStatus(file), { accepted: true, acceptedAt: '2026-11-14T10:20:30.000Z' });
});

test('a damaged record, an older EULA version or a record without a date asks again', () => {
  const file = path.join(tmp, 'bad', 'eula.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const content of ['not json', '{}', JSON.stringify({ version: EULA.version + 1, acceptedAt: '2026-01-01T00:00:00Z' }), JSON.stringify({ version: EULA.version }), JSON.stringify({ version: EULA.version, acceptedAt: 'yesterday' })]) {
    fs.writeFileSync(file, content);
    assert.equal(eulaStatus(file).accepted, false, content);
  }
});

test('the text: Arabic and English, same number of clauses, DRAFT flag, a vendor contact line, and every point the brief lists', () => {
  assert.equal(EULA.draft, true, 'marked as a draft until the vendor reviews the wording');
  assert.equal(EULA.ar.paragraphs.length, EULA.en.paragraphs.length);
  assert.ok(EULA.contact.ar && EULA.contact.en);
  const en = EULA.en.paragraphs.join(' ').toLowerCase();
  for (const phrase of ['one shop', 'main pc', 'copy', 'sell', 'reverse', 'data', 'warranty', 'license']) assert.ok(en.includes(phrase), phrase);
  assert.ok(/belongs to the shop/.test(en), 'the data belongs to the shop');
  assert.ok(/as is/.test(en) && /law/.test(en), 'no warranty beyond what the law requires');
  const ar = EULA.ar.paragraphs.join(' ');
  for (const phrase of ['محل واحد', 'الجهاز الرئيسي', 'ممنوع', 'الهندسة العكسية', 'ملك المحل', 'ضمان']) assert.ok(ar.includes(phrase), phrase);
});

test('the installer license page (installer-offline/eula.rtf) is built from the same text and is configured in the NSIS options', () => {
  assert.equal(fs.readFileSync(OUTPUT, 'ascii'), buildRtf(EULA), 'eula.rtf is out of date: run node scripts/offline/make-eula.js');
  const rtf = fs.readFileSync(OUTPUT);
  assert.ok(rtf.every((byte) => byte < 0x80), 'pure ASCII (Arabic is \\u escapes)');
  assert.match(rtf.toString('ascii'), /^\{\\rtf1/);
  assert.ok(rtf.toString('ascii').includes('\\rtlpar'), 'the Arabic part is right-to-left');
  const config = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'electron-builder.offline.json'), 'utf8'));
  assert.equal(config.nsis.license, 'installer-offline/eula.rtf');
  assert.ok(fs.existsSync(path.join(FRONTEND, config.nsis.license)));
});

test('the home layout keeps the acceptance next to config.json', () => {
  assert.equal(layout(path.join('C:', 'ProgramData', 'Nota')).eula, path.join('C:', 'ProgramData', 'Nota', 'eula.json'));
});

test('the page: strict CSP, no inline script, both languages, an agree and a decline button; main.js asks before activation and only while the page shows', () => {
  const pages = path.join(__dirname, '..', 'pages');
  const html = fs.readFileSync(path.join(pages, 'eula.html'), 'utf8');
  assert.match(html, /script-src 'self'/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\sonclick=|\sstyle=/.test(html));
  assert.ok(/id="accept"/.test(html) && /id="decline"/.test(html) && /id="lang"/.test(html));
  const js = fs.readFileSync(path.join(pages, 'eula.js'), 'utf8');
  assert.ok(js.includes("accept: 'أوافق'") && js.includes("accept: 'I agree'"));

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.slice(main.indexOf('async function start()'));
  assert.ok(start.indexOf('eulaStatus(state.paths.eula)') > start.indexOf('checkInstallation()'), 'after the installation check');
  assert.ok(start.indexOf('eulaStatus(state.paths.eula)') < start.indexOf('async function continueStart()'), 'before the first-run flow');
  const cont = main.slice(main.indexOf('async function continueStart()'));
  assert.ok(cont.indexOf('showActivation') > -1 && cont.indexOf('beginRole(config)') > -1, 'activation and the roles run only after the agreement');
  for (const channel of ['text', 'accept', 'decline']) assert.ok(main.includes(`'eula:${channel}'`), channel);
  assert.ok((main.match(/state\.mode === 'eula'|state\.mode !== 'eula'/g) || []).length >= 3, 'answers only while the page shows');
  assert.match(main, /recordAcceptance\(state\.paths\.eula\)/);
});
