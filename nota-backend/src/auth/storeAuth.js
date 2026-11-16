// Online Stage 3: authentication of the customer website (/api/store). Staff auth (requireAuth) is not involved.
const mongoose = require("mongoose");
const StoreCustomer = require("../models/storeCustomer.model");
const { bearerToken } = require("./jwt");
const { verifyStoreToken } = require("./storeJwt");
const { PERMISSION_TAG, STORE, STORE_CUSTOMER, httpError } = require("./middleware");

const tag = (handler, value) => {
  handler[PERMISSION_TAG] = value;
  return handler;
};

const sessionExpired = () => httpError(401, "SESSION_EXPIRED", "انتهت الجلسة. سجّل الدخول مرة أخرى");

/** Loads the customer of a valid store token into req.storeCustomer. Fails with 401 when a token is sent but invalid. */
const loadCustomer = (secret, { required }) => async (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) return required ? next(sessionExpired()) : next();
    const payload = verifyStoreToken(token, secret);
    if (!payload || !mongoose.Types.ObjectId.isValid(payload.sub)) return next(sessionExpired());
    const customer = await StoreCustomer.findById(payload.sub);
    if (!customer || !customer.isActive || payload.tv !== Number(customer.tokenVersion || 0)) return next(sessionExpired());
    req.storeCustomer = customer;
    return next();
  } catch (error) {
    return next(error);
  }
};

/** A public store route (no token needed). Marker for the route-coverage test. */
const storePublic = () => tag((_req, _res, next) => next(), STORE);

/** A public store route that also serves a signed-in customer (guest or customer). */
const storeOptional = (secret) => {
  const load = loadCustomer(secret, { required: false });
  return tag((req, res, next) => load(req, res, next), STORE);
};

/** A route that needs a signed-in customer. */
const storeCustomerOnly = (secret) => {
  const load = loadCustomer(secret, { required: true });
  return tag((req, res, next) => load(req, res, next), STORE_CUSTOMER);
};

module.exports = { storeCustomerOnly, storeOptional, storePublic };
