'use strict';

// Stage 25: the one place the app's identity and version come from.
//   names        electron-offline/edition.json (no version in it)
//   version      the nearest package.json: nota-frontend/package.json in a checkout, the staged app package.json (written by offline:stage
//                from the same file) when installed. Nobody edits a version anywhere else.
//   build        electron-offline/build.json, written by offline:stage ("dev" in a checkout)
const fs = require('node:fs');
const path = require('node:path');

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

function loadEdition({ electronDir = path.join(__dirname, '..') } = {}) {
  const names = readJson(path.join(electronDir, 'edition.json')) || {};
  const pkg = readJson(path.join(electronDir, '..', 'package.json')) || {};
  const build = readJson(path.join(electronDir, 'build.json')) || {};
  const version = typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  const buildNumber = typeof build.build === 'string' && build.build ? build.build : 'dev';
  return { ...names, version, build: buildNumber, builtAt: build.builtAt || null, full: `${version} (${buildNumber})` };
}

module.exports = loadEdition();
module.exports.loadEdition = loadEdition;
