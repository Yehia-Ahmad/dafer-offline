'use strict';

// Small file logger with size-based rotation (file.log, file.log.1, file.log.2 ...).

const fs = require('node:fs');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

function rotateIfLarge(file, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  for (let index = keep - 1; index >= 1; index--) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    try {
      fs.renameSync(from, `${file}.${index}`);
    } catch {
      // A missing older file is fine.
    }
  }
}

function createLogger(file, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, echo = false } = {}) {
  let written = 0;
  rotateIfLarge(file, { maxBytes, keep });

  const append = (text) => {
    try {
      fs.appendFileSync(file, text);
      written += text.length;
      if (written > maxBytes / 10) {
        written = 0;
        rotateIfLarge(file, { maxBytes, keep });
      }
    } catch {
      // Logging must never take the app down.
    }
    if (echo) process.stdout.write(text);
  };

  const line = (level, scope, message) =>
    append(`${new Date().toISOString()} [${level}] [${scope}] ${message}\n`);

  const scoped = (scope) => ({
    info: (message) => line('info', scope, message),
    warn: (message) => line('warn', scope, message),
    error: (message) => line('error', scope, message),
    child: (name) => scoped(`${scope}:${name}`),
  });

  // Raw output from child processes (backend console output).
  scoped.raw = (prefix) => (chunk) => {
    const text = String(chunk);
    append(
      text
        .split(/\r?\n/)
        .filter((part) => part.length)
        .map((part) => `${new Date().toISOString()} ${prefix} ${part.replace(/\x1b\[[0-9;]*m/g, '')}\n`)
        .join('')
    );
  };

  return scoped;
}

module.exports = { createLogger, rotateIfLarge };
