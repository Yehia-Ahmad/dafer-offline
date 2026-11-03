const SLOW_DATABASE_MS = Number(process.env.PUBLIC_SLOW_DATABASE_MS || 500);

const elapsedMilliseconds = (startedAt) =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000;

const createPublicPerformance = (handler) => {
  const startedAt = process.hrtime.bigint();
  let databaseMs = 0;

  return {
    async database(operation) {
      const databaseStartedAt = process.hrtime.bigint();
      try {
        return await operation();
      } finally {
        const operationMs = elapsedMilliseconds(databaseStartedAt);
        databaseMs += operationMs;
        if (process.env.NODE_ENV !== "test" && operationMs >= SLOW_DATABASE_MS) {
          console.warn("public_api_slow_database", {
            handler,
            durationMs: Number(operationMs.toFixed(2)),
          });
        }
      }
    },
    finish(res, payload, counts = {}, cacheHit = false) {
      const serializationStartedAt = process.hrtime.bigint();
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
      const serializationMs = elapsedMilliseconds(serializationStartedAt);
      const metrics = {
        handler,
        totalMs: Number(elapsedMilliseconds(startedAt).toFixed(2)),
        databaseMs: Number(databaseMs.toFixed(2)),
        serializationMs: Number(serializationMs.toFixed(2)),
        payloadBytes,
        cacheHit,
        ...counts,
      };

      res.set(
        "Server-Timing",
        `db;dur=${metrics.databaseMs}, serialize;dur=${metrics.serializationMs}, total;dur=${metrics.totalMs}`
      );

      if (process.env.NODE_ENV !== "test") {
        const logCompletedRequest = () => {
          metrics.totalMs = Number(elapsedMilliseconds(startedAt).toFixed(2));
          console.info("public_api_performance", metrics);
        };
        if (typeof res.once === "function") res.once("finish", logCompletedRequest);
        else logCompletedRequest();
      }

      return payload;
    },
  };
};

module.exports = { createPublicPerformance };
