const mongoose = require("mongoose");
const { isLanMode } = require("../middlewares/lanSecret.middleware");

const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017/nota";

// The offline desktop app (LAN mode) always passes the URI of its own bundled mongod. Without
// it the backend must not guess: 127.0.0.1:27017 may be another MongoDB on the same PC.
// Returns { uri } or { error }.
const resolveMongoUri = (env = process.env) => {
  if (env.MONGO_URI) return { uri: env.MONGO_URI };
  if (isLanMode(env)) {
    return { error: "MONGO_URI غير موجود في وضع الشبكة المحلية (NOTA_LAN_MODE=1). لن يتم الاتصال بأي قاعدة بيانات أخرى." };
  }
  return { uri: DEFAULT_MONGO_URI, usedDefault: true };
};

const connectDB = async () => {
  const resolved = resolveMongoUri();
  if (resolved.error) {
    console.error(`فشل الاتصال بـ MongoDB: ${resolved.error}`);
    process.exit(1);
  }

  try {
    if (resolved.usedDefault) {
      console.warn("MONGO_URI غير موجود. سيتم استخدام رابط MongoDB المحلي الافتراضي.");
    }

    await mongoose.connect(resolved.uri);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("فشل الاتصال بـ MongoDB:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.resolveMongoUri = resolveMongoUri;
module.exports.DEFAULT_MONGO_URI = DEFAULT_MONGO_URI;
