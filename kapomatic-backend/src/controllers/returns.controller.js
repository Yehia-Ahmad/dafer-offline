const asyncHandler = require("../utils/asyncHandler");
const service = require("../services/returns.service");
const { addSellingRefund } = require("./selling.controller");
const { addCreditSaleRefund } = require("./creditSale.controller");

const createReturn = (req, res, next) => {
  const { returnType, invoiceId } = req.body || {};

  if (!["cash", "credit"].includes(returnType)) {
    res.status(400);
    return next(new Error("returnType يجب أن يكون cash أو credit"));
  }

  if (typeof invoiceId !== "string" || !invoiceId.trim()) {
    res.status(400);
    return next(new Error("invoiceId مطلوب"));
  }

  req.params.id = invoiceId.trim();
  return returnType === "cash"
    ? addSellingRefund(req, res, next)
    : addCreditSaleRefund(req, res, next);
};

const getReturns = asyncHandler(async (req, res) => res.json({ success: true, ...(await service.listReturns(req.query)) }));
const getReturnById = asyncHandler(async (req, res) => {
  const data = await service.getReturn(req.params.id);
  if (!data) { res.status(404); throw new Error("سجل المرتجع غير موجود"); }
  res.json({ success: true, data });
});
const getReturnsSummary = asyncHandler(async (req, res) => res.json(await service.getSummary(req.query)));

module.exports = { createReturn, getReturns, getReturnById, getReturnsSummary };
