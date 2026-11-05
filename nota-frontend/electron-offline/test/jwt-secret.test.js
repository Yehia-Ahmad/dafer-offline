'use strict';

// Stage 14: loadJwtSecret() — first start generates and stores the session-token secret, later
// starts read it back, and an unreadable stored value is an error (the caller shows the error
// screen and never starts the backend). DPAPI and the config file are replaced by fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadJwtSecret } = require('../lib/jwt-secret');

// A fake config store and a reversible fake "protection" (the real one is Windows DPAPI).
const fakes = () => {
  const writes = [];
  const protectSecret = (value, { purpose }) => `${purpose}:${Buffer.from(value).toString('base64')}`;
  const unprotectSecret = (value, { purpose }) => {
    if (!value.startsWith(`${purpose}:`)) throw new Error('DPAPI: the data is invalid');
    return Buffer.from(value.slice(purpose.length + 1), 'base64').toString();
  };
  const writeConfig = (file, config) => {
    writes.push({ file, config });
    return config;
  };
  return { writes, protectSecret, unprotectSecret, writeConfig };
};

test('first start generates a 64-hex secret and stores it protected (purpose jwt)', () => {
  const f = fakes();
  const result = loadJwtSecret({
    config: { role: 'main', lanSecretProtected: 'lan:x' },
    configPath: 'C:/ProgramData/Nota/config.json',
    ...f,
    randomBytes: (n) => Buffer.alloc(n, 0xab),
  });
  assert.equal(result.secret, 'ab'.repeat(32));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].file, 'C:/ProgramData/Nota/config.json');
  assert.equal(f.writes[0].config.lanSecretProtected, 'lan:x', 'the rest of the config is kept');
  assert.match(f.writes[0].config.jwtSecretProtected, /^jwt:/);
  assert.notEqual(f.writes[0].config.jwtSecretProtected, result.secret, 'never stored in plain text');
  assert.equal(result.config.jwtSecretProtected, f.writes[0].config.jwtSecretProtected);
});

test('later starts read the same secret back without writing the config', () => {
  const f = fakes();
  const first = loadJwtSecret({ config: { role: 'main' }, configPath: 'c.json', ...f });
  const writesAfterFirst = f.writes.length;
  const second = loadJwtSecret({ config: first.config, configPath: 'c.json', ...f });
  assert.equal(second.secret, first.secret);
  assert.equal(f.writes.length, writesAfterFirst, 'nothing is written on later starts');
  assert.equal(second.secret.length, 64);
});

test('an unreadable stored value throws (fatal at startup), and is not replaced', () => {
  const f = fakes();
  assert.throws(
    () => loadJwtSecret({ config: { jwtSecretProtected: 'garbage-from-another-pc' }, configPath: 'c.json', ...f }),
    /DPAPI/
  );
  assert.equal(f.writes.length, 0, 'a new secret is never generated over an unreadable one');
});

test('a stored value that decrypts to an empty or short secret throws', () => {
  const f = fakes();
  const stored = f.protectSecret('short', { purpose: 'jwt' });
  assert.throws(() => loadJwtSecret({ config: { jwtSecretProtected: stored }, configPath: 'c.json', ...f }), (error) => error.code === 'JWT_SECRET_UNREADABLE');
});

test('a failure while saving a new secret throws', () => {
  const f = fakes();
  assert.throws(
    () => loadJwtSecret({ config: {}, configPath: 'c.json', ...f, writeConfig: () => { throw new Error('EACCES'); } }),
    /EACCES/
  );
});
