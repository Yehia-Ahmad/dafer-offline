const mongoose = require("mongoose");
const ReturnLog = require("../models/returnLog.model");

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseDate = (value, name, endOfDay = false) => {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`تنسيق ${name} غير صالح`);
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) throw badRequest(`تنسيق ${name} غير صالح`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) date.setUTCHours(23, 59, 59, 999);
  return date;
};

const buildDateFilter = ({ dateFrom, dateTo } = {}) => {
  const range = {};
  if (dateFrom !== undefined) range.$gte = parseDate(dateFrom, "dateFrom");
  if (dateTo !== undefined) range.$lte = parseDate(dateTo, "dateTo", true);
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    throw badRequest("dateFrom يجب أن يكون قبل dateTo أو مساويًا له");
  }
  return Object.keys(range).length ? { returnDate: range } : {};
};

const buildQuery = (filters = {}) => {
  const query = buildDateFilter(filters);
  if (filters.returnType !== undefined) {
    if (!["cash", "credit"].includes(filters.returnType)) throw badRequest("returnType يجب أن يكون cash أو credit");
    query.returnType = filters.returnType;
  }
  for (const field of ["customerName", "customerPhone"]) {
    if (filters[field] !== undefined) {
      if (typeof filters[field] !== "string" || !filters[field].trim()) throw badRequest(`تنسيق ${field} غير صالح`);
      query[field] = new RegExp(escapeRegex(filters[field].trim()), "i");
    }
  }
  for (const field of ["invoiceId", "productId"]) {
    if (filters[field] !== undefined && !mongoose.Types.ObjectId.isValid(filters[field])) {
      throw badRequest(`تنسيق ${field} غير صالح`);
    }
  }
  if (filters.invoiceId !== undefined) query.invoiceId = filters.invoiceId;
  if (filters.productId !== undefined) query["items.productId"] = filters.productId;
  if (filters.productCode !== undefined) {
    if (typeof filters.productCode !== "string" || !filters.productCode.trim()) throw badRequest("تنسيق productCode غير صالح");
    query["items.productCode"] = new RegExp(escapeRegex(filters.productCode.trim()), "i");
  }
  return query;
};

const createReturnLog = (payload) => ReturnLog.create(payload);

const listReturns = async (filters = {}) => {
  const page = Number(filters.page ?? 1);
  const limit = Number(filters.limit ?? 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw badRequest("page و limit يجب أن يكونا أرقامًا صحيحة موجبة، والحد الأقصى لـ limit هو 100");
  }
  const query = buildQuery(filters);
  const [data, totalItems] = await Promise.all([
    ReturnLog.find(query).sort({ returnDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ReturnLog.countDocuments(query),
  ]);
  const totalPages = Math.ceil(totalItems / limit);
  return { data, pagination: { page, limit, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 } };
};

const getReturn = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw badRequest("تنسيق معرّف المرتجع غير صالح");
  return ReturnLog.findById(id).lean();
};

const getSummary = async (filters = {}) => {
  const [result] = await ReturnLog.aggregate([
    { $match: buildDateFilter(filters) },
    { $group: {
      _id: null,
      totalCashReturns: { $sum: { $cond: [{ $eq: ["$returnType", "cash"] }, 1, 0] } },
      totalCreditReturns: { $sum: { $cond: [{ $eq: ["$returnType", "credit"] }, 1, 0] } },
      totalReturnedAmount: { $sum: "$finalReturnedAmount" },
      totalReturnedItems: { $sum: { $sum: "$items.quantity" } },
    } },
    { $project: { _id: 0 } },
  ]);
  return result || { totalCashReturns: 0, totalCreditReturns: 0, totalReturnedAmount: 0, totalReturnedItems: 0 };
};

module.exports = { createReturnLog, listReturns, getReturn, getSummary };
