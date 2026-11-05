const asyncHandler = require("../utils/asyncHandler");
const User = require("../models/user.model");
const { ROLES, effectivePermissions, isValidPermission, normalizePermissionList, permissionsForRole, sameList } = require("../auth/permissions");
const { audit } = require("../auth/audit");
const { httpError } = require("../auth/middleware");
const { normalizeName, normalizeUsername, presentUser, validateName, validatePassword, validateUsername } = require("./auth.controller");

// Stage 13: /api/users (all routes need users.manage). There is no DELETE route: users are
// disabled instead, so createdBy on invoices keeps pointing at a real account.

const ownerProtected = (message = "لا يمكن تغيير حساب المالك بهذه الطريقة") => httpError(403, "OWNER_PROTECTED", message);
const notHeld = (keys) => {
  const error = httpError(403, "PERMISSION_NOT_HELD", "لا يمكنك منح صلاحية لا تملكها");
  error.responseData.permissions = keys;
  return error;
};
const cannotChangeSelf = (message) => httpError(400, "CANNOT_CHANGE_SELF", message);
const usernameTaken = () => httpError(409, "USERNAME_TAKEN", "اسم الدخول مستخدم بالفعل");
const notFound = () => httpError(404, "USER_NOT_FOUND", "المستخدم غير موجود");
const badRequest = (message) => httpError(400, "VALIDATION_ERROR", message);

const isOwner = (user) => user.role === "owner";
const sameUser = (left, right) => String(left._id) === String(right._id);

/**
 * Stage 15: maxDiscountPercent from the body. undefined = not sent; null = no limit; else a number
 * 0–100 (2 decimals). Never stored for the owner (no limit).
 */
const parseMaxDiscount = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const number = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(number) || number < 0 || number > 100) {
    throw badRequest("أقصى خصم يجب أن يكون رقمًا بين 0 و 100");
  }
  return Math.round(number * 100) / 100;
};

/**
 * A non-owner with users.manage cannot change their own limit, and cannot give anyone a higher
 * limit (or no limit) than their own when they have one.
 */
const assertCanSetLimit = (actor, target, limit) => {
  if (isOwner(actor)) return;
  if (sameUser(actor, target)) throw cannotChangeSelf("لا يمكنك تعديل أقصى خصم لحسابك");
  const own = typeof actor.maxDiscountPercent === "number" ? actor.maxDiscountPercent : null;
  if (own !== null && (limit === null || limit > own)) throw notHeld(["sales.discount"]);
};

const currentLimit = (user) => (typeof user.maxDiscountPercent === "number" ? user.maxDiscountPercent : null);

const loadTarget = async (id) => {
  const user = await User.findById(id);
  if (!user) throw notFound();
  return user;
};

/**
 * Role + permissions → what to store. Template roles keep permissionsEdited=false (and an empty
 * stored list) unless the given list differs from the template; custom stores its list as is.
 */
const resolveAccess = (role, permissions) => {
  if (!ROLES.includes(role) || role === "owner") throw badRequest("الدور غير صالح");
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || !permissions.every((key) => typeof key === "string" && isValidPermission(key))) {
      throw badRequest("توجد صلاحية غير معروفة");
    }
  }
  if (role === "custom") return { role, permissions: normalizePermissionList(permissions), permissionsEdited: false };
  if (permissions === undefined || sameList(permissions, permissionsForRole(role))) {
    return { role, permissions: [], permissionsEdited: false };
  }
  return { role, permissions: normalizePermissionList(permissions), permissionsEdited: true };
};

/** A non-owner may only grant permissions they hold themselves. */
const assertCanGrant = (actor, before, after) => {
  if (isOwner(actor)) return;
  const held = new Set(effectivePermissions(actor));
  const added = after.filter((key) => !before.includes(key));
  const missing = added.filter((key) => !held.has(key));
  if (missing.length > 0) throw notHeld(missing);
};

const listUsers = asyncHandler(async (_req, res) => {
  const users = await User.find({}).sort({ createdAt: 1, _id: 1 });
  res.json({ users: users.map(presentUser) });
});

const getUser = asyncHandler(async (req, res) => {
  res.json({ user: presentUser(await loadTarget(req.params.id)) });
});

const createUser = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (body.role === "owner") throw ownerProtected("لا يمكن إنشاء مالك ثانٍ");
  const name = normalizeName(body.name);
  const username = normalizeUsername(body.username);
  validateName(name);
  validateUsername(username);
  validatePassword(body.password);
  const access = resolveAccess(body.role, body.permissions);
  assertCanGrant(req.user, [], effectivePermissions(access));
  const maxDiscount = parseMaxDiscount(body.maxDiscountPercent);
  if (effectivePermissions(access).includes("sales.discount")) assertCanSetLimit(req.user, { _id: null }, maxDiscount ?? null);
  if (await User.exists({ username })) throw usernameTaken();

  let user;
  try {
    user = await User.create({
      name,
      username,
      passwordHash: await User.hashSecret(body.password),
      ...access,
      ...(maxDiscount !== undefined && maxDiscount !== null ? { maxDiscountPercent: maxDiscount } : {}),
    });
  } catch (error) {
    if (error && error.code === 11000) throw usernameTaken();
    throw error;
  }
  await audit(req, { action: "user.created", entity: "User", entityId: user._id, details: { username, role: user.role } });
  res.status(201).json({ user: presentUser(user) });
});

const updateUser = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const target = await loadTarget(req.params.id);
  const changes = [];

  if (isOwner(target)) {
    // Only the owner edits the owner, and only the name: the owner's role and permissions are fixed.
    if (!isOwner(req.user)) throw ownerProtected("فقط المالك يمكنه تعديل حساب المالك");
    if ((body.role !== undefined && body.role !== "owner") || body.permissions !== undefined) {
      throw ownerProtected("دور المالك وصلاحياته ثابتة");
    }
  } else if (body.role === "owner") {
    throw ownerProtected("لا يمكن تحويل مستخدم إلى مالك");
  }

  if (body.name !== undefined) {
    const name = normalizeName(body.name);
    validateName(name);
    if (name !== target.name) {
      target.name = name;
      changes.push("name");
    }
  }

  if (!isOwner(target) && (body.role !== undefined || body.permissions !== undefined)) {
    const before = effectivePermissions(target);
    const access = resolveAccess(body.role !== undefined ? body.role : target.role, body.permissions);
    const after = effectivePermissions(access);
    if (sameUser(req.user, target) && !after.includes("users.manage")) {
      throw cannotChangeSelf("لا يمكنك إزالة صلاحية إدارة المستخدمين من حسابك");
    }
    assertCanGrant(req.user, before, after);
    const roleChanged = access.role !== target.role;
    const accessChanged = roleChanged || !sameList(before, after) || access.permissionsEdited !== Boolean(target.permissionsEdited);
    if (accessChanged) {
      target.role = access.role;
      target.permissions = access.permissions;
      target.permissionsEdited = access.permissionsEdited;
      target.tokenVersion = Number(target.tokenVersion || 0) + 1; // the user is logged out now
      changes.push(roleChanged ? "role" : "permissions");
    }
  }

  // Stage 15: the discount limit. Read on every request by the discount check, so no logout needed.
  const maxDiscount = isOwner(target) ? undefined : parseMaxDiscount(body.maxDiscountPercent);
  if (maxDiscount !== undefined && maxDiscount !== currentLimit(target)) {
    assertCanSetLimit(req.user, target, maxDiscount);
    target.maxDiscountPercent = maxDiscount === null ? undefined : maxDiscount;
    changes.push("maxDiscountPercent");
  }

  if (changes.length > 0) {
    await target.save();
    await audit(req, { action: "user.updated", entity: "User", entityId: target._id, details: { changes, role: target.role } });
  }
  res.json({ user: presentUser(target) });
});

const setUserStatus = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (typeof body.isActive !== "boolean") throw badRequest("قيمة الحالة يجب أن تكون true أو false");
  const target = await loadTarget(req.params.id);
  if (isOwner(target) && !isOwner(req.user)) throw ownerProtected("فقط المالك يمكنه تعديل حساب المالك");
  if (isOwner(target) && body.isActive === false) throw ownerProtected("لا يمكن إيقاف حساب المالك");
  if (sameUser(req.user, target) && body.isActive === false) throw cannotChangeSelf("لا يمكنك إيقاف حسابك");

  if (target.isActive !== body.isActive) {
    target.isActive = body.isActive;
    if (!body.isActive) target.tokenVersion = Number(target.tokenVersion || 0) + 1; // logged out now
    await target.save();
    await audit(req, { action: "user.status_changed", entity: "User", entityId: target._id, details: { isActive: target.isActive } });
  }
  res.json({ user: presentUser(target) });
});

const resetUserPassword = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const target = await loadTarget(req.params.id);
  // Your own password changes only through /api/auth/change-password, which needs the current one.
  if (sameUser(req.user, target)) {
    throw cannotChangeSelf("لتغيير كلمة مرورك استخدم تغيير كلمة المرور (يلزم إدخال كلمة المرور الحالية)");
  }
  if (isOwner(target) && !isOwner(req.user)) throw ownerProtected("فقط المالك يمكنه تغيير كلمة مرور المالك");
  validatePassword(body.newPassword);
  target.passwordHash = await User.hashSecret(body.newPassword);
  target.tokenVersion = Number(target.tokenVersion || 0) + 1; // logged out now
  await target.save();
  await audit(req, { action: "user.password_reset", entity: "User", entityId: target._id });
  res.json({ user: presentUser(target) });
});

module.exports = { createUser, getUser, listUsers, resetUserPassword, setUserStatus, updateUser };
