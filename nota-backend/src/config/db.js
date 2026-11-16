const mongoose = require("mongoose");

const DEFAULT_MONGO_URI = "mongodb://127.0.0.1:27017/nota";

// The connection string comes from MONGO_URI. Returns { uri }.
const resolveMongoUri = (env = process.env) => {
  if (env.MONGO_URI) return { uri: env.MONGO_URI };
  return { uri: DEFAULT_MONGO_URI, usedDefault: true };
};

const connectDB = async () => {
  const resolved = resolveMongoUri();

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

// Build every registered model's indexes explicitly on each start (createIndexes is idempotent). A failed build (e.g. a
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
