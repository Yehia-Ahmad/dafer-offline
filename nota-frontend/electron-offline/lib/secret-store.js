'use strict';

// Protects the LAN secret with Windows DPAPI in machine scope.
//
// The config lives in C:\ProgramData and must work for every Windows account on the PC, so
// Electron's safeStorage (per-user DPAPI) cannot be used. Machine-scope DPAPI ties the stored
// value to this PC: a copied config.json or backup is useless elsewhere. Any local account can
// decrypt it, which matches the threat model: the secret keeps other LAN computers out, and
// local accounts can reach the 127.0.0.1-only database anyway.
//
// PowerShell does the DPAPI call. Values travel over stdin/stdout as base64, so the secret is
// never on a command line and non-ASCII text survives the console encoding.

const { spawnSync } = require('node:child_process');

// One entropy value per secret, so a protected value can only be read back as what it is.
// lan: the LAN secret (Stage 2). jwt: the session-token signing secret of the main PC (Stage 13).
const ENTROPY_BY_PURPOSE = {
  lan: 'nota-offline-lan-secret-v1',
  jwt: 'nota-offline-jwt-secret-v1',
};

// -EncodedCommand accepts no further arguments, so each mode and purpose gets its own script.
const script = (mode, ENTROPY) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = '${mode}'
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$scope = [Security.Cryptography.DataProtectionScope]::LocalMachine
if ($mode -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, $scope)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $entropy, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

const encode = (mode, entropy) => Buffer.from(script(mode, entropy), 'utf16le').toString('base64');
const ENCODED_SCRIPTS = Object.fromEntries(
  Object.entries(ENTROPY_BY_PURPOSE).map(([purpose, entropy]) => [
    purpose,
    { protect: encode('protect', entropy), unprotect: encode('unprotect', entropy) },
  ])
);

class SecretStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

// options.purpose: 'lan' (default) or 'jwt'.
function runDpapi(mode, inputBase64, { platform = process.platform, purpose = 'lan' } = {}) {
  if (platform !== 'win32') throw new SecretStoreError('the LAN secret store needs Windows');
  if (!ENCODED_SCRIPTS[purpose]) throw new SecretStoreError(`unknown secret purpose ${purpose}`);

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPTS[purpose][mode]],
    { input: inputBase64, encoding: 'utf8', windowsHide: true, timeout: 30000 }
  );
  if (result.error) throw new SecretStoreError(`could not run PowerShell: ${result.error.message}`);
  if (result.status !== 0) {
    throw new SecretStoreError(`DPAPI ${mode} failed: ${(result.stderr || '').trim().split(/\r?\n/)[0]}`);
  }
  return result.stdout.trim();
}

function protectSecret(secret, options) {
  if (typeof secret !== 'string' || !secret) throw new SecretStoreError('empty secret');
  return runDpapi('protect', Buffer.from(secret, 'utf8').toString('base64'), options);
}

function unprotectSecret(protectedValue, options) {
  if (typeof protectedValue !== 'string' || !protectedValue) throw new SecretStoreError('empty protected value');
  return Buffer.from(runDpapi('unprotect', protectedValue, options), 'base64').toString('utf8');
}

module.exports = { SecretStoreError, protectSecret, unprotectSecret };
