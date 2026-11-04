const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const AuditLog = require("../models/auditLog.model");
const { buildPaginatedResponse, getPaginationParams } = require("../utils/pagination");
const { httpError } = require("../auth/middleware");

const parseDate = (value, field) => {
  if (value === undefined || value === "") return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw httpError(400, "VALIDATION_ERROR", `قيمة ${field} غير صالحة`);
  return date;
};

/**
 * GET /api/audit (audit.view). Filters: from, to (dates; a date-only `to` covers that whole UTC
 * day), userId, action. Newest first, paginated like the other lists ({ success, data, pagination }).
 */
const listAudit = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const query = {};
  const from = parseDate(req.query.from, "from");
  let to = parseDate(req.query.to, "to");
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) to = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  if (from || to) query.at = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
  if (req.query.userId !== undefined && req.query.userId !== "") {
    if (!mongoose.Types.ObjectId.isValid(String(req.query.userId))) throw httpError(400, "VALIDATION_ERROR", "قيمة userId غير صالحة");
    query.userId = String(req.query.userId);
  }
  if (typeof req.query.action === "string" && req.query.action.trim()) query.action = req.query.action.trim();

  const [entries, totalItems] = await Promise.all([
    AuditLog.find(query).sort({ at: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(query),
  ]);
  res.json(buildPaginatedResponse({ data: entries, page, limit, totalItems }));
});

module.exports = { listAudit };
