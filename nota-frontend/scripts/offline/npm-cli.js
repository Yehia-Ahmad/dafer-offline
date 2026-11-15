'use strict';

// Stage 25: runs npm without a shell (Node DEP0190: passing args to a shell:true spawn is deprecated and unsafe).
// On Windows npm is npm.cmd, which Node refuses to spawn without a shell, so npm runs through the npm-cli.js that ships next to node:
// process.execPath <npm-cli.js> args.
const fs = require('node:fs');
const path = require('node:path');

/** @returns {string|null} the npm-cli.js that belongs to the running node, or null */
function npmCliPath() {
  const candidates = [
    process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

/** [file, args] to hand to spawn/spawnSync for `npm <args>`. */
function npmCommand(args) {
  const cli = npmCliPath();
  if (!cli) throw new Error('could not find npm-cli.js next to node');
  return [process.execPath, [cli, ...args]];
}

module.exports = { npmCliPath, npmCommand };
