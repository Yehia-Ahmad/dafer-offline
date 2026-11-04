// Used only when the backend runs inside the offline desktop app (an Electron utility
// process). The desktop app asks for a clean stop before it shuts MongoDB down, so no
// request is cut off mid-write. The online deployment never calls this.
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

module.exports = { DEFAULT_SHUTDOWN_TIMEOUT_MS, createGracefulShutdown };
