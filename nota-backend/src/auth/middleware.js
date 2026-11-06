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
// Stage 15: a backup was restored on the main PC after this token was issued.
const DATA_RESTORED = "DATA_RESTORED";
const sessionEndedByRestore = () => {
  const error = httpError(401, SESSION_EXPIRED, "تم استرجاع النسخة. سجّل الدخول بحساب من النسخة المسترجعة");
  error.responseData.reason = DATA_RESTORED;
  return error;
};
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
 * Stage 15: `sessionsValidAfter` (ms, NOTA_SESSIONS_VALID_AFTER, set by the desktop app after a
 * restore): a token issued before it gets 401 SESSION_EXPIRED with reason DATA_RESTORED, on every PC.
 */
const requireAuth = (secret, { sessionsValidAfter = 0 } = {}) => async (req, _res, next) => {
  if (req.method === "OPTIONS" || isPublicPath(req.path)) return next();
  try {
    const payload = verifyToken(bearerToken(req), secret);
    if (!payload || !mongoose.Types.ObjectId.isValid(payload.sub)) return next(sessionExpired());
    if (sessionsValidAfter > 0 && Number(payload.iat || 0) * 1000 < sessionsValidAfter) return next(sessionEndedByRestore());
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

/**
 * Stage 19: 403 FORBIDDEN unless the signed-in user has AT LEAST ONE of the keys (a screen several roles
 * use, e.g. shifts: shift.operate or shift.manage). The handler decides what each role may see.
 * Tagged "a | b" for the route-coverage test. No-op when auth is off.
 */
const requireAnyPermission = (...keys) =>
  tag((req, _res, next) => {
    if (!req.authEnabled) return next();
    if (!req.user) return next(sessionExpired());
    return keys.some((key) => hasPermission(req.user, key)) ? next() : next(forbidden());
  }, [keys.join(" | ")]);

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

// The subtotal the invoice will be priced on: the sent items; a single-item price/quantity
// shortcut (on top of the stored item for edits); or the stored items when none are sent.
// null when it cannot be known here.
const requestSubtotal = (body, stored) => {
  if (Array.isArray(body.items)) {
    return money(body.items.reduce((sum, item) => sum + money(Number(item.price ?? item.unitPrice ?? 0) * Number(item.quantity ?? 0)), 0));
  }
  const items = (stored && stored.items) || [];
  if (given(body.price) || given(body.quantity)) {
    if (items.length > 1) return null;
    const current = items[0] || {};
    const price = given(body.price) ? body.price : current.unitPrice;
    const quantity = given(body.quantity) ? body.quantity : current.quantity;
    return given(price) && given(quantity) ? money(Number(price) * Number(quantity)) : null;
  }
  return money(items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));
};

/**
 * Does this request give a new or changed invoice discount (what sales.discount and the user's
 * maxDiscountPercent judge)? The server applies an invoice discount only from `discountAmount`;
 * a sent `discountPercentage` is never used by it.
 * - New invoice: any discount (discountAmount or discountPercentage > 0).
 * - Edit: keeping the stored discount unchanged or removing it (0) is not a new discount. Otherwise:
 *   - stored invoice uses a percentage (legacy records: no discountAmount, discountPercentage > 0):
 *     new when the sent percentage differs; with the same (or no) percentage, a sent
 *     discountAmount must be that percentage of the new subtotal (recomputed, e.g. after a quantity
 *     change), else it is new;
 *   - stored invoice uses an amount: new when the sent discountAmount differs from the stored one.
 * Item prices are not judged here (they stay bounded by the below-cost rule).
 * Returns { changed, subtotal } (subtotal: what the discount is a share of, or null).
 */
const discountDecision = async (req, Model) => {
  const body = req.body || {};
  if (req.method === "POST") {
    const changed = positive(body.discountAmount) || positive(body.discountPercentage);
    return { changed, subtotal: changed ? requestSubtotal(body, null) : null };
  }
  if (!positive(body.discountAmount) && !positive(body.discountPercentage)) return { changed: false }; // none, or removed
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return { changed: false };
  const stored = await Model.findById(req.params.id, "discountAmount discountPercentage items.totalPrice items.unitPrice items.quantity").lean();
  if (!stored) return { changed: false }; // the controller answers 404
  const subtotal = requestSubtotal(body, stored);

  const storedPercentage = Number(stored.discountPercentage || 0);
  const usesPercentage = !given(stored.discountAmount) && storedPercentage > 0;

  if (usesPercentage) {
    if (given(body.discountPercentage) && Number(body.discountPercentage) !== storedPercentage) return { changed: true, subtotal };
    if (!positive(body.discountAmount)) return { changed: false }; // the server recomputes from the stored percentage
    const recomputed = subtotal === null ? null : money((subtotal * storedPercentage) / 100);
    return { changed: !(recomputed !== null && sameMoney(body.discountAmount, recomputed)), subtotal };
  }

  if (!positive(body.discountAmount)) return { changed: false }; // the stored amount is kept (a percentage alone is ignored)
  return { changed: !sameMoney(body.discountAmount, stored.discountAmount), subtotal };
};

/** Stage 15: the user's discount limit in percent, or null (no limit; always none for the owner). */
const discountLimitOf = (user) => {
  if (!user || user.role === "owner") return null;
  const limit = user.maxDiscountPercent;
  return typeof limit === "number" && Number.isFinite(limit) ? limit : null;
};

// The discount share of the subtotal, in percent. A percentage alone (never applied by the server)
// is judged as sent; a discount on a zero or unknown subtotal counts as over any limit.
const discountShare = (body, subtotal) => {
  if (!positive(body.discountAmount)) return Number(body.discountPercentage || 0);
  if (!(subtotal > 0)) return Infinity;
  return (Number(body.discountAmount) / subtotal) * 100;
};

const DISCOUNT_LIMIT_TOLERANCE = 0.01;

const discountLimitError = (limit) => {
  const error = httpError(403, "DISCOUNT_LIMIT", `أقصى خصم مسموح لك ${limit}٪`);
  error.responseData.maxDiscountPercent = limit;
  return error;
};

/**
 * Stage 13 + 15 (cash and credit, create and edit). A new or changed discount (discountDecision)
 * needs sales.discount (403 FORBIDDEN) and must stay within the user's maxDiscountPercent:
 * discountAmount / subtotal * 100 ≤ limit (+0.01 for rounding), else 403 DISCOUNT_LIMIT.
 */
const requireDiscountPermission = (Model) => async (req, _res, next) => {
  if (!req.authEnabled) return next();
  const allowed = hasPermission(req.user, "sales.discount");
  const limit = discountLimitOf(req.user);
  if (allowed && limit === null) return next();
  try {
    const { changed, subtotal } = await discountDecision(req, Model);
    if (!changed) return next();
    if (!allowed) return next(forbidden());
    return discountShare(req.body || {}, subtotal) > limit + DISCOUNT_LIMIT_TOLERANCE ? next(discountLimitError(limit)) : next();
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
  DATA_RESTORED,
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
  hasPermission,
  isLoopback,
  isPublicPath,
  localOnly,
  publicRoute,
  requireAuth,
  discountLimitOf,
  requireDiscountPermission,
  requireAnyPermission,
  requireLogin,
  requirePermission,
  sessionExpired,
  stripCost,
};
