// Stage 13 enforcement. Everything here is a pass-through unless the app was loaded with
// NOTA_AUTH=1; app.js marks each request with req.authEnabled.
const mongoose = require("mongoose");
const User = require("../models/user.model");
const { hasPermission } = require("./permissions");
const { bearerToken, verifyToken } = require("./jwt");
const { runWithUser } = require("./context");

const PERMISSION_TAG = Symbol.for("nota.permission");
const PUBLIC = "PUBLIC";
const AUTHENTICATED = "AUTHENTICATED";

const SESSION_EXPIRED = "SESSION_EXPIRED";
const FORBIDDEN = "FORBIDDEN";

const httpError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code };
  return error;
};

const sessionExpired = () => httpError(401, SESSION_EXPIRED, "انتهت الجلسة. سجّل الدخول مرة أخرى");
const forbidden = () => httpError(403, FORBIDDEN, "ليست لديك صلاحية للقيام بهذه العملية");

// Paths under /api that need no login (relative to the /api mount).
const PUBLIC_PATHS = new Set(["/auth/bootstrap", "/auth/login", "/auth/setup-owner", "/auth/recover"]);
const isPublicPath = (path) => path === "/lan" || path.startsWith("/lan/") || PUBLIC_PATHS.has(path);

/** Marks requests of this app as auth-enabled or not (captured once, when app.js is loaded). */
const authFlag = (enabled) => (req, _res, next) => {
  req.authEnabled = enabled;
  next();
};

/**
 * Mounted on /api after the LAN guard. Loads the user of the Bearer token on every request and
 * rejects a missing, disabled or outdated session (tv !== tokenVersion) with 401 SESSION_EXPIRED.
 */
const requireAuth = (secret) => async (req, _res, next) => {
  if (req.method === "OPTIONS" || isPublicPath(req.path)) return next();
  try {
    const payload = verifyToken(bearerToken(req), secret);
    if (!payload || !mongoose.Types.ObjectId.isValid(payload.sub)) return next(sessionExpired());
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive || payload.tv !== Number(user.tokenVersion || 0)) return next(sessionExpired());
    req.user = user;
    return runWithUser(user, () => next());
  } catch (error) {
    return next(error);
  }
};

const tag = (handler, value) => {
  handler[PERMISSION_TAG] = value;
  return handler;
};

/** 403 FORBIDDEN unless the signed-in user has every key. No-op when auth is off. */
const requirePermission = (...keys) =>
  tag((req, _res, next) => {
    if (!req.authEnabled) return next();
    if (!req.user) return next(sessionExpired());
    return keys.every((key) => hasPermission(req.user, key)) ? next() : next(forbidden());
  }, keys);

/** Any signed-in user (no specific permission). */
const requireLogin = () =>
  tag((req, _res, next) => {
    if (!req.authEnabled || req.user) return next();
    return next(sessionExpired());
  }, AUTHENTICATED);

/**
 * Stage 14: did this request come from the main PC itself? The desktop app's own window calls the
 * backend on 127.0.0.1; client PCs use the LAN address. There is no "trust proxy", so req.ip is
 * the socket address.
 */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const isLoopback = (req) => LOOPBACK_ADDRESSES.has(String(req.ip || ""));

/** Stage 14: 403 LOCAL_ONLY unless the request came over loopback (setup-owner, recover). */
const localOnly = () => (req, _res, next) =>
  isLoopback(req)
    ? next()
    : next(httpError(403, "LOCAL_ONLY", "العملية دي متاحة على الجهاز الرئيسي بس"));

/** No login (the exempt list in requireAuth). Only a marker for the route-coverage test. */
const publicRoute = () => tag((_req, _res, next) => next(), PUBLIC);

/**
 * May this request sell (or edit an invoice to) below purchase price? Only with NOTA_AUTH=1 and
 * sales.priceBelowCost. With auth off: never, so the sale stays blocked for everyone as before.
 */
const canSellBelowCost = (req) =>
  Boolean(req && req.authEnabled && req.user && hasPermission(req.user, "sales.priceBelowCost"));

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
};

const given = (value) => value !== undefined && value !== null && value !== "";
const money = (value) => Number(Number(value || 0).toFixed(2));
const sameMoney = (left, right) => Math.abs(money(left) - money(right)) < 0.011;

// The subtotal the edit will be priced on: the sent items, or the stored ones when none are sent.
// null when it cannot be known here (the single-item price/quantity shortcut).
const editSubtotal = (body, stored) => {
  if (Array.isArray(body.items)) {
    return money(body.items.reduce((sum, item) => sum + money(Number(item.price ?? item.unitPrice ?? 0) * Number(item.quantity ?? 0)), 0));
  }
  if (given(body.price) || given(body.quantity)) return null;
  return money((stored.items || []).reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));
};

/**
 * sales.discount (cash and credit), checked against what the user controls. The server applies an
 * invoice discount only from `discountAmount`; a sent `discountPercentage` is never used by it.
 * - New invoice: needed for any discount (discountAmount or discountPercentage > 0).
 * - Edit: never needed to keep the stored discount unchanged or to remove it (0). Otherwise:
 *   - stored invoice uses a percentage (legacy records: no discountAmount, discountPercentage > 0):
 *     needed when the sent percentage differs; with the same (or no) percentage, a sent
 *     discountAmount must be that percentage of the new subtotal (recomputed, e.g. after a quantity
 *     change), else it is a new discount and needs the permission;
 *   - stored invoice uses an amount: needed when the sent discountAmount differs from the stored one.
 * Item prices are not judged here (they stay bounded by the below-cost rule).
 */
const requireDiscountPermission = (Model) => async (req, _res, next) => {
  if (!req.authEnabled || hasPermission(req.user, "sales.discount")) return next();
  const body = req.body || {};
  if (req.method === "POST") {
    return positive(body.discountAmount) || positive(body.discountPercentage) ? next(forbidden()) : next();
  }
  if (!positive(body.discountAmount) && !positive(body.discountPercentage)) return next(); // none, or removed
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next();
    const stored = await Model.findById(req.params.id, "discountAmount discountPercentage items.totalPrice").lean();
    if (!stored) return next(); // the controller answers 404

    const storedPercentage = Number(stored.discountPercentage || 0);
    const usesPercentage = !given(stored.discountAmount) && storedPercentage > 0;

    if (usesPercentage) {
      if (given(body.discountPercentage) && Number(body.discountPercentage) !== storedPercentage) return next(forbidden());
      if (!positive(body.discountAmount)) return next(); // the server recomputes from the stored percentage
      const subtotal = editSubtotal(body, stored);
      const recomputed = subtotal === null ? null : money((subtotal * storedPercentage) / 100);
      return recomputed !== null && sameMoney(body.discountAmount, recomputed) ? next() : next(forbidden());
    }

    if (!positive(body.discountAmount)) return next(); // the stored amount is kept (a percentage alone is ignored)
    return sameMoney(body.discountAmount, stored.discountAmount) ? next() : next(forbidden());
  } catch (error) {
    return next(error);
  }
};

// Purchase price and profit, removed from every JSON response for users without products.viewCost.
const COST_FIELDS = new Set(["purchasePrice", "profitAmount", "totalProfit", "profitValue", "profit"]);

const stripCost = (value) => {
  if (Array.isArray(value)) return value.map(stripCost);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!COST_FIELDS.has(key)) out[key] = stripCost(item);
    }
    return out;
  }
  return value;
};

/** The single response helper for cost stripping (mounted after requireAuth). */
const costStrip = () => (req, res, next) => {
  if (!req.authEnabled || !req.user || hasPermission(req.user, "products.viewCost")) return next();
  const originalJson = res.json.bind(res);
  // JSON round-trip first, so Mongoose documents go through their toJSON like they would anyway.
  res.json = (body) => originalJson(body === undefined ? body : stripCost(JSON.parse(JSON.stringify(body))));
  return next();
};

module.exports = {
  AUTHENTICATED,
  COST_FIELDS,
  FORBIDDEN,
  PERMISSION_TAG,
  PUBLIC,
  SESSION_EXPIRED,
  authFlag,
  canSellBelowCost,
  costStrip,
  forbidden,
  httpError,
  isLoopback,
  isPublicPath,
  localOnly,
  publicRoute,
  requireAuth,
  requireDiscountPermission,
  requireLogin,
  requirePermission,
  sessionExpired,
  stripCost,
};
