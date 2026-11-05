// Stage 13 switch. With NOTA_AUTH=1 every auth rule is enforced; unset (or any other value),
// the backend behaves exactly as before Stage 13.
const MIN_JWT_SECRET_LENGTH = 32;

const isAuthMode = (env = process.env) => env.NOTA_AUTH === "1";

// Fail closed, like the LAN guard: auth mode without a usable secret must not start.
const requireJwtSecret = (env = process.env) => {
  const secret = typeof env.NOTA_JWT_SECRET === "string" ? env.NOTA_JWT_SECRET : "";
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`NOTA_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters when NOTA_AUTH=1`);
  }
  return secret;
};

// Stage 15: tokens issued before this time (ms since epoch) are refused: the desktop app sets it
// when a backup is restored, so every session of the replaced users ends. 0 = no cut-off.
const sessionsValidAfter = (env = process.env) => {
  const value = Number(env.NOTA_SESSIONS_VALID_AFTER || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

module.exports = { MIN_JWT_SECRET_LENGTH, isAuthMode, requireJwtSecret, sessionsValidAfter };
