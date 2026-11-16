// Server CLI: create the owner account (npm run create-owner -- --username <name> [--name "<Full name>"]).
// Asks for the password on the terminal and prints the recovery code once. Refuses if an owner exists.
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { createOwner } = require("../src/auth/ownerAccount");
const { parseArgs, askNewPassword } = require("./lib/cli");

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.username) {
    console.error('Usage: npm run create-owner -- --username <username> [--name "<Full name>"]');
    process.exit(1);
  }
  const password = await askNewPassword();
  await connectDB();
  const { owner, recoveryCode } = await createOwner({ name: args.name, username: args.username, password });
  console.log(`\nOwner "${owner.username}" created.`);
  console.log(`Recovery code (shown once, keep it safe): ${recoveryCode}`);
})()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(`create-owner failed: ${error.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
