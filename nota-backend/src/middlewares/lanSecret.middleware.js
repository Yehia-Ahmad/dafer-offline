const crypto = require("crypto");

// Offline (LAN) edition only. The desktop app on the main PC starts the backend with
// KAPOMATIC_LAN_MODE=1 and a shared secret; every /api request must then carry that
// secret. When the variable is not set (the online deployment) none of this is mounted.
const LAN_KEY_HEADER = "x-kapomatic-lan-key";
const LAN_KEY_INVALID_CODE = "LAN_KEY_INVALID";
const MIN_LAN_SECRET_LENGTH = 8;

const isLanMode = (env = process.env) => env.KAPOMATIC_LAN_MODE === "1";

const hashKey = (value) => crypto.createHash("sha256").update(String(value)).digest();

const createLanSecretGuard = (secret) => {
  const expectedKey = typeof secret === "string" ? secret.trim() : "";

  // Fail closed: LAN mode without a usable secret must not start an open server.
  if (expectedKey.length < MIN_LAN_SECRET_LENGTH) {
    throw new Error(
      `KAPOMATIC_LAN_SECRET must be at least ${MIN_LAN_SECRET_LENGTH} characters when KAPOMATIC_LAN_MODE=1`
    );
  }

  const expectedHash = hashKey(expectedKey);

  return (req, res, next) => {
    // CORS preflight requests never carry custom headers.
    if (req.method === "OPTIONS") return next();

    const providedKey = req.get(LAN_KEY_HEADER);

    // Hash both sides so timingSafeEqual always compares equal-length buffers.
    if (
      typeof providedKey === "string" &&
      crypto.timingSafeEqual(hashKey(providedKey.trim()), expectedHash)
    ) {
      return next();
    }

    const error = new Error("كلمة سر الشبكة غير صحيحة");
    error.statusCode = 401;
    error.responseData = { code: LAN_KEY_INVALID_CODE };
    return next(error);
  };
};

module.exports = {
  LAN_KEY_HEADER,
  LAN_KEY_INVALID_CODE,
  MIN_LAN_SECRET_LENGTH,
  createLanSecretGuard,
  isLanMode,
};
