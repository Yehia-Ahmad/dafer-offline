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

    // Desktop migrations may kill stale sessions left by a crashed backend. Avoid starting
    // Mongoose's background index sessions before that cleanup; migration 4 creates them.
    await mongoose.connect(resolved.uri, { autoIndex: !isLanMode() });
    console.log("MongoDB connected");
  } catch (error) {
    console.error("فشل الاتصال بـ MongoDB:", error.message);
    process.exit(1);
  }
};

// LAN mode runs with autoIndex off, so Model.init() builds nothing there. Build every registered
// model's indexes explicitly on each start (createIndexes is idempotent). A failed build (e.g. a
// unique index blocked by duplicate data) aborts startup; no data is ever dropped to make it pass.
const ensureIndexes = async (connection = mongoose) => {
  for (const name of connection.modelNames()) {
    const model = connection.model(name);
    try {
      await model.createIndexes();
    } catch (error) {
      const wrapped = new Error(
        `فشل بناء فهرس في المجموعة "${model.collection.collectionName}" (النموذج ${name}): ${error.message}. لم يتم حذف أي بيانات.`
      );
      wrapped.cause = error;
      wrapped.collection = model.collection.collectionName;
      throw wrapped;
    }
  }
};

module.exports = connectDB;
module.exports.ensureIndexes = ensureIndexes;
module.exports.resolveMongoUri = resolveMongoUri;
module.exports.DEFAULT_MONGO_URI = DEFAULT_MONGO_URI;
