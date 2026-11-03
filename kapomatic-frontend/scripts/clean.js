#!/usr/bin/env node
// Cross-platform version of the former clean shell command:
//   rm -rf node_modules .angular/cache node_modules/.vite
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

for (const target of ['node_modules', path.join('.angular', 'cache'), path.join('node_modules', '.vite')]) {
  fs.rmSync(path.join(ROOT, target), { recursive: true, force: true });
}
