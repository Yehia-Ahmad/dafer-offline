const CreditSale = require("../models/creditSale.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const asyncHandler = require("../utils/asyncHandler");
const { roundMoney } = require("../utils/invoicePricing");
const { DEFAULT_LOW_STOCK_THRESHOLD } = require("../utils/lowStock");
const { toSellingInvoice } = require("./selling.controller");
const { loadCustomerOpenItems } = require("../services/customerOpenItems.service");
const Supplier = require("../models/supplier.model");
const { supplierBalances } = require("./supplier.controller");
const { hasPermission } = require("../auth/permissions");

// Stage 12: read-only dashboard summary (GET /api/dashboard/summary).
//
// "Today" is the server's local calendar date (the shop's main PC). Sales and credit sales store
// sellingDate as UTC midnight of the date the cashier picked (the app sends "yyyy-MM-dd"), so a day
// is matched as [Date.UTC(y, m, d), next day) on sellingDate, the same UTC day ranges the existing
// list filters use. dueDate is stored the same way; a credit invoice is overdue when its dueDate is
// before today and money remains.
//
// Stage 16: invoices keep original totals. Dashboard figures use totalPrice - refundedAmount and
// omit cancelled invoices.

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_DAYS = 7;
const RECENT_LIMIT = 5;
const LOW_STOCK_LIMIT = 8;

const toDateKey = (date) => date.toISOString().slice(0, 10);

/** UTC midnight of the server's local calendar date. */
const localTodayAsUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

/** Cash invoice total as GET /api/sellings shows it (net of returned items). */
const cashInvoiceTotal = (selling) => {
  const refundedAmount = selling.refundedAmount ?? (selling.refunds || []).reduce((sum, refund) => sum + Number(refund.totalAmount || 0), 0);
  return roundMoney(Math.max(0, Number(selling.totalPrice || 0) - Number(refundedAmount || 0)));
};

/** Same as totalsByDay, for cash invoices (net of returns, computed per invoice). */
const cashTotalsByDay = async (from, to) => {
  const sellings = await Selling.find({ sellingDate: { $gte: from, $lt: to }, status: { $ne: "cancelled" } }).lean();
  const byDay = new Map();
  for (const selling of sellings) {
    const key = toDateKey(new Date(selling.sellingDate));
    const entry = byDay.get(key) || { total: 0, count: 0 };
    entry.total += cashInvoiceTotal(selling);
    entry.count += 1;
    byDay.set(key, entry);
  }
  for (const entry of byDay.values()) entry.total = roundMoney(entry.total);
  return byDay;
};

/** { 'YYYY-MM-DD': { total, count } } of invoices whose sellingDate falls in [from, to). */
const totalsByDay = async (Model, from, to) => {
  const rows = await Model.aggregate([
    { $match: { sellingDate: { $gte: from, $lt: to }, status: { $ne: "cancelled" } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$sellingDate", timezone: "UTC" } },
        total: { $sum: { $max: [0, { $subtract: [{ $ifNull: ["$totalPrice", 0] }, { $ifNull: ["$refundedAmount", 0] }] }] } },
        count: { $sum: 1 },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id, { total: roundMoney(row.total), count: row.count }]));
};

const dayTotals = (byDay, key) => byDay.get(key) || { total: 0, count: 0 };

const getDashboardSummary = asyncHandler(async (req, res) => {
  const today = localTodayAsUtcDay();
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const yesterday = new Date(today.getTime() - DAY_MS);
  const firstDay = new Date(today.getTime() - (LAST_DAYS - 1) * DAY_MS);
  const todayKey = toDateKey(today);
  const yesterdayKey = toDateKey(yesterday);

  const [cashByDay, creditByDay, outstandingRows, recentCash, recentCredit, lowStock] = await Promise.all([
    cashTotalsByDay(firstDay, tomorrow),
    totalsByDay(CreditSale, firstDay, tomorrow),
    // Stage 18: one open-items source (invoices + customer opening balances) for outstanding.
    loadCustomerOpenItems(),
    Selling.find({ status: { $ne: "cancelled" } }).sort({ createdAt: -1, _id: -1 }).limit(RECENT_LIMIT).lean(),
    CreditSale.find({ status: { $ne: "cancelled" } }, "customer customerName number totalPrice refundedAmount createdAt sellingDate").sort({ createdAt: -1, _id: -1 }).limit(RECENT_LIMIT).lean(),
    Product.aggregate([
      { $match: { isArchived: { $ne: true }, $expr: { $lte: ["$inventoryCount", { $ifNull: ["$lowStockThreshold", DEFAULT_LOW_STOCK_THRESHOLD] }] } } },
      { $sort: { inventoryCount: 1, name: 1, _id: 1 } },
      { $limit: LOW_STOCK_LIMIT },
      {
        $project: {
          _id: 0,
          id: "$_id",
          name: 1,
          code: 1,
          inventoryCount: 1,
          threshold: { $ifNull: ["$lowStockThreshold", DEFAULT_LOW_STOCK_THRESHOLD] },
        },
      },
    ]),
  ]);

  const last7Days = [];
  for (let index = 0; index < LAST_DAYS; index += 1) {
    const key = toDateKey(new Date(firstDay.getTime() + index * DAY_MS));
    last7Days.push({ date: key, cash: dayTotals(cashByDay, key).total, credit: dayTotals(creditByDay, key).total });
  }

  // Overdue stays by invoice dueDate; an opening balance has no due date, so it counts as outstanding but never as overdue.
  const outstanding = { outstanding: 0, customers: [], overdueAmount: 0, overdueCount: 0 };
  for (const [customerId, open] of outstandingRows) {
    for (const item of open.items) {
      outstanding.outstanding += item.remaining;
      if (!outstanding.customers.includes(customerId)) outstanding.customers.push(customerId);
      if (item.kind === "invoice" && item.dueDate && new Date(item.dueDate) < today) {
        outstanding.overdueAmount += item.remaining;
        outstanding.overdueCount += 1;
      }
    }
  }
  let suppliersDue = null;
  if (!req.authEnabled || (req.user && hasPermission(req.user, "suppliers.view"))) {
    const ids = (await Supplier.find({}).select("_id").lean()).map((row) => row._id);
    const { balances } = await supplierBalances(ids);
    const owed = [...balances.values()].filter((value) => value > 0);
    suppliersDue = { owed: roundMoney(owed.reduce((sum, value) => sum + value, 0)), suppliersWithBalance: owed.length };
  }
  const recentInvoices = [
    ...recentCash.map((selling) => ({
      id: String(selling._id),
      type: "cash",
      reference: selling.number ?? String(selling.invoiceId ?? selling._id),
      customerName: selling.customerName || "",
      customerId: null,
      total: roundMoney(cashInvoiceTotal(selling)),
      sellingDate: selling.sellingDate,
      createdAt: selling.createdAt,
    })),
    ...recentCredit.map((creditSale) => ({
      id: String(creditSale._id),
      type: "credit",
      reference: creditSale.number ?? String(creditSale._id),
      customerName: creditSale.customerName || "",
      customerId: creditSale.customer ? String(creditSale.customer) : null,
      total: roundMoney(Math.max(0, Number(creditSale.totalPrice || 0) - Number(creditSale.refundedAmount || 0))),
      sellingDate: creditSale.sellingDate,
      createdAt: creditSale.createdAt,
    })),
  ]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, RECENT_LIMIT);

  res.json({
    date: todayKey,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    today: { cash: dayTotals(cashByDay, todayKey), credit: dayTotals(creditByDay, todayKey) },
    yesterday: { cash: dayTotals(cashByDay, yesterdayKey), credit: dayTotals(creditByDay, yesterdayKey) },
    credit: {
      outstanding: roundMoney(outstanding ? outstanding.outstanding : 0),
      customersWithBalance: outstanding ? outstanding.customers.length : 0,
      overdueAmount: roundMoney(outstanding ? outstanding.overdueAmount : 0),
      overdueCount: outstanding ? outstanding.overdueCount : 0,
    },
    // Stage 20: "مستحق للموردين" (what we owe suppliers), only for suppliers.view.
    ...(suppliersDue ? { suppliersDue } : {}),
    last7Days,
    recentInvoices,
    lowStock: lowStock.map((product) => ({ ...product, id: String(product.id) })),
  });
});

module.exports = { getDashboardSummary, localTodayAsUtcDay };
