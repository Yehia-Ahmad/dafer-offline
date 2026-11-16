require("dotenv").config();

const mongoose = require("mongoose");
const app = require("./app");
const connectDB = require("./config/db");
const { ensureIndexes } = connectDB;
// Registered here explicitly so ensureIndexes() always covers the auth models.
require("./models/user.model");
require("./models/auditLog.model");
const { createGracefulShutdown, registerShutdownSignals } = require("./utils/gracefulShutdown");
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

  // NOTA_LISTEN_HOST (production: 127.0.0.1) limits the listener to one address; unset = all interfaces.
  const host = process.env.NOTA_LISTEN_HOST;
  const onListening = () => {
    console.log(`Server started on ${host || "all interfaces"}:${PORT}`);
  };
  const server = host ? app.listen(PORT, host, onListening) : app.listen(PORT, onListening);

  // systemd stop/restart sends SIGTERM: finish in-flight requests (10 s), disconnect MongoDB, exit 0.
  registerShutdownSignals(createGracefulShutdown({ server, disconnect: () => mongoose.disconnect() }));
};

startServer().catch((error) => {
  console.error("فشل بدء الخادم:", error.stack || error.message);
  setTimeout(() => process.exit(1), 10);
});
