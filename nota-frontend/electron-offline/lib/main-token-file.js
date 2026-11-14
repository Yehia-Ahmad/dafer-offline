'use strict';

// Stage 24: the main-PC token on disk, for the Stage 15 "attached" session.
//
// The process that owns the server makes the main-PC token (main.js) and writes it here right after, machine-scope DPAPI (purpose
// 'main-token', like the other secrets) in <home>\security\main-token.dpapi, and deletes the file on a clean exit. A second Windows account
// on the same PC that attaches to the running server reads it, so its own windows count as the main PC (not as a client). A stale file left
// by a crash is overwritten at the next start. The token is never logged.
//
// Trust level: the file is readable by any account on this PC (machine-scope DPAPI), the same as the database credentials. The token
// separates "a window of Nota on this PC" from "something relayed from the LAN"; it is not a defence against a local account.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILE_NAME = 'main-token.dpapi';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const fileOf = (securityDir) => path.join(securityDir, FILE_NAME);

// The Windows whoami by full path (a Git-for-Windows shell puts its own whoami first on PATH, which does not know /user).
const WHOAMI = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'whoami.exe');

// The SID of the account running this process (the owner of the server), e.g. S-1-5-21-...-1001.
function currentUserSid() {
  const result = spawnSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
  const match = /"(S-1-[0-9-]+)"\s*$/.exec((result.stdout || '').trim());
  if (result.status !== 0 || !match) throw new Error('could not read the account SID');
  return match[1];
}

/**
 * Windows: writable only by the owning account and SYSTEM, read-only for BUILTIN\Users, no inherited rights (the same approach as the
 * keyFile in lib/db-auth.js, but Users get read only and the owner gets full control so it can replace the file at its next start).
 * Elsewhere (development): owner only. Returns { restricted: boolean, error? }; a failure is reported by the caller, never thrown.
 */
function restrictMainTokenFile(file, { platform = process.platform, run = spawnSync, sid = currentUserSid } = {}) {
  try {
    if (platform === 'win32') {
      const result = run('icacls', [file, '/inheritance:r', '/grant:r', '*S-1-5-32-545:(R)', '/grant:r', '*S-1-5-18:(F)', '/grant:r', `*${sid()}:(F)`], { windowsHide: true, encoding: 'utf8' });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || '').trim() || 'icacls failed');
    } else {
      fs.chmodSync(file, 0o600);
    }
    return { restricted: true };
  } catch (error) {
    return { restricted: false, error: error.message };
  }
}

/**
 * Writes (or overwrites) the file. `protect(text)` is the machine-scope DPAPI call. The permissions are set on the temp file BEFORE it
 * is renamed into place, so the file is never there with loose rights. A stale file of a crashed run (maybe another account's) is removed
 * first. Returns { restricted, error? } from restrictMainTokenFile.
 */
function writeMainToken(securityDir, token, protect, options) {
  if (!TOKEN_PATTERN.test(String(token))) throw new Error('the main-PC token is malformed');
  fs.mkdirSync(securityDir, { recursive: true });
  const target = fileOf(securityDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, protect(token), 'utf8');
  const outcome = restrictMainTokenFile(temp, options);
  try { fs.rmSync(target, { force: true }); } catch { /* replaced by the rename below, or reported by it */ }
  fs.renameSync(temp, target);
  return outcome;
}

/** The token, or null when the file is missing or cannot be read (never throws, never logs the value). */
function readMainToken(securityDir, unprotect) {
  try {
    const token = unprotect(fs.readFileSync(fileOf(securityDir), 'utf8').trim());
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

function removeMainToken(securityDir) {
  try { fs.rmSync(fileOf(securityDir), { force: true }); } catch { /* best effort */ }
}

module.exports = { restrictMainTokenFile, FILE_NAME, writeMainToken, readMainToken, removeMainToken };
