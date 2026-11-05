const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { withTransaction } = require("../src/utils/transaction");

test("withTransaction caps UnknownTransactionCommitResult retries", async () => {
  const originalStartSession = mongoose.startSession;
  let commits = 0;
  const unknownCommit = new Error("commit result unknown");
  unknownCommit.hasErrorLabel = (label) => label === "UnknownTransactionCommitResult";
  const session = {
    startTransaction() {},
    async commitTransaction() { commits += 1; throw unknownCommit; },
    inTransaction() { return true; },
    async abortTransaction() {},
    async endSession() {},
  };
  mongoose.startSession = async () => session;
  try {
    await assert.rejects(
      withTransaction(async () => "value", { maxCommitRetries: 5 }),
      /commit result unknown/
    );
    assert.equal(commits, 5);
  } finally {
    mongoose.startSession = originalStartSession;
  }
});
