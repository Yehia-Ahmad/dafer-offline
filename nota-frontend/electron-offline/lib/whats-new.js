'use strict';

// Stage 25: "what's new" after an upgrade. CHANGELOG.md (nota-frontend/CHANGELOG.md, staged next to the app's package.json) has one section per
// version, each with an Arabic and an English list:
//
//   ## 1.1.0 - 2026-12-01
//   ### ar
//   - ...
//   ### en
//   - ...
//
// The dialog shows once per version per PC: whats-new.json in the Nota home folder remembers the last version this PC was told about.

const fs = require('node:fs');

function parseChangelog(text) {
  const entries = [];
  let entry = null;
  let lang = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^##\s+v?(\d+\.\d+\.\d+[0-9A-Za-z.\-+]*)\s*(?:[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);
    if (heading) {
      entry = { version: heading[1], date: heading[2] || null, ar: [], en: [] };
      entries.push(entry);
      lang = null;
      continue;
    }
    if (!entry) continue;
    const section = /^###\s+(ar|en)\s*$/i.exec(line);
    if (section) { lang = section[1].toLowerCase(); continue; }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item && lang) entry[lang].push(item[1].trim());
  }
  return entries;
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** -1, 0 or 1 comparing plain x.y.z versions (anything else compares as 0.0.0). */
function compareVersions(a, b) {
  const parts = (value) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(value)) || [0, 0, 0, 0]).slice(1, 4).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** @returns {{version:string,date:string|null,ar:string[],en:string[]}|null} the entry to show now (an upgrade from an older recorded version), or null */
function pendingWhatsNew({ changelogFile, stateFile, version }) {
  const seen = readJson(stateFile);
  // First run on this PC (a brand-new install, or the first start of a build that tracks this): record the version silently, show nothing.
  // The window is for an UPGRADE from an older recorded version only.
  if (!seen || typeof seen.lastSeenVersion !== 'string') {
    try { markWhatsNewSeen({ stateFile, version }); } catch { /* a read-only home: nothing is shown either way */ }
    return null;
  }
  if (compareVersions(seen.lastSeenVersion, version) >= 0) return null; // already seen, or an older build opened on this PC
  let text = '';
  try { text = fs.readFileSync(changelogFile, 'utf8'); } catch { return null; }
  const entry = parseChangelog(text).find((candidate) => candidate.version === version);
  return entry && (entry.ar.length || entry.en.length) ? entry : null;
}

/** First run on this PC: records the version silently (so a brand-new install never shows the window for the version it was installed with). */
function ensureWhatsNewRecord({ stateFile, version }) {
  if (readJson(stateFile)) return false;
  try { markWhatsNewSeen({ stateFile, version }); return true; } catch { return false; }
}

/** This version's entry whether or not it was shown before (the About page). */
function currentWhatsNew({ changelogFile, version }) {
  try {
    return parseChangelog(fs.readFileSync(changelogFile, 'utf8')).find((candidate) => candidate.version === version) || null;
  } catch { return null; }
}

function markWhatsNewSeen({ stateFile, version }) {
  fs.mkdirSync(require('node:path').dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ lastSeenVersion: version, at: new Date().toISOString() }, null, 2)}\n`);
}

module.exports = { ensureWhatsNewRecord, parseChangelog, pendingWhatsNew, currentWhatsNew, markWhatsNewSeen };
