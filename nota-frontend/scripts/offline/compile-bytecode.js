'use strict';

// Run by protect.js with ELECTRON_RUN_AS_NODE=1 on the SAME Electron binary that will run the backend (bytecode is tied to
// the exact V8). Usage: electron compile-bytecode.js <srcDir>. Prints one JSON line: { files, electron, v8 }.
const fs = require('node:fs');
const path = require('node:path');
const bytenode = require('bytenode');

const srcDir = path.resolve(process.argv[2] || '');
if (!process.versions.electron) {
  console.error('compile-bytecode.js must run on Electron (ELECTRON_RUN_AS_NODE=1), not plain Node: bytecode is V8-version specific');
  process.exit(2);
}
if (!fs.existsSync(srcDir)) {
  console.error(`no such folder: ${srcDir}`);
  process.exit(2);
}

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith('.js')) files.push(full);
  }
};
walk(srcDir);

// Compile everything first, then replace the sources with stubs (a stub must never be compiled itself).
for (const file of files) bytenode.compileFile({ filename: file, output: file.replace(/\.js$/, '.jsc') });
for (const file of files) {
  const base = path.basename(file, '.js');
  fs.writeFileSync(file, `require('bytenode');\nmodule.exports = require('./${base}.jsc');\n`);
}
console.log(JSON.stringify({ files: files.length, electron: process.versions.electron, v8: process.versions.v8 }));
