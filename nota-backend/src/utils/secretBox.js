// Online Stage 7B: encrypts the secrets Nota keeps for the shop (the Meta token and app secret) with AES-256-GCM.
// The key is NOTA_SECRETS_KEY (64 hex chars = 32 bytes), read lazily so the app boots without it; only a call that needs it fails.
// Stored form: "v1.<iv>.<tag>.<ciphertext>" (base64url). The `context` (for example the connection id) is bound as AAD.
const crypto = require("node:crypto");

class SecretsKeyError extends Error {
  constructor(message) {
    super(message);
    this.code = "SECRETS_KEY_MISSING";
  }
}

const keyOf = () => {
  const hex = String(process.env.NOTA_SECRETS_KEY || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new SecretsKeyError("NOTA_SECRETS_KEY is missing or not 64 hex characters");
  return Buffer.from(hex, "hex");
};

const seal = (plain, context = "") => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(), iv);
  cipher.setAAD(Buffer.from(String(context)));
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
};

const open = (sealed, context = "") => {
  const parts = String(sealed || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("SECRET_FORMAT");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyOf(), Buffer.from(parts[1], "base64url"));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
};

/** "…abcd": the only part of a secret that may be shown. */
const last4 = (plain) => String(plain || "").slice(-4);

module.exports = { seal, open, last4, SecretsKeyError };
