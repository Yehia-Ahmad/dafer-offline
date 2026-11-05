// Stage 15: audit entries written by the desktop app while the backend was stopped.
//
// Backups and restores run with the backend stopped (electron-offline: supervisor.runMaintenance),
// and a restore replaces the users, so the desktop app cannot call an endpoint at that moment.
// Instead it appends one JSON line per action to a file (NOTA_AUDIT_INBOX); the backend moves them
// into AuditLog when it starts again, then deletes the file. Only known actions are accepted, and
// only the file's base name is kept (never a folder path).
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const AuditLog = require("../models/auditLog.model");
const { safeDetails } = require("./audit");

const INBOX_ACTIONS = new Set(["backup.created", "backup.restored", "backup.restore_failed"]);
const MAX_LINES = 500;

const toEntry = (line) => {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !INBOX_ACTIONS.has(raw.action)) return null;
  const at = new Date(raw.at);
  return {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    userId: typeof raw.userId === "string" && mongoose.Types.ObjectId.isValid(raw.userId) ? raw.userId : undefined,
    userName: typeof raw.userName === "string" ? raw.userName.slice(0, 100) : undefined,
    action: raw.action,
    entity: "Backup",
    details: safeDetails({
      file: typeof raw.file === "string" ? path.basename(raw.file.replace(/\\/g, "/")) : undefined,
      error: typeof raw.error === "string" ? raw.error : undefined,
      code: typeof raw.code === "string" ? raw.code : undefined,
    }),
  };
};

/** Moves the inbox lines into AuditLog and deletes the file. Returns the number of entries saved. */
async function drainAuditInbox(file) {
  if (!file) return 0;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`audit inbox unreadable: ${error.message}`);
    return 0;
  }
  const entries = text.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES).map(toEntry).filter(Boolean);
  if (entries.length) await AuditLog.insertMany(entries);
  fs.rmSync(file, { force: true });
  return entries.length;
}

module.exports = { INBOX_ACTIONS, drainAuditInbox };
