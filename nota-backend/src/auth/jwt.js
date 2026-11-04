// Stage 13: session tokens. HS256 with NOTA_JWT_SECRET, payload { sub, tv } only, 12 hours.
// `tv` is the user's tokenVersion: raising it (password change/reset, disable, role or permission
// change) ends every older session at once.
const jwt = require("jsonwebtoken");

const TOKEN_TTL = "12h";
const ALGORITHM = "HS256";

const signToken = (user, secret) =>
  jwt.sign({ sub: String(user._id), tv: Number(user.tokenVersion || 0) }, secret, {
    algorithm: ALGORITHM,
    expiresIn: TOKEN_TTL,
  });

/** The payload, or null for a missing, malformed, expired or wrongly signed token. */
const verifyToken = (token, secret) => {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
    if (!payload || typeof payload.sub !== "string" || !Number.isInteger(payload.tv)) return null;
    return payload;
  } catch {
    return null;
  }
};

/** The token from `Authorization: Bearer <token>`, or null. */
const bearerToken = (req) => {
  const header = req.get ? req.get("authorization") : req.headers && req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
};

module.exports = { ALGORITHM, TOKEN_TTL, bearerToken, signToken, verifyToken };
