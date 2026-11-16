// Creating and recovering the owner account. Used by the server-side CLI scripts
// (scripts/create-owner.js, scripts/recover-owner.js) and by tests. There is no HTTP route for
// either: on a public server they would let anyone claim an empty shop or reset the owner.
const User = require("../models/user.model");
const AuditLog = require("../models/auditLog.model");
const {
  generateRecoveryCode,
  normalizeName,
  normalizeUsername,
  validateName,
  validatePassword,
  validateUsername,
} = require("../controllers/auth.controller");

const isDuplicateKey = (error) => error && error.code === 11000;

const ownerExistsError = () => {
  const error = new Error("An owner already exists. Use recover-owner if the password is lost.");
  error.code = "OWNER_EXISTS";
  return error;
};

const writeAudit = (action, user) =>
  AuditLog.create({ at: new Date(), userId: user._id, userName: user.name, action, entity: "User", entityId: String(user._id), details: { via: "cli" } });

/** Creates the owner. Refuses (code OWNER_EXISTS) when any user exists. Returns { owner, recoveryCode }. */
async function createOwner({ name, username, password }) {
  const cleanUsername = normalizeUsername(username);
  const cleanName = normalizeName(name) || cleanUsername;
  validateName(cleanName);
  validateUsername(cleanUsername);
  validatePassword(password);
  if (await User.exists({})) throw ownerExistsError();

  const recoveryCode = generateRecoveryCode();
  let owner;
  try {
    owner = await User.create({
      name: cleanName,
      username: cleanUsername,
      role: "owner",
      passwordHash: await User.hashSecret(password),
      recoveryCodeHash: await User.hashSecret(recoveryCode),
    });
  } catch (error) {
    // Two creations racing: the one_owner (or username) unique index lets only one through.
    if (isDuplicateKey(error)) throw ownerExistsError();
    throw error;
  }
  await writeAudit("auth.setup_owner", owner);
  return { owner, recoveryCode };
}

/** Sets a new owner password, rotates the recovery code and ends every session. Returns { owner, recoveryCode }. */
async function recoverOwner({ password }) {
  validatePassword(password);
  const owner = await User.findOne({ role: "owner" });
  if (!owner) {
    const error = new Error("There is no owner yet. Use create-owner.");
    error.code = "NO_OWNER";
    throw error;
  }
  const recoveryCode = generateRecoveryCode(); // the old code stops working
  owner.passwordHash = await User.hashSecret(password);
  owner.recoveryCodeHash = await User.hashSecret(recoveryCode);
  owner.tokenVersion = Number(owner.tokenVersion || 0) + 1;
  await owner.save();
  await writeAudit("auth.recover", owner);
  return { owner, recoveryCode };
}

module.exports = { createOwner, recoverOwner };
