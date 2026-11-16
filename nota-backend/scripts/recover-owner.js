// Server CLI: reset a lost owner password (npm run recover-owner).
// Asks for the new password on the terminal, prints a new recovery code once, ends every session.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { recoverOwner } = require("../src/auth/ownerAccount");
const { askNewPassword } = require("./lib/cli");

(async () => {
  const password = await askNewPassword();
  await connectDB();
  const { owner, recoveryCode } = await recoverOwner({ password });
  console.log(`\nPassword of owner "${owner.username}" changed. All sessions ended.`);
  console.log(`New recovery code (shown once, keep it safe): ${recoveryCode}`);
})()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(`recover-owner failed: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
