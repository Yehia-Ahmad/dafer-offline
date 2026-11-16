const MIN_JWT_SECRET_LENGTH = 32;

// Fail closed: without a usable secret the backend must not start.
const requireJwtSecret = (env = process.env) => {
  const secret = typeof env.NOTA_JWT_SECRET === "string" ? env.NOTA_JWT_SECRET : "";
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`NOTA_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  return secret;
};

// Stage 15: tokens issued before this time (ms since epoch) are refused. 0 = no cut-off.
const sessionsValidAfter = (env = process.env) => {
  const value = Number(env.NOTA_SESSIONS_VALID_AFTER || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

module.exports = { MIN_JWT_SECRET_LENGTH, requireJwtSecret, sessionsValidAfter };
