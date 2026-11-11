const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const asyncHandler = require("../utils/asyncHandler");
const User = require("../models/user.model");
const ShopProfile = require("../models/shopProfile.model");
const { ALL_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS, ROLES, ROLE_LABELS, effectivePermissions, permissionsForRole } = require("../auth/permissions");
const { signToken } = require("../auth/jwt");
const { createLoginLimiter } = require("../auth/loginLimiter");
const { audit } = require("../auth/audit");
const { httpError, isLoopback } = require("../auth/middleware");
const { getLockedThrough, isoDay } = require("../accounting/period");

// Stage 22: the posting forms disable locked dates. The lock date rides on the responses the screen already asks for (login, /me,
// refresh), only while a period is closed, so nothing else changes and no extra request is needed.
const lockInfo = async () => {
  const locked = await getLockedThrough();
  return locked ? { lockedThrough: isoDay(locked) } : {};
};

const SHOP_PROFILE_KEY = "default"; // the single ShopProfile document (shopProfile.controller.js)

// No 0/O or 1/I (same alphabet as the LAN secret in electron-offline/lib/setup-controller.js).
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 4;

const generateRecoveryCode = () =>
  Array.from({ length: RECOVERY_GROUPS }, () =>
    Array.from({ length: RECOVERY_GROUP_LENGTH }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join("")
  ).join("-");

/** "abcd efgh-ijkl mnop" → "ABCD-EFGH-IJKL-MNOP"; anything that is not 16 letters/digits → "". */
const canonicalRecoveryCode = (value) => {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH) return "";
  return compact.match(new RegExp(`.{${RECOVERY_GROUP_LENGTH}}`, "g")).join("-");
};

const INVALID_CREDENTIALS_MESSAGE = "اسم الدخول أو كلمة المرور غير صحيحة";
const invalidCredentials = () => httpError(401, "INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
const invalidRecovery = () => httpError(401, "INVALID_RECOVERY", "اسم الدخول أو رمز الاستعادة غير صحيح");
const locked = (ms) => {
  const error = httpError(429, "LOGIN_LOCKED", `محاولات كثيرة غير صحيحة. حاول مرة أخرى بعد ${Math.max(1, Math.ceil(ms / 60000))} دقائق`);
  error.responseData.retryAfterSeconds = Math.ceil(ms / 1000);
  return error;
};
const badRequest = (code, message) => httpError(400, code, message);

/** The user as the API shows it: no secrets; permissions = what the user may actually do. */
const presentUser = (user) => ({
  ...user.toJSON(),
  permissions: effectivePermissions(user),
  permissionsEdited: user.role === "owner" || user.role === "custom" ? false : Boolean(user.permissionsEdited),
});

const normalizeUsername = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const normalizeName = (value) => (typeof value === "string" ? value.trim() : "");

const validateName = (name) => {
  if (!name) throw badRequest("VALIDATION_ERROR", "الاسم مطلوب");
  if (name.length > 100) throw badRequest("VALIDATION_ERROR", "يجب ألا يزيد الاسم عن 100 حرف");
};

const validateUsername = (username) => {
  if (!username) throw badRequest("VALIDATION_ERROR", "اسم الدخول مطلوب");
  if (username.length > 50) throw badRequest("VALIDATION_ERROR", "يجب ألا يزيد اسم الدخول عن 50 حرفًا");
  if (/\s/.test(username)) throw badRequest("VALIDATION_ERROR", "اسم الدخول لا يمكن أن يحتوي على مسافات");
};

const validatePassword = (password) => {
  const problem = User.passwordProblem(password);
  if (problem) throw badRequest("PASSWORD_INVALID", problem);
};

// Compared against when the username does not exist, so a wrong username takes as long as a wrong password.
let dummyHash = null;
const getDummyHash = () => {
  if (!dummyHash) dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), User.BCRYPT_COST);
  return dummyHash;
};

const isDuplicateKey = (error) => error && error.code === 11000;

function createAuthController({ secret, now = () => Date.now() } = {}) {
  const loginLimiter = createLoginLimiter({ now });
  const recoverLimiter = createLoginLimiter({ now });
  const issue = (user) => signToken(user, secret);

  const bootstrap = asyncHandler(async (req, res) => {
    const [owner, profile] = await Promise.all([
      User.exists({ role: "owner" }),
      ShopProfile.findOne({ key: SHOP_PROFILE_KEY }, "name logo").lean(),
    ]);
    // Stage 14: isLocal tells the login screen whether it runs on the main PC (owner setup, recover).
    res.json({
      hasOwner: Boolean(owner),
      isLocal: isLoopback(req),
      shop: { name: profile?.name || "", logo: profile?.logo || "" },
    });
  });

  const setupOwner = asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (await User.exists({})) throw httpError(409, "OWNER_EXISTS", "تم إنشاء حساب المالك بالفعل");
    const name = normalizeName(body.name);
    const username = normalizeUsername(body.username);
    validateName(name);
    validateUsername(username);
    validatePassword(body.password);

    const recoveryCode = generateRecoveryCode();
    let owner;
    try {
      owner = await User.create({
        name,
        username,
        role: "owner",
        passwordHash: await User.hashSecret(body.password),
        recoveryCodeHash: await User.hashSecret(recoveryCode),
      });
    } catch (error) {
      // Two setup requests racing: the one_owner (or username) unique index lets only one through.
      if (isDuplicateKey(error)) throw httpError(409, "OWNER_EXISTS", "تم إنشاء حساب المالك بالفعل");
      throw error;
    }
    await audit(req, { action: "auth.setup_owner", entity: "User", entityId: owner._id, user: owner });
    res.status(201).json({ user: presentUser(owner), token: issue(owner), recoveryCode, permissions: effectivePermissions(owner) });
  });

  const login = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const username = normalizeUsername(body.username);
    const lockedMs = loginLimiter.lockedFor(username, req.ip);
    if (lockedMs > 0) throw locked(lockedMs);

    const user = username ? await User.findOne({ username }) : null;
    const passwordOk = await User.compareSecret(String(body.password ?? ""), user ? user.passwordHash : getDummyHash());
    if (!user || !passwordOk || !user.isActive) {
      const nowLocked = loginLimiter.fail(username, req.ip);
      await audit(req, { action: "auth.login_failed", entity: "User", details: { username } });
      if (nowLocked) {
        await audit(req, { action: "auth.locked", entity: "User", details: { username } });
        throw locked(loginLimiter.lockedFor(username, req.ip));
      }
      throw invalidCredentials();
    }

    loginLimiter.succeed(username, req.ip);
    user.lastLoginAt = new Date(now());
    await user.save();
    await audit(req, { action: "auth.login", entity: "User", entityId: user._id, user });
    res.json({ user: presentUser(user), token: issue(user), permissions: effectivePermissions(user), ...(await lockInfo()) });
  });

  const me = asyncHandler(async (req, res) => {
    res.json({ user: presentUser(req.user), permissions: effectivePermissions(req.user), ...(await lockInfo()) });
  });

  const changePassword = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const user = req.user;
    if (!(await User.compareSecret(String(body.currentPassword ?? ""), user.passwordHash))) {
      throw badRequest("WRONG_PASSWORD", "كلمة المرور الحالية غير صحيحة");
    }
    validatePassword(body.newPassword);
    user.passwordHash = await User.hashSecret(body.newPassword);
    user.tokenVersion = Number(user.tokenVersion || 0) + 1; // other sessions end now
    await user.save();
    await audit(req, { action: "auth.password_changed", entity: "User", entityId: user._id });
    res.json({ user: presentUser(user), token: issue(user), permissions: effectivePermissions(user) });
  });

  // Stage 15: the lock screen (and the desktop app before a restore) asks the signed-in user for
  // their password again. Same lockout as login (per username + IP, in memory). 204 when right;
  // 400 WRONG_PASSWORD (not 401: the session itself is fine) or 429 LOGIN_LOCKED. The token is
  // not changed.
  const verifyPassword = asyncHandler(async (req, res) => {
    const user = req.user;
    const lockedMs = loginLimiter.lockedFor(user.username, req.ip);
    if (lockedMs > 0) throw locked(lockedMs);
    const password = (req.body || {}).password;
    if (!(await User.compareSecret(String(password ?? ""), user.passwordHash))) {
      const nowLocked = loginLimiter.fail(user.username, req.ip);
      await audit(req, { action: "auth.unlock_failed", entity: "User", entityId: user._id });
      if (nowLocked) {
        await audit(req, { action: "auth.locked", entity: "User", details: { username: user.username, flow: "verify-password" } });
        throw locked(loginLimiter.lockedFor(user.username, req.ip));
      }
      throw badRequest("WRONG_PASSWORD", "كلمة المرور غير صحيحة");
    }
    loginLimiter.succeed(user.username, req.ip);
    res.status(204).end();
  });

  // Stage 15: a new 12-hour token for the same user and tokenVersion. requireAuth already refused
  // an expired, wrongly signed or outdated (old tokenVersion, disabled user) token.
  const refresh = asyncHandler(async (req, res) => {
    res.json({ user: presentUser(req.user), token: issue(req.user), permissions: effectivePermissions(req.user), ...(await lockInfo()) });
  });

  const recover = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const username = normalizeUsername(body.username);
    const lockedMs = recoverLimiter.lockedFor(username, req.ip);
    if (lockedMs > 0) throw locked(lockedMs);
    validatePassword(body.newPassword);

    const owner = username ? await User.findOne({ username, role: "owner" }) : null;
    const code = canonicalRecoveryCode(body.recoveryCode);
    const codeOk = await User.compareSecret(code || "-", owner && owner.recoveryCodeHash ? owner.recoveryCodeHash : getDummyHash());
    if (!owner || !code || !codeOk) {
      const nowLocked = recoverLimiter.fail(username, req.ip);
      await audit(req, { action: "auth.recover_failed", entity: "User", details: { username } });
      if (nowLocked) {
        await audit(req, { action: "auth.locked", entity: "User", details: { username, flow: "recover" } });
        throw locked(recoverLimiter.lockedFor(username, req.ip));
      }
      throw invalidRecovery();
    }

    recoverLimiter.succeed(username, req.ip);
    loginLimiter.clearUsername(username); // the owner proved who they are: unlock login on every PC
    const recoveryCode = generateRecoveryCode(); // the old code stops working
    owner.passwordHash = await User.hashSecret(body.newPassword);
    owner.recoveryCodeHash = await User.hashSecret(recoveryCode);
    owner.tokenVersion = Number(owner.tokenVersion || 0) + 1;
    await owner.save();
    await audit(req, { action: "auth.recover", entity: "User", entityId: owner._id, user: owner });
    res.json({ user: presentUser(owner), token: issue(owner), recoveryCode, permissions: effectivePermissions(owner) });
  });

  const permissionsCatalog = asyncHandler(async (_req, res) => {
    res.json({
      permissions: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSIONS[key] })),
      groups: PERMISSION_GROUPS,
      roles: ROLES.map((role) => ({
        role,
        ...ROLE_LABELS[role],
        permissions: role === "custom" ? [] : permissionsForRole(role),
        editable: role !== "owner",
      })),
    });
  });

  return { bootstrap, setupOwner, login, me, changePassword, verifyPassword, refresh, recover, permissionsCatalog, loginLimiter, recoverLimiter };
}

module.exports = {
  canonicalRecoveryCode,
  createAuthController,
  generateRecoveryCode,
  presentUser,
  normalizeName,
  normalizeUsername,
  validateName,
  validatePassword,
  validateUsername,
  RECOVERY_ALPHABET,
};
