#!/usr/bin/env node
// Runs the offline edition's Node tests (electron-offline/test/*.test.js).
// Lists the files itself, because node --test treats folders and globs differently across
// Node versions and cmd does not expand globs.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = path.resolve(__dirname, '..', '..', 'electron-offline', 'test');
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(dir, name));

const result = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
