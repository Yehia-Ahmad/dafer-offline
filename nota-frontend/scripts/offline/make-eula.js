#!/usr/bin/env node
// Stage 24: builds the installer's license page (installer-offline/eula.rtf) from electron-offline/eula.json, the same text the
// app shows on first run. RTF, because NSIS's license page needs it for Arabic. Run: node scripts/offline/make-eula.js
// A test fails when the committed eula.rtf is out of date with eula.json.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'electron-offline', 'eula.json');
const OUTPUT = path.join(ROOT, 'installer-offline', 'eula.rtf');

/** RTF-safe text: backslash, braces and every non-ASCII character (as \uN? with UTF-16 code units). */
function escapeRtf(text) {
  let out = '';
  for (const unit of String(text)) {
    for (let i = 0; i < unit.length; i += 1) {
      const code = unit.charCodeAt(i);
      if (code === 0x5c) out += '\\\\';
      else if (code === 0x7b) out += '\\{';
      else if (code === 0x7d) out += '\\}';
      else if (code < 0x80) out += unit[i];
      else out += `\\u${code > 32767 ? code - 65536 : code}?`;
    }
  }
  return out;
}

function buildRtf(eula) {
  const draft = eula.draft ? '\\b DRAFT - FOR REVIEW / \\u1605?\\u1587?\\u1608?\\u1583?\\u1577?\\b0\\par\\par' : '';
  const section = (block, rtl) => {
    const dir = rtl ? '\\rtlpar\\qr' : '\\ltrpar\\ql';
    const lines = [`{\\pard${dir}\\b\\fs28 ${escapeRtf(block.title)}\\b0\\fs22\\par}`];
    for (const paragraph of block.paragraphs) lines.push(`{\\pard${dir}\\sa120 ${escapeRtf(paragraph)}\\par}`);
    return lines.join('\r\n');
  };
  const contact = (text, rtl) => `{\\pard${rtl ? '\\rtlpar\\qr' : '\\ltrpar\\ql'}\\i ${escapeRtf(text)}\\i0\\par}`;
  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\fnil\\fcharset178 Segoe UI;}}',
    '\\viewkind4\\fs22',
    draft ? `{\\pard\\qc ${draft}}` : '',
    section(eula.ar, true),
    contact(eula.contact.ar, true),
    '{\\pard\\par\\par}',
    section(eula.en, false),
    contact(eula.contact.en, false),
    '}',
    '',
  ].filter((line) => line !== '').join('\r\n');
}

const eula = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const rtf = buildRtf(eula);

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, rtf, 'ascii');
  console.log(`wrote ${path.relative(ROOT, OUTPUT)} (${rtf.length} bytes, EULA v${eula.version}${eula.draft ? ', DRAFT' : ''})`);
}

module.exports = { buildRtf, escapeRtf, OUTPUT, SOURCE };
