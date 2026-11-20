// Online Stage 7A: campaign results. Read-only: it only reads WebOrder, CreditSale, Selling, Expense, Campaign and the anonymous
// click/visit counters. Nothing here prices, posts, returns or moves stock.
//
// Every number is attributed to the shop's LOCAL day of the order's creation (one cohort rule), so clicks, visits, orders, sales and
// spend of a campaign line up. Dates and "today" use utils/clock.js, never a UTC slice.
//
// What each number reads (see docs/stages/ONLINE_STAGE_7A.md and the Stage 7A section of docs/ONLINE_PLAN.md):
//   clicks        CampaignClick.count            visits   CampaignVisit (unique campaign+day+session)
//   placed        WebOrder (attribution.campaignId, createdAt in range, any status)
//   cancelled / rejected / refused   WebOrder.status
//   completed     status delivered|picked_up AND an invoice (creditSaleId|cashSaleId) that is not cancelled and not fully returned
//   sales         invoice.totalPrice - invoice.refundedAmount
//   grossProfit   product revenue - cost of goods, per invoice line (profitAmount - discount share) * remaining share - VAT inside:
//                 the product profit report's math. The delivery fee is NOT in it (most shops pay it to the courier).
//   deliveryRevenue  the delivery fee of the completed invoices, net of its VAT, while any line of the invoice is kept: shown on its own
//   spend         Expense (campaignId, status posted, date in range): amount - vatAmount
const mongoose = require("mongoose");
const WebOrder = require("../models/webOrder.model");
const CreditSale = require("../models/creditSale.model");
const Selling = require("../models/selling.model");
const Expense = require("../models/expense.model");
const Campaign = require("../models/campaign.model");
const { CampaignClick, CampaignVisit } = require("../models/campaignStat.model");
const { roundMoney, buildInvoiceTotals } = require("../utils/invoicePricing");
const clock = require("../utils/clock");

const COMPLETED_STATUSES = ["delivered", "picked_up"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIRECT = "direct";

const money = (value) => roundMoney(Number(value || 0));
const divide = (a, b) => (b > 0 ? roundMoney(a / b) : null);

/** The discount of the invoice split over its lines, the last line takes the rounding rest (same as the product profit report). */
const allocateItemDiscounts = (items, discountAmount) => {
  const total = money(discountAmount);
  const subtotal = money(items.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));
  if (total <= 0 || subtotal <= 0 || !items.length) return items.map(() => 0);
  let rest = total;
  return items.map((item, index) => {
    if (index === items.length - 1) return money(rest);
    const share = money((total * Number(item.totalPrice || 0)) / subtotal);
    rest = money(rest - share);
    return share;
  });
};

const vatInsideLine = (invoice, item, ratio) =>
  invoice.vatRate !== undefined && invoice.vatRate !== null && invoice.vatIncluded !== false ? money(Number(item.vatAmount || 0) * ratio) : 0;

/** { sales, grossProfit, deliveryRevenue } of one posted invoice, net of its returns. Pure. */
const invoiceFigures = (invoice) => {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const { discountAmount } = buildInvoiceTotals(items, { discountAmount: invoice.discountAmount, discountPercentage: invoice.discountPercentage, shippingFees: invoice.shippingFees });
  const discounts = allocateItemDiscounts(items, discountAmount);
  let profit = 0;
  items.forEach((item, index) => {
    const original = Number(item.quantity || 0);
    const remaining = Math.max(0, original - Number(item.returnedQuantity || 0));
    if (remaining <= 0) return;
    const ratio = original > 0 ? remaining / original : 0;
    const vatInside = vatInsideLine(invoice, item, ratio);
    const revenue = money(Number(item.unitPrice || 0) * remaining - Number(discounts[index] || 0) * ratio - vatInside);
    profit += item.profitAmount !== undefined && item.profitAmount !== null
      ? money((Number(item.profitAmount || 0) - Number(discounts[index] || 0)) * ratio - vatInside)
      : money(revenue - Number(item.purchasePrice || 0) * remaining);
  });
  // Delivery income (net of its VAT when prices include VAT) stays while anything of the invoice is kept. It is reported on its own:
  // gross profit stays product revenue minus cost.
  const shipping = money(invoice.shippingFees);
  const shippingVat = invoice.vatRate !== undefined && invoice.vatRate !== null && invoice.vatIncluded !== false ? money(invoice.shippingVat) : 0;
  const kept = items.some((item) => Number(item.quantity || 0) - Number(item.returnedQuantity || 0) > 0);
  const deliveryRevenue = kept ? money(shipping - shippingVat) : 0;
  return { sales: money(Number(invoice.totalPrice || 0) - Number(invoice.refundedAmount || 0)), grossProfit: money(profit), deliveryRevenue };
};

const emptyBucket = () => ({
  clicks: 0, visits: 0, ordersPlaced: 0, ordersCompleted: 0, ordersCancelled: 0, ordersRejected: 0, ordersRefused: 0, sales: 0, grossProfit: 0, deliveryRevenue: 0, spend: 0,
});

const finish = (bucket, { includeProfit, hasVisits = true, hasSpend = true }) => {
  const out = {
    clicks: bucket.clicks,
    visits: hasVisits ? bucket.visits : null,
    ordersPlaced: bucket.ordersPlaced,
    ordersCompleted: bucket.ordersCompleted,
    ordersCancelled: bucket.ordersCancelled,
    ordersRejected: bucket.ordersRejected,
    ordersRefused: bucket.ordersRefused,
    sales: money(bucket.sales),
    deliveryRevenue: money(bucket.deliveryRevenue),
    conversionRate: hasVisits && bucket.visits > 0 ? Math.round((bucket.ordersCompleted / bucket.visits) * 10000) / 10000 : null,
    averageOrderValue: divide(bucket.sales, bucket.ordersCompleted),
    spend: hasSpend ? money(bucket.spend) : 0,
    costPerOrder: hasSpend ? divide(bucket.spend, bucket.ordersCompleted) : null,
    returnOnSpend: hasSpend && bucket.spend > 0 ? Math.round((bucket.sales / bucket.spend) * 100) / 100 : null,
  };
  if (includeProfit) {
    out.grossProfit = money(bucket.grossProfit);
    out.profitAfterAds = hasSpend ? money(bucket.grossProfit - bucket.spend) : money(bucket.grossProfit);
  }
  return out;
};

const rangeOf = (query) => {
  const today = clock.localDayString(clock.now());
  const to = DAY_RE.test(String(query.to || "")) ? query.to : today;
  let from = DAY_RE.test(String(query.from || "")) ? query.from : null;
  if (!from) {
    const start = new Date(`${to}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 29);
    from = start.toISOString().slice(0, 10);
  }
  if (from > to) return null;
  return { from, to, start: clock.filterBoundary(from), end: clock.filterBoundary(to, true) };
};

/**
 * @param {{from?:string,to?:string,campaignId?:string}} query  local days (YYYY-MM-DD)
 * @param {{includeProfit:boolean}} options  profit numbers are only built for users who may see cost/profit
 */
const campaignResults = async (query, { includeProfit }) => {
  const range = rangeOf(query || {});
  if (!range) return null;
  const only = query && query.campaignId && mongoose.Types.ObjectId.isValid(query.campaignId) ? String(query.campaignId) : null;

  const campaigns = await Campaign.find(only ? { _id: only } : {}).select("name code platform type status startDate endDate").lean();
  const byCampaign = new Map(campaigns.map((campaign) => [String(campaign._id), campaign]));
  const campaignFilter = only ? { campaignId: new mongoose.Types.ObjectId(only) } : { campaignId: { $in: campaigns.map((campaign) => campaign._id) } };

  const orderFilter = { createdAt: { $gte: range.start, $lte: range.end } };
  if (only) orderFilter["attribution.campaignId"] = new mongoose.Types.ObjectId(only);
  const [orders, clicks, visits, expenses] = await Promise.all([
    WebOrder.find(orderFilter).select("status createdAt attribution.campaignId heardFrom creditSaleId cashSaleId").lean(),
    CampaignClick.find({ ...campaignFilter, day: { $gte: range.from, $lte: range.to } }).lean(),
    CampaignVisit.find({ ...campaignFilter, day: { $gte: range.from, $lte: range.to } }).select("campaignId day").lean(),
    Expense.find({ campaignId: campaignFilter.campaignId, status: "posted", date: { $gte: range.start, $lte: range.end } }).select("campaignId amount vatAmount").lean(),
  ]);

  // The invoices of the orders that could be completed.
  const completedCandidates = orders.filter((order) => COMPLETED_STATUSES.includes(order.status));
  const creditIds = completedCandidates.filter((order) => order.creditSaleId).map((order) => order.creditSaleId);
  const cashIds = completedCandidates.filter((order) => order.cashSaleId).map((order) => order.cashSaleId);
  const invoiceFields = "items totalPrice refundedAmount refundStatus status discountAmount discountPercentage shippingFees shippingVat vatRate vatIncluded";
  const [creditSales, cashSales] = await Promise.all([
    creditIds.length ? CreditSale.find({ _id: { $in: creditIds } }).select(invoiceFields).lean() : [],
    cashIds.length ? Selling.find({ _id: { $in: cashIds } }).select(invoiceFields).lean() : [],
  ]);
  const invoices = new Map([...creditSales, ...cashSales].map((invoice) => [String(invoice._id), invoice]));

  const buckets = { campaigns: new Map(), platforms: new Map(), heard: new Map(), direct: emptyBucket(), total: emptyBucket(), days: new Map() };
  const bucketOf = (map, key) => { if (!map.has(key)) map.set(key, emptyBucket()); return map.get(key); };
  const dayOf = (day) => bucketOf(buckets.days, day);
  const apply = (campaignId, fn) => {
    const campaign = campaignId ? byCampaign.get(String(campaignId)) : null;
    fn(buckets.total);
    if (campaign) {
      fn(bucketOf(buckets.campaigns, String(campaign._id)));
      fn(bucketOf(buckets.platforms, campaign.platform));
    } else {
      fn(buckets.direct);
    }
  };

  for (const order of orders) {
    const campaignId = order.attribution && order.attribution.campaignId ? String(order.attribution.campaignId) : null;
    const day = clock.localDayString(order.createdAt);
    let sales = 0;
    let grossProfit = 0;
    let deliveryRevenue = 0;
    let completed = false;
    if (COMPLETED_STATUSES.includes(order.status)) {
      const invoice = invoices.get(String(order.creditSaleId || order.cashSaleId || ""));
      if (invoice && invoice.status !== "cancelled" && invoice.refundStatus !== "full") {
        completed = true;
        ({ sales, grossProfit, deliveryRevenue } = invoiceFigures(invoice));
      }
    }
    const count = (bucket) => {
      bucket.ordersPlaced += 1;
      if (completed) { bucket.ordersCompleted += 1; bucket.sales += sales; bucket.grossProfit += grossProfit; bucket.deliveryRevenue += deliveryRevenue; }
      if (order.status === "cancelled") bucket.ordersCancelled += 1;
      if (order.status === "rejected") bucket.ordersRejected += 1;
      if (order.status === "refused") bucket.ordersRefused += 1;
    };
    apply(campaignId, count);
    count(dayOf(day));
    count(bucketOf(buckets.heard, order.heardFrom || ""));
  }

  for (const click of clicks) apply(click.campaignId, (bucket) => { bucket.clicks += click.count; });
  for (const visit of visits) {
    apply(visit.campaignId, (bucket) => { bucket.visits += 1; });
    dayOf(visit.day).visits += 1;
  }
  for (const expense of expenses) apply(expense.campaignId, (bucket) => { bucket.spend += money(Number(expense.amount || 0) - Number(expense.vatAmount || 0)); });

  const out = (bucket, flags) => finish(bucket, { includeProfit, ...flags });
  return {
    range: { from: range.from, to: range.to },
    includeProfit,
    totals: out(buckets.total),
    campaigns: campaigns.map((campaign) => ({
      campaignId: campaign._id, name: campaign.name, code: campaign.code, platform: campaign.platform, type: campaign.type, status: campaign.status,
      ...out(bucketOf(buckets.campaigns, String(campaign._id))),
    })),
    platforms: [...buckets.platforms.entries()].map(([platform, bucket]) => ({ platform, ...out(bucket) })),
    direct: out(buckets.direct, { hasVisits: false, hasSpend: false }),
    heardFrom: [...buckets.heard.entries()].map(([answer, bucket]) => ({ answer, ...out(bucket, { hasVisits: false, hasSpend: false }) })),
    daily: [...buckets.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, bucket]) => ({ day, visits: bucket.visits, orders: bucket.ordersPlaced, sales: money(bucket.sales) })),
  };
};

module.exports = { campaignResults, invoiceFigures, rangeOf, COMPLETED_STATUSES };
