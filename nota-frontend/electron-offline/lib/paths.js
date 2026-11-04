'use strict';

// Where the offline edition keeps its files.
//
// Installed app: C:\ProgramData\Kapomatic Offline, shared by every Windows account on the PC,
// so data survives updates, reinstalls and switching users.
// Development (npm run electron:start:offline): <project>/offline-dev-home.
// KAPOMATIC_OFFLINE_HOME overrides both (used by tests).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRODUCT_FOLDER = 'Kapomatic Offline';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Well-known SID of BUILTIN\Users, so this works on Arabic and English Windows alike.
const USERS_SID = '*S-1-5-32-545';

function resolveHome({ isPackaged, env = process.env }) {
  if (env.KAPOMATIC_OFFLINE_HOME) return path.resolve(env.KAPOMATIC_OFFLINE_HOME);
  if (!isPackaged) return path.join(PROJECT_ROOT, 'offline-dev-home');
  return path.join(env.ProgramData || 'C:\\ProgramData', PRODUCT_FOLDER);
}

function layout(home) {
  return {
    home,
    config: path.join(home, 'config.json'),
    dbPath: path.join(home, 'data', 'db'),
    logs: path.join(home, 'logs'),
    run: path.join(home, 'run'),
    backups: path.join(home, 'backups'),
    autoBackups: path.join(home, 'backups', 'auto'),
    backupState: path.join(home, 'backups', 'backup-state.json'),
  };
}

// Bundled files: resources/ when installed, sibling checkouts during development.
function resolveResources({ isPackaged, resourcesPath, env = process.env }) {
  if (isPackaged) {
    return {
      backendDir: path.join(resourcesPath, 'backend'),
      mongodbBin: path.join(resourcesPath, 'mongodb', 'bin'),
      uiDir: path.join(__dirname, '..', '..', 'dist'),
    };
  }
  return {
    backendDir: path.resolve(env.KAPOMATIC_BACKEND_DIR || path.join(PROJECT_ROOT, '..', 'kapomatic-backend')),
    mongodbBin: path.join(PROJECT_ROOT, 'vendor', 'mongodb', 'bin'),
    uiDir: path.join(PROJECT_ROOT, 'dist-offline', 'browser'),
  };
}

// Creates the folders. When this process creates the home folder itself, it lets every
// Windows account on the PC modify it; the installer does the same for installed copies.
function ensureLayout(paths, { platform = process.platform, log } = {}) {
  const created = !fs.existsSync(paths.home);
  for (const dir of [paths.home, paths.dbPath, paths.logs, paths.run, paths.backups, paths.autoBackups]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (created && platform === 'win32') {
    const result = spawnSync('icacls', [paths.home, '/grant', `${USERS_SID}:(OI)(CI)M`, '/T', '/Q'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.status !== 0 && log) {
      log.warn(`could not grant Users access to ${paths.home}: ${result.stderr || result.stdout}`);
    }
  }
  return created;
}

module.exports = { PRODUCT_FOLDER, PROJECT_ROOT, ensureLayout, layout, resolveHome, resolveResources };
