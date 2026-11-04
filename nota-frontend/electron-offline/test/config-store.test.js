'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConfigError, DEFAULT_PORT, readConfig, writeConfig } = require('../lib/config-store');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nota-config-'));

const validMain = {
  schemaVersion: 1,
  role: 'main',
  instanceId: 'b3c6f0d2-1111-4c4c-9a9a-123456789abc',
  lanSecretProtected: 'AQAAANCMnd8BFdERjHoAwE',
  shopName: 'Nota',
};

test('a missing config means the app is not set up yet', () => {
  assert.equal(readConfig(path.join(tempDir(), 'config.json')), null);
});

test('write then read returns the normalized config with defaults', () => {
  const file = path.join(tempDir(), 'nested', 'config.json');
  writeConfig(file, validMain);
  const config = readConfig(file);
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.startWithWindows, true);
  assert.equal(config.role, 'main');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temporary file is left behind');
});

test('the main PC keeps the extra backup folder; it is empty by default', () => {
  const file = path.join(tempDir(), 'config.json');
  assert.equal(writeConfig(file, validMain).backupCopyFolder, '');
  writeConfig(file, { ...validMain, backupCopyFolder: 'E:\\Nota' });
  assert.equal(readConfig(file).backupCopyFolder, 'E:\\Nota');
  assert.equal(writeConfig(file, { ...validMain, role: 'client' }).backupCopyFolder, undefined);
});

test('the main PC keeps its protected session-token secret through later writes; configs from before Stage 13 have none', () => {
  const file = path.join(tempDir(), 'config.json');
  assert.equal('jwtSecretProtected' in writeConfig(file, validMain), false, 'older configs stay valid without it');
  writeConfig(file, { ...validMain, jwtSecretProtected: 'AQAAANCMnd8-jwt' });
  // Any later write (for example choosing a backup folder) must not drop it.
  writeConfig(file, { ...readConfig(file), backupCopyFolder: 'E:\\Nota' });
  assert.equal(readConfig(file).jwtSecretProtected, 'AQAAANCMnd8-jwt');
  assert.equal(writeConfig(file, { ...validMain, role: 'client', jwtSecretProtected: 'x' }).jwtSecretProtected, undefined, 'client PCs never keep one');
});

test('client configs keep the main PC address fields', () => {
  const file = path.join(tempDir(), 'config.json');
  writeConfig(file, { ...validMain, role: 'client', mainHost: '192.168.1.10', mainInstanceId: 'x' });
  assert.equal(readConfig(file).mainHost, '192.168.1.10');
});

test('invalid configs are rejected', () => {
  const file = path.join(tempDir(), 'config.json');
  for (const bad of [
    { ...validMain, role: 'server' },
    { ...validMain, schemaVersion: 2 },
    { ...validMain, instanceId: '' },
    { ...validMain, lanSecretProtected: undefined },
    { ...validMain, port: 80 },
    { ...validMain, port: 27217 },
    { ...validMain, port: 27218 },
    { ...validMain, port: 5060 }, // browser-blocked: the UI could never connect
    { ...validMain, port: 5061 },
    { ...validMain, port: 6000 },
    { ...validMain, port: '5055' },
  ]) {
    assert.throws(() => writeConfig(file, bad), ConfigError, JSON.stringify(bad));
  }

  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readConfig(file), /not valid JSON/);
});
