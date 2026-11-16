require("dotenv").config();

const app = require("./app");
const connectDB = require("./config/db");
const { ensureIndexes } = connectDB;
// Registered here explicitly so ensureIndexes() always covers the auth models.
require("./models/user.model");
require("./models/auditLog.model");
const { assertTransactionsSupported } = require("./utils/transaction");
const { runMigrations } = require("./migrations");

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();
  await assertTransactionsSupported();
  await runMigrations();

  // Every start: build all model indexes. This also guarantees the Stage 13 user indexes
  // (one owner, unique usernames) exist before the first login.
  await ensureIndexes();

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("فشل بدء الخادم:", error.stack || error.message);
  setTimeout(() => process.exit(1), 10);
});
