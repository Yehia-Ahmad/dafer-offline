require("dotenv").config();

const mongoose = require("mongoose");
const app = require("./app");
const connectDB = require("./config/db");
const { ensureIndexes } = connectDB;
// Registered here explicitly so ensureIndexes() always covers the auth models.
require("./models/user.model");
require("./models/auditLog.model");
const { createGracefulShutdown } = require("./utils/gracefulShutdown");
const { isAuthMode } = require("./auth/config");
const { drainAuditInbox } = require("./auth/auditInbox");
const { assertTransactionsSupported } = require("./utils/transaction");
const { runMigrations } = require("./migrations");

const PORT = process.env.PORT || 5000;
// Optional bind address. Unset in the online deployment, which keeps listening on all
// interfaces as before. Deliberately not named HOST, which some shells already export.
const LISTEN_HOST = process.env.NOTA_LISTEN_HOST;

// Set only when the offline desktop app runs the backend as an Electron utility process.
const parentPort = process.parentPort;

const onListening = () => {
  console.log(`Server started on port ${PORT}`);
  if (parentPort) parentPort.postMessage({ type: "ready", port: Number(PORT) });
};

const startServer = async () => {
  await connectDB();
  await assertTransactionsSupported();
  await runMigrations();

  // Every start: build all model indexes (autoIndex is off in LAN mode). This also guarantees the
  // Stage 13 user indexes (one owner, unique usernames) exist before the first setup-owner request.
  await ensureIndexes();

  if (isAuthMode()) {
    // Stage 15: backup/restore entries the desktop app wrote while the backend was stopped.
    try {
      await drainAuditInbox(process.env.NOTA_AUDIT_INBOX);
    } catch (error) {
      console.error(`audit inbox: ${error.message}`);
    }
  }

  const server = LISTEN_HOST
    ? app.listen(PORT, LISTEN_HOST, onListening)
    : app.listen(PORT, onListening);

  if (parentPort) {
    // Report startup failures such as a port already in use to the desktop app.
    server.on("error", (error) => {
      console.error("فشل تشغيل الخادم:", error.message);
      parentPort.postMessage({ type: "error", code: error.code || null, message: error.message });
      process.exit(1);
    });

    const shutdown = createGracefulShutdown({
      server,
      disconnect: () => mongoose.disconnect(),
    });

    parentPort.on("message", (event) => {
      if (event && event.data && event.data.type === "shutdown") shutdown();
    });
  }
};

startServer().catch((error) => {
  console.error("فشل بدء الخادم:", error.stack || error.message);
  if (parentPort) parentPort.postMessage({
    type: "error",
    code: error.code || "STARTUP_FAILED",
    message: error.message,
    detail: error.stack || error.message,
  });
  setTimeout(() => process.exit(1), 10);
});
