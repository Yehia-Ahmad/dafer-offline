// Server CLI (nota-meta-sync): the daily Meta ad account sync, started by the nota-meta-sync systemd timer at 06:15 (Cairo).
// Re-syncs the last 7 days. `--backfill` reads the last 90 days. Read-only toward Meta; a Mongo lease keeps it from overlapping
// with another sync (the «مزامنة دلوقتي» button). Exit code 0 also when there is nothing to do (not connected, paused, busy).
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { runSync } = require("../src/services/meta/metaSync.service");

(async () => {
  const mode = process.argv.includes("--backfill") ? "backfill" : "daily";
  await connectDB();
  const result = await runSync({ mode });
  // Only fixed codes are printed: never a token, a URL or Meta's own text.
  console.log(`nota-meta-sync: ${result.status}${result.reason ? ` (${result.reason})` : ""}${result.code ? ` (${result.code})` : ""}${result.rows !== undefined ? `, ${result.rows} rows` : ""}`);
  // A failed run is recorded on the connection and shown in the app; the unit itself still succeeds.
})()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(`nota-meta-sync failed: ${error && error.name ? error.name : "error"}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
