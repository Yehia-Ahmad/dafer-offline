const mongoose = require("mongoose");
const Supplier = require("../models/supplier.model");
const PartyOpening = require("../models/partyOpening.model");
const JournalEntry = require("../models/journalEntry.model");
const Account = require("../models/account.model");
const asyncHandler = require("../utils/asyncHandler");
const { withTransaction } = require("../utils/transaction");
const { roundMoney } = require("../utils/invoicePricing");
const { audit } = require("../auth/audit");

// Stage 18: minimal suppliers. Purchases, payments and the supplier statement are Stage 20.

const fail = (status, message, data) => {
  const error = new Error(message);
  error.statusCode = status;
  if (data) error.responseData = data;
  throw error;
};

const optionalText = (value, label, max) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  if (typeof value !== "string") fail(400, `${label} غير صالح`);
  const text = value.trim();
  if (text.length > max) fail(400, `${label} طويل جدًا`);
  return text;
};

/** Reads the writable fields of a supplier body; undefined = not sent. */
const readSupplierBody = (body, { creating }) => {
  const input = body && typeof body === "object" ? body : {};
  const fields = {};
  if (creating || input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) fail(400, "اسم المورد مطلوب");
    if (name.length > 200) fail(400, "اسم المورد طويل جدًا");
    fields.name = name;
  }
  if (input.phones !== undefined || input.phone !== undefined) {
    const raw = Array.isArray(input.phones) ? input.phones : [input.phone ?? input.phones];
    fields.phones = raw.filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map((value) => String(value).trim());
    if (fields.phones.some((phone) => phone.length > 30)) fail(400, "رقم الهاتف طويل جدًا");
  }
  for (const [key, label, max] of [["contactPerson", "اسم المسؤول", 120], ["address", "العنوان", 300], ["supplies", "ما يورّده", 300], ["taxNumber", "الرقم الضريبي", 50], ["notes", "الملاحظات", 1000]]) {
    const value = optionalText(input[key], label, max);
    if (value !== undefined) fields[key] = value;
  }
  if (input.paymentTermsDays !== undefined) {
    if (input.paymentTermsDays === null || input.paymentTermsDays === "") fields.paymentTermsDays = null;
    else {
      const days = Number(input.paymentTermsDays);
      if (!Number.isInteger(days) || days < 0 || days > 3650) fail(400, "مدة السداد غير صالحة");
      fields.paymentTermsDays = days;
    }
  }
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== "boolean") fail(400, "حالة المورد غير صالحة");
    fields.isActive = input.isActive;
  }
  return fields;
};

/** Ledger party balance per supplier: positive = we owe the supplier (credit side of 21). */
const supplierBalances = async (supplierIds, session = null) => {
  const account = await Account.findOne({ systemKey: "SUPPLIERS" }).lean().session(session);
  if (!account) return new Map();
  ledgerAccountIds.set("SUPPLIERS", String(account._id));
  const rows = await JournalEntry.aggregate([
    { $match: { status: "posted", "lines.accountId": account._id } },
    { $unwind: "$lines" },
    { $match: { "lines.accountId": account._id, "lines.partyId": { $in: supplierIds } } },
    { $group: { _id: "$lines.partyId", balance: { $sum: { $subtract: ["$lines.credit", "$lines.debit"] } } } },
  ]).session(session);
  return new Map(rows.map((row) => [String(row._id), roundMoney(row.balance)]));
};

// The ledger account the rows link to (account 21), learned while computing the balances.
const ledgerAccountIds = new Map();

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const present = (supplier, balances, openings) => ({
  ...supplier,
  balance: balances.get(String(supplier._id)) || 0,
  openingAmount: openings.get(String(supplier._id)) || 0,
  ledgerAccountId: ledgerAccountIds.get("SUPPLIERS") || null,
});

const getSuppliers = asyncHandler(async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const query = {};
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    query.$or = [{ name: regex }, { phones: regex }, { contactPerson: regex }, { supplies: regex }];
  }
  if (req.query.active === "true") query.isActive = true;
  const suppliers = await Supplier.find(query).sort({ name: 1 }).lean();
  const ids = suppliers.map((supplier) => supplier._id);
  const [balances, openingRows] = await Promise.all([supplierBalances(ids), PartyOpening.find({ partyType: "supplier", partyId: { $in: ids } }).lean()]);
  const openings = new Map(openingRows.map((row) => [String(row.partyId), row.amount]));
  res.set("Cache-Control", "no-store");
  res.json(suppliers.map((supplier) => present(supplier, balances, openings)));
});

const loadSupplier = async (req, session = null) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) fail(404, "المورد غير موجود");
  const supplier = await Supplier.findById(req.params.id).session(session);
  if (!supplier) fail(404, "المورد غير موجود");
  return supplier;
};

const getSupplierById = asyncHandler(async (req, res) => {
  const supplier = await loadSupplier(req);
  const [balances, opening] = await Promise.all([supplierBalances([supplier._id]), PartyOpening.findOne({ partyType: "supplier", partyId: supplier._id }).lean()]);
  res.json(present(supplier.toObject(), balances, new Map(opening ? [[String(supplier._id), opening.amount]] : [])));
});

const createSupplier = asyncHandler(async (req, res) => {
  const fields = readSupplierBody(req.body, { creating: true });
  const supplier = await withTransaction(async (session) => {
    const [created] = await Supplier.create([fields], { session });
    await audit(req, { action: "supplier.created", entity: "Supplier", entityId: created._id, details: { name: created.name }, session, strict: true });
    return created;
  });
  res.status(201).json(supplier);
});

const updateSupplier = asyncHandler(async (req, res) => {
  const fields = readSupplierBody(req.body, { creating: false });
  const supplier = await withTransaction(async (session) => {
    const existing = await loadSupplier(req, session);
    existing.set(fields);
    await existing.save({ session });
    await audit(req, { action: "supplier.updated", entity: "Supplier", entityId: existing._id, details: { name: existing.name }, session, strict: true });
    return existing;
  });
  res.json(supplier);
});

const deleteSupplier = asyncHandler(async (req, res) => {
  await withTransaction(async (session) => {
    const supplier = await loadSupplier(req, session);
    const [opening, ledgerLine] = await Promise.all([
      PartyOpening.exists({ partyType: "supplier", partyId: supplier._id }).session(session),
      JournalEntry.exists({ "lines.partyId": supplier._id }).session(session),
    ]);
    if (opening || ledgerLine) fail(409, "لا يمكن حذف المورد لوجود رصيد أو حركات مسجلة له", { code: "SUPPLIER_HAS_BALANCE" });
    await supplier.deleteOne({ session });
    await audit(req, { action: "supplier.deleted", entity: "Supplier", entityId: supplier._id, details: { name: supplier.name }, session, strict: true });
  });
  res.json({ message: "Supplier deleted successfully" });
});

module.exports = { getSuppliers, getSupplierById, createSupplier, updateSupplier, deleteSupplier };
