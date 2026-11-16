// Online Stage 3: customer accounts of the website (register, login, me, saved addresses). A StoreCustomer is never
// linked to, looked up in, or compared with the shop's Customer.
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const StoreCustomer = require("../models/storeCustomer.model");
const DeliveryZone = require("../models/deliveryZone.model");
const asyncHandler = require("../utils/asyncHandler");
const { httpError } = require("../auth/middleware");
const { createLoginLimiter } = require("../auth/loginLimiter");
const { signStoreToken } = require("../auth/storeJwt");
const { normalizeStorePhone } = require("../utils/storePhone");
const wl = require("../store/whitelist");

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72; // bcrypt only reads the first 72 bytes
const { MAX_ADDRESSES, BCRYPT_COST } = StoreCustomer;

const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const bad = (code, message) => httpError(400, code, message);

const readName = (value) => {
  const name = str(value, 121);
  if (!name || name.length > 120) throw bad("INVALID_NAME", "الاسم مطلوب (حتى 120 حرف)");
  return name;
};
const readPassword = (value) => {
  if (typeof value !== "string" || value.length < MIN_PASSWORD || Buffer.byteLength(value) > MAX_PASSWORD) {
    throw bad("INVALID_PASSWORD", `كلمة المرور من ${MIN_PASSWORD} إلى ${MAX_PASSWORD} حرفًا`);
  }
  return value;
};
const readPhone = (value) => {
  const phone = normalizeStorePhone(value);
  if (!phone) throw bad("INVALID_PHONE", "رقم الموبايل غير صالح");
  return phone;
};

let dummyHash;
const getDummyHash = () => {
  if (!dummyHash) dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), BCRYPT_COST);
  return dummyHash;
};

/** Reads and checks one address body: label, zoneId (an existing zone), address, notes. */
const readAddress = async (body) => {
  const input = body && typeof body === "object" ? body : {};
  const address = str(input.address, 501);
  if (!address || address.length > 500) throw bad("INVALID_ADDRESS", "العنوان مطلوب (حتى 500 حرف)");
  const out = { label: str(input.label, 60), address, notes: str(input.notes, 500) };
  if (input.zoneId !== undefined && input.zoneId !== null && input.zoneId !== "") {
    if (typeof input.zoneId !== "string" || !mongoose.Types.ObjectId.isValid(input.zoneId) || !(await DeliveryZone.exists({ _id: input.zoneId }))) {
      throw bad("INVALID_ZONE", "منطقة التوصيل غير صالحة");
    }
    out.zone = input.zoneId;
  }
  return out;
};

const createStoreAccountController = ({ secret, now = () => Date.now() } = {}) => {
  // Customer lockout: its own counters (never shared with the staff login), per phone + IP.
  const loginLimiter = createLoginLimiter({ now });
  const withToken = (customer) => ({ token: signStoreToken(customer, secret), customer: wl.publicCustomer(customer) });

  const register = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = readName(body.name);
    const phone = readPhone(body.phone);
    const password = readPassword(body.password);
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    let customer;
    try {
      customer = await StoreCustomer.create({ name, phone, passwordHash, lastLoginAt: new Date(now()) });
    } catch (error) {
      if (error && error.code === 11000) throw httpError(409, "PHONE_EXISTS", "الرقم ده مسجّل قبل كده. سجّل الدخول");
      throw error;
    }
    res.status(201).json(withToken(customer));
  });

  const login = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const phone = normalizeStorePhone(body.phone);
    const password = typeof body.password === "string" ? body.password : "";
    const key = phone || str(body.phone, 40);
    const lockedMs = loginLimiter.lockedFor(key, req.ip);
    if (lockedMs > 0) throw httpError(429, "LOGIN_LOCKED", `محاولات كثيرة غير صحيحة. حاول مرة أخرى بعد ${Math.max(1, Math.ceil(lockedMs / 60000))} دقائق`);
    const customer = phone ? await StoreCustomer.findOne({ phone }) : null;
    // Always one bcrypt compare, so a missing phone costs the same time as a wrong password.
    const ok = await bcrypt.compare(password.slice(0, 200), customer ? customer.passwordHash : getDummyHash());
    if (!customer || !ok || !customer.isActive) {
      const nowLocked = loginLimiter.fail(key, req.ip);
      if (nowLocked) throw httpError(429, "LOGIN_LOCKED", "محاولات كثيرة غير صحيحة. حاول مرة أخرى بعد 5 دقائق");
      throw httpError(401, "INVALID_CREDENTIALS", "الرقم أو كلمة المرور غير صحيحة");
    }
    loginLimiter.succeed(key, req.ip);
    customer.lastLoginAt = new Date(now());
    await customer.save();
    res.json(withToken(customer));
  });

  const getMe = (req, res) => res.json(wl.publicCustomer(req.storeCustomer));

  const updateMe = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const customer = req.storeCustomer;
    let changedPassword = false;
    if (body.name !== undefined) customer.name = readName(body.name);
    if (body.newPassword !== undefined) {
      const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!(await bcrypt.compare(current.slice(0, 200), customer.passwordHash))) throw httpError(400, "WRONG_PASSWORD", "كلمة المرور الحالية غير صحيحة");
      customer.passwordHash = await bcrypt.hash(readPassword(body.newPassword), BCRYPT_COST);
      customer.tokenVersion = Number(customer.tokenVersion || 0) + 1; // ends every older session
      changedPassword = true;
    }
    await customer.save();
    res.json(changedPassword ? withToken(customer) : { customer: wl.publicCustomer(customer) });
  });

  const listAddresses = (req, res) => res.json({ data: req.storeCustomer.addresses.map(wl.publicAddress) });

  const addAddress = asyncHandler(async (req, res) => {
    const customer = req.storeCustomer;
    if (customer.addresses.length >= MAX_ADDRESSES) throw httpError(409, "ADDRESS_LIMIT", `الحد الأقصى ${MAX_ADDRESSES} عناوين`);
    customer.addresses.push(await readAddress(req.body));
    await customer.save();
    res.status(201).json(wl.publicAddress(customer.addresses[customer.addresses.length - 1]));
  });

  const findAddress = (customer, id) => {
    const address = mongoose.Types.ObjectId.isValid(id) ? customer.addresses.id(id) : null;
    if (!address) throw httpError(404, "NOT_FOUND", "العنوان غير موجود");
    return address;
  };

  const updateAddress = asyncHandler(async (req, res) => {
    const customer = req.storeCustomer;
    const address = findAddress(customer, req.params.id);
    const next = await readAddress(req.body);
    address.set({ label: next.label, address: next.address, notes: next.notes, zone: next.zone || undefined });
    await customer.save();
    res.json(wl.publicAddress(address));
  });

  const deleteAddress = asyncHandler(async (req, res) => {
    const customer = req.storeCustomer;
    findAddress(customer, req.params.id).deleteOne();
    await customer.save();
    res.status(204).end();
  });

  return { loginLimiter, register, login, getMe, updateMe, listAddresses, addAddress, updateAddress, deleteAddress };
};

module.exports = { createStoreAccountController };
