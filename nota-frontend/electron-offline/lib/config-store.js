'use strict';

// config.json in the shared home folder. Written once by the setup screen (step 5) and read
// on every start. The LAN secret is stored protected by secret-store.js, never in plain text.

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_PORT = 5055;
// Fixed local-only ports used by the main PC; the backend port must not collide with them.
const MONGOD_PORT = 27217;
const SERVER_LOCK_PORT = 27218;
const RESERVED_PORTS = new Set([MONGOD_PORT, SERVER_LOCK_PORT]);
// Ports Chromium refuses to connect to (net/base/port_util.cc, the "bad ports" of the Fetch
// standard). The admin UI could never reach a backend on one of them.
const BROWSER_BLOCKED_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function validPort(value) {
  return (
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65535 &&
    !RESERVED_PORTS.has(value) &&
    !BROWSER_BLOCKED_PORTS.has(value)
  );
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config is not an object');
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`unsupported config schemaVersion ${raw.schemaVersion}`);
  }
  if (raw.role !== 'main' && raw.role !== 'client') throw new ConfigError(`invalid role ${raw.role}`);
  if (typeof raw.instanceId !== 'string' || !raw.instanceId) throw new ConfigError('missing instanceId');
  if (typeof raw.lanSecretProtected !== 'string' || !raw.lanSecretProtected) {
    throw new ConfigError('missing lanSecretProtected');
  }

  const port = raw.port === undefined ? DEFAULT_PORT : raw.port;
  if (!validPort(port)) throw new ConfigError(`invalid port ${raw.port}`);

  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    role: raw.role,
    instanceId: raw.instanceId,
    lanSecretProtected: raw.lanSecretProtected,
    port,
    shopName: typeof raw.shopName === 'string' ? raw.shopName : '',
    startWithWindows: raw.startWithWindows !== false,
  };

  if (raw.role === 'main') {
    // Optional second folder (USB drive, another disk) for a copy of each daily backup.
    config.backupCopyFolder = typeof raw.backupCopyFolder === 'string' ? raw.backupCopyFolder : '';
    // Stage 13: the backend's session-token secret (NOTA_JWT_SECRET), DPAPI-protected like the
    // LAN secret. Created on the first start in main-PC mode; absent on configs from before Stage 13.
    if (typeof raw.jwtSecretProtected === 'string' && raw.jwtSecretProtected) {
      config.jwtSecretProtected = raw.jwtSecretProtected;
    }
  }

  if (raw.role === 'client') {
    // Filled in by the client setup (step 5).
    config.mainHost = typeof raw.mainHost === 'string' ? raw.mainHost : '';
    config.mainInstanceId = typeof raw.mainInstanceId === 'string' ? raw.mainInstanceId : '';
  }
  return config;
}

// Returns null when the app has not been set up yet.
function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config.json is not valid JSON: ${error.message}`);
  }
  return normalizeConfig(raw);
}

// Write to a temporary file first, so a crash never leaves a half-written config.
function writeConfig(file, config) {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return normalized;
}

module.exports = {
  BROWSER_BLOCKED_PORTS,
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  DEFAULT_PORT,
  MONGOD_PORT,
  SERVER_LOCK_PORT,
  normalizeConfig,
  readConfig,
  validPort,
  writeConfig,
};
