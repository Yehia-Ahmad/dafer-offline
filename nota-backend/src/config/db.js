const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const mongoUri =
      process.env.MONGO_URI || "mongodb://127.0.0.1:27017/kapomatic_warehouse";

    if (!process.env.MONGO_URI) {
      console.warn("MONGO_URI غير موجود. سيتم استخدام رابط MongoDB المحلي الافتراضي.");
    }

    await mongoose.connect(mongoUri);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("فشل الاتصال بـ MongoDB:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
