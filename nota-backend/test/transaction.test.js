const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { withTransaction } = require("../src/utils/transaction");
const { isDesktopMongo } = require("../src/migrations");

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

test("killAllSessions is limited to LAN mode with a loopback MongoDB", () => {
  assert.equal(isDesktopMongo({ NOTA_LAN_MODE: "1", MONGO_URI: "mongodb://127.0.0.1:27099/nota" }), true);
  assert.equal(isDesktopMongo({ NOTA_LAN_MODE: "", MONGO_URI: "mongodb://127.0.0.1:27099/nota" }), false);
  assert.equal(isDesktopMongo({ NOTA_LAN_MODE: "1", MONGO_URI: "mongodb+srv://cluster.example/nota" }), false);
});
