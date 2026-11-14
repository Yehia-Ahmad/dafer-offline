'use strict';

// Stage 24: the license agreement (EULA) is accepted once on first run and the acceptance is stored with its date.
// The text is eula.json (Arabic + English, marked DRAFT until the vendor approves the wording); the installer's license page is
// built from the same file (scripts/offline/make-eula.js). A newer EULA version asks again.

const fs = require('node:fs');
const path = require('node:path');
const EULA = require('../eula.json');

/** { accepted, acceptedAt } for the acceptance file (<home>/eula.json). */
function eulaStatus(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const accepted = record && record.version === EULA.version && typeof record.acceptedAt === 'string' && !Number.isNaN(Date.parse(record.acceptedAt));
    return { accepted: Boolean(accepted), acceptedAt: accepted ? record.acceptedAt : null };
  } catch {
    return { accepted: false, acceptedAt: null };
  }
}

/** Stores the acceptance (version + date). */
function recordAcceptance(file, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: EULA.version, acceptedAt: now.toISOString() })}\n`);
  fs.renameSync(temp, file);
  return { accepted: true, acceptedAt: now.toISOString() };
}

module.exports = { EULA, eulaStatus, recordAcceptance };
