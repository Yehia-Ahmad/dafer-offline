'use strict';

// The backend's session-token secret (NOTA_JWT_SECRET), main PC only (Stage 13).
// Generated on the first start in main-PC mode (32 random bytes, hex) and kept DPAPI-protected in
// config.json next to the LAN secret, so sessions survive restarts.
//
// Stage 14: the backend runs with NOTA_AUTH=1, which cannot start without this secret. So any
// failure (unreadable stored value, or generating/saving a new one) throws; the caller shows the
// error screen instead of starting the backend.

const crypto = require('node:crypto');

/**
 * Returns { secret, config }. `config` is the (possibly rewritten) config.
 * Dependencies are passed in so the function can be tested without DPAPI or a real file.
 */
function loadJwtSecret({
  config,
  configPath,
  protectSecret,
  unprotectSecret,
  writeConfig,
  randomBytes = crypto.randomBytes,
  log,
}) {
  if (config && config.jwtSecretProtected) {
    const secret = unprotectSecret(config.jwtSecretProtected, { purpose: 'jwt' });
    if (typeof secret !== 'string' || secret.length < 32) {
      throw Object.assign(new Error('the stored session-token secret is empty or too short'), { code: 'JWT_SECRET_UNREADABLE' });
    }
    return { secret, config };
  }
  const secret = randomBytes(32).toString('hex');
  const next = writeConfig(configPath, { ...config, jwtSecretProtected: protectSecret(secret, { purpose: 'jwt' }) });
  if (log) log.info('generated the session-token secret');
  return { secret, config: next };
}

module.exports = { loadJwtSecret };
