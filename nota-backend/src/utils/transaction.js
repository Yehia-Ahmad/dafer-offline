const mongoose = require("mongoose");

const hasLabel = (error, label) => Boolean(error && ((typeof error.hasErrorLabel === "function" && error.hasErrorLabel(label)) || (label === "TransientTransactionError" && /Please retry your operation|WriteConflict|TransientTransactionError/i.test(String(error.message || "")))));

async function commitWithRetry(session, maxCommitRetries) {
  for (let attempt = 0; attempt < maxCommitRetries; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      if (!hasLabel(error, "UnknownTransactionCommitResult") || attempt + 1 >= maxCommitRetries) throw error;
    }
  }
}

async function withTransaction(fn, { maxRetries = 10, maxCommitRetries = 5 } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const value = await fn(session);
      await commitWithRetry(session, maxCommitRetries);
      return value;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      if (hasLabel(error, "TransientTransactionError") && attempt + 1 < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, 5 * (attempt + 1))));
        continue;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
  throw new Error("تعذر إكمال المعاملة بعد عدة محاولات");
}

async function assertTransactionsSupported() {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (hello.setName !== "rs0" || !hello.isWritablePrimary) {
    throw new Error("MongoDB must be writable PRIMARY in replica set rs0; transactions are required");
  }
  await withTransaction((session) => mongoose.connection.db.collection("meta").findOne({ _id: "schema" }, { session }));
}

module.exports = { assertTransactionsSupported, withTransaction };
