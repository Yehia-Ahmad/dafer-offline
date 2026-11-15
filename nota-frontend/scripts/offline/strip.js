'use strict';

// Stage 25: removes what a running backend never reads from a staged node_modules: docs, type declarations, source maps,
// tests and examples. LICENSE / COPYING / NOTICE files always stay (license compliance).

const fs = require('node:fs');
const path = require('node:path');

const STRIP_FILE = /^(readme|changelog|history|authors|contributors)(\..*)?$|\.(md|markdown)$|\.d\.(ts|mts|cts)$|\.(map|tsbuildinfo)$/i;
const STRIP_FOLDERS = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples']);
// Every license-like file name: LICENSE, LICENSE.md, LICENSE-MIT.txt, MIT-LICENSE.txt, LICENCE, COPYING, COPYING.LESSER, NOTICE (code files excluded).
const LICENSE_NAME = /(^|[-_.])(licen[cs]e|copying|notice)([-_.].*)?$/i;
const CODE_FILE = /\.(js|cjs|mjs|json|ts|map)$/i;
const isLicenseFile = (name) => LICENSE_NAME.test(name) && !CODE_FILE.test(name);
const KEEP_FILE = { test: isLicenseFile };

function walkFiles(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

/** Returns { files, bytes } removed. */
function stripNodeModules(modules) {
  const result = { files: 0, bytes: 0 };
  if (!fs.existsSync(modules)) return result;
  const count = (full) => { result.files += 1; result.bytes += fs.statSync(full).size; };
  const visit = (dir) => {
    // A folder named doc/test/example is only documentation or a test at the ROOT of a package: deeper it can be real code (exceljs has lib/doc).
    const packageRoot = fs.existsSync(path.join(dir, 'package.json'));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (packageRoot && STRIP_FOLDERS.has(entry.name.toLowerCase())) {
          // A LICENSE file inside a stripped folder is kept (moved up would change layout; keep the folder holding only licenses).
          const keepers = [];
          walkFiles(full, (file) => { if (KEEP_FILE.test(path.basename(file))) keepers.push(file); else count(file); });
          if (keepers.length) {
            for (const file of fs.readdirSync(full, { withFileTypes: true })) if (!file.isFile() || !KEEP_FILE.test(file.name)) fs.rmSync(path.join(full, file.name), { recursive: true, force: true });
          } else fs.rmSync(full, { recursive: true, force: true });
        } else visit(full);
      } else if (entry.isFile() && STRIP_FILE.test(entry.name) && !KEEP_FILE.test(entry.name)) {
        count(full);
        fs.rmSync(full, { force: true });
      }
    }
  };
  visit(modules);
  return result;
}

module.exports = { stripNodeModules, isLicenseFile };
