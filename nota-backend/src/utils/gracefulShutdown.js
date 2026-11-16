// Clean stop of the backend: stop accepting connections, let in-flight requests finish (up to
// timeoutMs), disconnect MongoDB, exit. The online server runs it on SIGTERM/SIGINT (systemd stop
// or restart during update.sh / restore.sh), so a request such as saving an invoice is not cut off.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const IDLE_SWEEP_INTERVAL_MS = 50;

const createGracefulShutdown = ({
  server,
  disconnect,
  exit = (code) => process.exit(code),
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  log = console,
}) => {
  let shutdownPromise = null;

  return () => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      let exitCode = 0;

      try {
        await new Promise((resolve) => {
          // Stop accepting new connections; in-flight requests get timeoutMs to finish.
          const forceTimer = setTimeout(() => {
            log.warn("[shutdown] Requests still open after timeout, closing them.");
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          }, timeoutMs);

          // A keep-alive socket goes idle once its in-flight request finishes and would
          // hold server.close() open until the keep-alive timeout, so keep closing them.
          const closeIdle = () => {
            if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
          };
          const idleTimer = setInterval(closeIdle, IDLE_SWEEP_INTERVAL_MS);

          server.close(() => {
            clearTimeout(forceTimer);
            clearInterval(idleTimer);
            resolve();
          });
          closeIdle();
        });
      } catch (error) {
        exitCode = 1;
        log.error("[shutdown] Failed to close the HTTP server:", error.message);
      }

      try {
        await disconnect();
      } catch (error) {
        exitCode = 1;
        log.error("[shutdown] Failed to disconnect from MongoDB:", error.message);
      }

      log.log("[shutdown] Backend stopped.");
      exit(exitCode);
    })();

    return shutdownPromise;
  };
};

// Runs `shutdown` on the given signals (SIGTERM from systemd, SIGINT from Ctrl+C). `proc` is injectable for tests.
const registerShutdownSignals = (shutdown, { proc = process, signals = ["SIGTERM", "SIGINT"] } = {}) => {
  signals.forEach((signal) => proc.on(signal, () => shutdown()));
};

module.exports = { DEFAULT_SHUTDOWN_TIMEOUT_MS, createGracefulShutdown, registerShutdownSignals };
