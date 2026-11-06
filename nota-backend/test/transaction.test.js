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

async function attemptsFor(error) {
  const originalStartSession = mongoose.startSession;
  let attempts = 0;
  mongoose.startSession = async () => ({
    startTransaction() {}, async commitTransaction() {}, inTransaction() { return true; },
    async abortTransaction() {}, async endSession() {},
  });
  try {
    await withTransaction(async () => { attempts += 1; if (attempts === 1) throw error; return "ok"; }, { maxRetries: 3 }).catch(() => {});
  } finally {
    mongoose.startSession = originalStartSession;
  }
  return attempts;
}

test("item 22: withTransaction retries on the TransientTransactionError label and on code 112 WriteConflict", async () => {
  const labelled = new Error("anything"); labelled.hasErrorLabel = (label) => label === "TransientTransactionError";
  const labelArray = new Error("anything"); labelArray.errorLabels = ["TransientTransactionError"];
  const writeConflict = Object.assign(new Error("anything"), { code: 112 });
  assert.equal(await attemptsFor(labelled), 2);
  assert.equal(await attemptsFor(labelArray), 2);
  assert.equal(await attemptsFor(writeConflict), 2);
});

test("item 22: withTransaction does not retry on message text alone", async () => {
  assert.equal(await attemptsFor(new Error("WriteConflict: Please retry your operation TransientTransactionError")), 1);
  assert.equal(await attemptsFor(Object.assign(new Error("dup"), { code: 11000 })), 1);
});

test("item 22: commit is retried on the UnknownTransactionCommitResult label only", async () => {
  const originalStartSession = mongoose.startSession;
  let commits = 0;
  const textOnly = new Error("UnknownTransactionCommitResult");
  mongoose.startSession = async () => ({
    startTransaction() {}, async commitTransaction() { commits += 1; throw textOnly; },
    inTransaction() { return true; }, async abortTransaction() {}, async endSession() {},
  });
  try {
    await assert.rejects(withTransaction(async () => "value", { maxRetries: 1 }), /UnknownTransactionCommitResult/);
    assert.equal(commits, 1);
  } finally {
    mongoose.startSession = originalStartSession;
  }
});

test("killAllSessions is limited to LAN mode with a loopback MongoDB", () => {
  assert.equal(isDesktopMongo({ NOTA_LAN_MODE: "1", MONGO_URI: "mongodb://127.0.0.1:27099/nota" }), true);
  assert.equal(isDesktopMongo({ NOTA_LAN_MODE: "", MONGO_URI: "mongodb://127.0.0.1:27099/nota" }), false);
  assert.equal(isDesktopMongo({ NOTA_LAN_MODE: "1", MONGO_URI: "mongodb+srv://cluster.example/nota" }), false);
});
