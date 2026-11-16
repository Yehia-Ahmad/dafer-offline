// Online Stage 3: customer-website session tokens. Signed with NOTA_STORE_JWT_SECRET (never the staff secret) and
// carrying the audience "nota-store"; payload { sub, tv } like the staff token. 30 days.
const jwt = require("jsonwebtoken");

const STORE_AUDIENCE = "nota-store";
const STORE_TOKEN_TTL = "30d";
const ALGORITHM = "HS256";

const signStoreToken = (customer, secret) =>
  jwt.sign({ sub: String(customer._id), tv: Number(customer.tokenVersion || 0) }, secret, {
    algorithm: ALGORITHM,
    audience: STORE_AUDIENCE,
    expiresIn: STORE_TOKEN_TTL,
  });

/** The payload, or null for a missing, malformed, expired, wrongly signed or wrong-audience token. */
const verifyStoreToken = (token, secret) => {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM], audience: STORE_AUDIENCE });
    if (!payload || typeof payload.sub !== "string" || !Number.isInteger(payload.tv)) return null;
    return payload;
  } catch {
    return null;
  }
};

module.exports = { STORE_AUDIENCE, STORE_TOKEN_TTL, signStoreToken, verifyStoreToken };
