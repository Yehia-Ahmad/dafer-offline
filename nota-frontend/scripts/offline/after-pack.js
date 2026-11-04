// electron-builder afterPack hook for the offline edition (electron-builder.offline.json).
// Copies the staged backend and the MongoDB binaries into resources/. This is done here and
// not with extraResources because electron-builder always leaves node_modules folders out of
// extraResources, and the backend cannot run without them. afterPack runs before the NSIS
// installer is built, so the installer contains these files.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const COPIES = [
  {
    from: path.join(ROOT, 'offline-stage', 'backend'),
    to: 'backend',
    required: ['src/server.js', 'node_modules/express/package.json', 'node_modules/mongoose/package.json'],
  },
  {
    from: path.join(ROOT, 'vendor', 'mongodb'),
    to: 'mongodb',
    required: ['bin/mongod.exe', 'bin/mongodump.exe', 'bin/mongorestore.exe', 'versions.json'],
  },
];

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources');

  for (const { from, to, required } of COPIES) {
    if (!fs.existsSync(from)) {
      throw new Error(`[offline:afterPack] missing ${path.relative(ROOT, from)}; run the offline:vendor and offline:stage scripts first`);
    }
    const target = path.join(resources, to);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(from, target, { recursive: true });

    const missing = required.filter((file) => !fs.existsSync(path.join(target, file)));
    if (missing.length) throw new Error(`[offline:afterPack] ${to} is incomplete: ${missing.join(', ')}`);
    console.log(`  • offline afterPack  copied ${path.relative(ROOT, from)} to resources/${to}`);
  }
};
