// Stage 24: the license code loads FIRST, before dotenv, express, mongoose or any other dependency, and keeps its own references to
// crypto, fs and child_process functions (license/index.js), so replacing those functions after it loaded does not change what the license
// check does. That is all it protects against: the tamper check (lib/integrity.js in the desktop app) is the real guard for the files.
require("./license");

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
const { runMigrations, recordAppVersion } = require("./migrations");

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

// Stage 25: before the first migration touches an existing database, the desktop app takes a "before-upgrade" backup. The server asks over
// the utility-process channel and waits; no backup, no migration (the error carries an Arabic + English message and the data stays untouched).
const requestUpgradeBackup = (info) => new Promise((resolve, reject) => {
  const onMessage = (event) => {
    const message = event && event.data;
    if (!message || message.type !== "upgrade-backup-result") return;
    parentPort.removeListener("message", onMessage);
    if (message.ok) return resolve(message);
    const error = new Error(message.message || "تعذر أخذ نسخة احتياطية قبل التحديث، لذلك لم يتم تحديث البيانات. / The backup before the upgrade failed, so the data was not upgraded.");
    error.code = "UPGRADE_BACKUP_FAILED";
    error.detail = message.detail;
    return reject(error);
  };
  parentPort.on("message", onMessage);
  parentPort.postMessage({ type: "upgrade-backup", ...info });
});

const startServer = async () => {
  await connectDB();
  await assertTransactionsSupported();
  await runMigrations({ beforeMigrate: parentPort ? requestUpgradeBackup : undefined });
  await recordAppVersion(process.env.NOTA_APP_VERSION, process.env.NOTA_APP_BUILD);

  // Stage 24: re-verify the license file now (cached from here on) and mirror it into the database.
  // No valid license is not a startup failure: the backend runs and answers 402 until one is activated.
  try {
    const state = await require("./license/service").applyAtStart();
    console.log(state.ok ? "license: valid" : `license: ${state.code}`);
  } catch (error) {
    console.error(`license: ${error.message}`);
  }

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

// Stage 25: the staged-build check (offline:stage) loads the bundled server to prove every module resolves, without starting it.
const loadCheckOnly = process.env.NOTA_STAGE_LOAD_CHECK === "1";

if (!loadCheckOnly) startServer().catch((error) => {
  console.error("فشل بدء الخادم:", error.stack || error.message);
  if (parentPort) parentPort.postMessage({
    type: "error",
    code: error.code || "STARTUP_FAILED",
    message: error.message,
    detail: error.stack || error.message,
  });
  setTimeout(() => process.exit(1), 10);
});
