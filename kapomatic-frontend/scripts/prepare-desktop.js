#!/usr/bin/env node
// Cross-platform version of the former prepare:desktop shell command:
//   rm -rf desktop/dist desktop/electron desktop/node_modules
//   cp -R dist desktop/dist && cp -R electron desktop/electron
// Same result, but it also runs from cmd and PowerShell.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const at = (...parts) => path.join(ROOT, ...parts);

for (const dir of ['dist', 'electron', 'node_modules']) {
  fs.rmSync(at('desktop', dir), { recursive: true, force: true });
}

fs.cpSync(at('dist'), at('desktop', 'dist'), { recursive: true });
fs.cpSync(at('electron'), at('desktop', 'electron'), { recursive: true });
