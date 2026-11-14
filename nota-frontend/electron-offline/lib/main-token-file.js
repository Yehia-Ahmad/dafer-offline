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

const FILE_NAME = 'main-token.dpapi';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const fileOf = (securityDir) => path.join(securityDir, FILE_NAME);

/** Writes (or overwrites) the file. `protect(text)` is the machine-scope DPAPI call. */
function writeMainToken(securityDir, token, protect) {
  if (!TOKEN_PATTERN.test(String(token))) throw new Error('the main-PC token is malformed');
  fs.mkdirSync(securityDir, { recursive: true });
  const target = fileOf(securityDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, protect(token), 'utf8');
  fs.renameSync(temp, target);
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

module.exports = { FILE_NAME, writeMainToken, readMainToken, removeMainToken };
