const MIN_JWT_SECRET_LENGTH = 32;

// Fail closed: without a usable secret the backend must not start.
const requireJwtSecret = (env = process.env) => {
  const secret = typeof env.NOTA_JWT_SECRET === "string" ? env.NOTA_JWT_SECRET : "";
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`NOTA_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  return secret;
};

// Online Stage 3: the customer website has its own signing secret, so a staff token can never be a customer token and
// the other way round. It must differ from NOTA_JWT_SECRET.
const requireStoreJwtSecret = (env = process.env) => {
  const secret = typeof env.NOTA_STORE_JWT_SECRET === "string" ? env.NOTA_STORE_JWT_SECRET : "";
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`NOTA_STORE_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  if (secret === env.NOTA_JWT_SECRET) throw new Error("NOTA_STORE_JWT_SECRET must differ from NOTA_JWT_SECRET");
  return secret;
};

// Stage 15: tokens issued before this time (ms since epoch) are refused. 0 = no cut-off.
const sessionsValidAfter = (env = process.env) => {
  const value = Number(env.NOTA_SESSIONS_VALID_AFTER || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

module.exports = { MIN_JWT_SECRET_LENGTH, requireJwtSecret, requireStoreJwtSecret, sessionsValidAfter };
