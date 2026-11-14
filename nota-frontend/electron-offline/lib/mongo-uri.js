'use strict';

// One place that builds mongod connection strings (Stage 24: with or without credentials).
// Passwords are generated as base64url, but are URL-encoded anyway. Never log what this returns when `auth` is set.

const REPLICA_SET = 'rs0';

/**
 * mongodb://[user:password@]127.0.0.1:<port>/<db>?replicaSet=rs0&directConnection=true[&authSource=admin]
 * auth = { user, password } (users live in the admin database).
 */
function mongoUri({ port, db = '', auth = null, replicaSet = REPLICA_SET, directConnection = true }) {
  const credentials = auth ? `${encodeURIComponent(auth.user)}:${encodeURIComponent(auth.password)}@` : '';
  const params = [];
  if (replicaSet) params.push(`replicaSet=${replicaSet}`);
  if (directConnection) params.push('directConnection=true');
  if (auth) params.push('authSource=admin');
  return `mongodb://${credentials}127.0.0.1:${port}/${db}${params.length ? `?${params.join('&')}` : ''}`;
}

/** The same URI with the password hidden, for logs and error messages. */
const redactUri = (uri) => String(uri).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

module.exports = { REPLICA_SET, mongoUri, redactUri };
