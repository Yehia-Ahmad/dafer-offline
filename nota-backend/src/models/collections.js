// Stage 25: the MongoDB collection names of the models the desktop app reads WITHOUT mongoose (main process: diagnostics, backup status). The models
// are declared with these names, and a backend test checks that each model's real collection name is the one listed here, so a name can never drift.
module.exports = Object.freeze({
  META: "metas",
  AUDIT_LOG: "auditlogs",
  DEVICE: "devices",
});
