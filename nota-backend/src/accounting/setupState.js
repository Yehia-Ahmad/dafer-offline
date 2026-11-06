const Meta = require("../models/meta.model");

// Stage 18: the end of setup mode is a write, not a scan.
//
// The first sale, credit sale, return or receipt writes meta.opening.setupEndedAt
// inside its own transaction. A setup-mode stock posting writes
// meta.opening.lastSetupPostingAt inside its transaction. Both write the same meta
// document, so two such transactions that overlap conflict and one of them retries:
// the retried stock posting then sees setupEndedAt and posts to INVENTORY_ADJUSTMENT.

/** Called inside the transaction of every first sale/credit sale/return/receipt. A no-op once set. */
const markSetupEnded = (session) => Meta.updateOne(
  { _id: "schema", ledgerStartAt: { $exists: true }, "opening.setupEndedAt": { $exists: false }, "opening.status": { $ne: "finalized" } },
  { $set: { "opening.setupEndedAt": new Date() } },
  { session: session || null },
);

/** Called inside the transaction of every setup-mode stock posting (forces the conflict described above). */
const touchSetupPosting = (session) => Meta.updateOne(
  { _id: "schema" },
  { $set: { "opening.lastSetupPostingAt": new Date() } },
  { session: session || null },
);

/** Mongoose plugin: a newly created document of this model ends setup mode. */
const endsSetupModePlugin = (schema) => {
  schema.pre("save", async function endSetupMode() {
    if (this.isNew) await markSetupEnded(this.$session());
  });
};

module.exports = { markSetupEnded, touchSetupPosting, endsSetupModePlugin };
