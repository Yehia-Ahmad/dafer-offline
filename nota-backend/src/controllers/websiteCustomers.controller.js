// Online Stage 4: the website's customers for staff (/api/website/customers, website.manage): search, order counts,
// deactivate/activate, and a password reset that shows a temporary password ONCE and ends the customer's sessions.
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const StoreCustomer = require("../models/storeCustomer.model");
const WebOrder = require("../models/webOrder.model");
const asyncHandler = require("../utils/asyncHandler");
const { parsePaginationInteger, buildPaginationMetadata } = require("../utils/pagination");
const { httpError } = require("../auth/middleware");
const { audit } = require("../auth/audit");

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// No look-alike characters (0/O, 1/l/I): the shop reads this password to the customer.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const temporaryPassword = () => Array.from(crypto.randomBytes(10), (byte) => ALPHABET[byte % ALPHABET.length]).join("");

const view = (customer, ordersCount) => ({
  id: String(customer._id), name: customer.name, phone: customer.phone, isActive: customer.isActive !== false,
  ordersCount, createdAt: customer.createdAt, lastLoginAt: customer.lastLoginAt || null,
});

const load = async (id) => {
  const customer = mongoose.Types.ObjectId.isValid(id) ? await StoreCustomer.findById(id) : null;
  if (!customer) throw httpError(404, "CUSTOMER_NOT_FOUND", "العميل غير موجود");
  return customer;
};

const list = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const limit = parsePaginationInteger(req.query.limit, 20, 100);
  const page = parsePaginationInteger(req.query.page, 1);
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const filter = q ? { $or: [{ name: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q), "i") }] } : {};
  const [rows, total] = await Promise.all([
    StoreCustomer.find(filter).select("name phone isActive createdAt lastLoginAt").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    StoreCustomer.countDocuments(filter),
  ]);
  const counts = await WebOrder.aggregate([{ $match: { storeCustomer: { $in: rows.map((row) => row._id) } } }, { $group: { _id: "$storeCustomer", count: { $sum: 1 } } }]);
  const countOf = new Map(counts.map((row) => [String(row._id), row.count]));
  res.json({ data: rows.map((row) => view(row, countOf.get(String(row._id)) || 0)), pagination: buildPaginationMetadata({ page, limit, totalItems: total }) });
});

// PUT /api/website/customers/:id { isActive } — deactivating ends the sessions (the store auth checks isActive on every request).
const setActive = asyncHandler(async (req, res) => {
  if (typeof (req.body || {}).isActive !== "boolean") throw httpError(400, "INVALID_ACTIVE", "قيمة التفعيل غير صالحة");
  const customer = await load(req.params.id);
  customer.isActive = req.body.isActive;
  await customer.save();
  await audit(req, { action: customer.isActive ? "website.customer.activated" : "website.customer.deactivated", entity: "StoreCustomer", entityId: customer._id });
  res.json(view(customer, await WebOrder.countDocuments({ storeCustomer: customer._id })));
});

// POST /api/website/customers/:id/reset-password: a temporary password, shown once; tokenVersion + 1 ends every session.
const resetPassword = asyncHandler(async (req, res) => {
  const customer = await load(req.params.id);
  const password = temporaryPassword();
  customer.passwordHash = await bcrypt.hash(password, StoreCustomer.BCRYPT_COST);
  customer.tokenVersion = Number(customer.tokenVersion || 0) + 1;
  await customer.save();
  await audit(req, { action: "website.customer.password_reset", entity: "StoreCustomer", entityId: customer._id });
  res.set("Cache-Control", "no-store");
  res.json({ temporaryPassword: password });
});

module.exports = { list, setActive, resetPassword };
