#!/usr/bin/env node
// Cross-platform version of "DEBUG=electron-builder electron-builder <args>".
// cmd and PowerShell cannot set a variable in front of a command, so this sets it and
// passes every argument through to electron-builder unchanged.
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, DEBUG: 'electron-builder' },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
