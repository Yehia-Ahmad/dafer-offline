require("dotenv").config();

const mongoose = require("mongoose");
const app = require("./app");
const connectDB = require("./config/db");
const { createGracefulShutdown } = require("./utils/gracefulShutdown");

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

startServer();
