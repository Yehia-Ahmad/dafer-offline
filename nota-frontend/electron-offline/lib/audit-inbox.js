'use strict';

// Stage 15: audit entries for backups and restores, handed to the backend through a file.
//
// The backend is stopped while a backup or restore runs (supervisor.runMaintenance), so the main
// process cannot call it then. It appends one JSON line per action to run/audit-inbox.jsonl; the
// backend moves the lines into its audit log when it starts again (NOTA_AUDIT_INBOX,
// nota-backend/src/auth/auditInbox.js) and deletes the file. Only the file's base name is written.

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_INBOX_NAME = 'audit-inbox.jsonl';

function appendAuditEntry(file, { action, user, backupFile, code, error, now = new Date() }) {
  const entry = {
    action,
    at: now.toISOString(),
    userId: user && user._id ? String(user._id) : undefined,
    userName: user && user.name ? String(user.name) : undefined,
    file: backupFile ? path.basename(String(backupFile)) : undefined,
    code: code || undefined,
    error: error ? String(error).slice(0, 200) : undefined,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

module.exports = { AUDIT_INBOX_NAME, appendAuditEntry };
