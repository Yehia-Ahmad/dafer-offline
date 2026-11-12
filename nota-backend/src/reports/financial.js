// Stage 22: the financial reports. READ-ONLY and from the LEDGER ONLY (journal lines, one aggregation each, never a per-entry loop);
// the only exception is the customer/supplier aging, which comes from the statement/open-items services so the numbers equal each
// party's statement exactly. A cancelled/reversed pair nets to 0 by itself because the reports read the ledger.
//
// One shared layer: accountTotals() groups every journal line by account into opening (before `from`) and movement (from..to),
// splitting debit and credit. The income statement, balance sheet and trial balance are all built from it.
const Account = require("../models/account.model");
const CashBox = require("../models/cashBox.model");
const Customer = require("../models/customer.model");
const Supplier = require("../models/supplier.model");
const JournalEntry = require("../models/journalEntry.model");
const ShopProfile = require("../models/shopProfile.model");
const { customerStatementBalances } = require("../services/customerStatement.service");
const { loadCustomerOpenItems, ageOpenItemsFine } = require("../services/customerOpenItems.service");
const { loadSupplierDocuments, statementFor } = require("../services/supplierStatement.service");
const { roundMoney } = require("../utils/invoicePricing");
const { now } = require("../utils/clock");

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (value) => String(value).padStart(2, "0");
const dayString = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
const addLocalDays = (date, count) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
const byCode = (left, right) => Number(left.code) - Number(right.code) || String(left.code).localeCompare(String(right.code));

// ---------------------------------------------------------------- periods

const httpError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code };
  return error;
};

const parseDay = (value, label) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) throw httpError(400, "INVALID_DATE", `${label} غير صالح (YYYY-MM-DD)`);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getMonth() !== Number(match[2]) - 1) throw httpError(400, "INVALID_DATE", `${label} غير صالح`);
  return date;
};

/** { from, to } local day boundaries. Missing: this month so far's whole month. */
const parseRange = (query) => {
  const today = now();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const fromDay = query.from ? parseDay(query.from, "من تاريخ") : first;
  const toDay = query.to ? parseDay(query.to, "إلى تاريخ") : last;
  if (toDay.getTime() < fromDay.getTime()) throw httpError(400, "INVALID_RANGE", "تاريخ البداية بعد تاريخ النهاية");
  return { fromDay, toDay, from: startOfDay(fromDay), to: endOfDay(toDay) };
};

/**
 * The previous period for the comparison column. A range that starts on the 1st of a month and ends on a month-end is N whole months:
 * it is compared with the N whole months immediately before it (a month -> the month before, Q1 -> Q4 of the year before, a whole
 * calendar or fiscal year, even across a leap February, -> the year before). Any other range is compared with the same number of days.
 */
const previousRange = ({ fromDay, toDay }) => {
  const wholeMonths = fromDay.getDate() === 1 && addLocalDays(toDay, 1).getDate() === 1;
  let prevFrom; let prevTo;
  if (wholeMonths) {
    const months = (toDay.getFullYear() * 12 + toDay.getMonth()) - (fromDay.getFullYear() * 12 + fromDay.getMonth()) + 1;
    prevFrom = new Date(fromDay.getFullYear(), fromDay.getMonth() - months, 1); prevTo = new Date(fromDay.getFullYear(), fromDay.getMonth(), 0);
  } else {
    const length = Math.round((Date.UTC(toDay.getFullYear(), toDay.getMonth(), toDay.getDate()) - Date.UTC(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate())) / DAY_MS) + 1;
    prevTo = addLocalDays(fromDay, -1); prevFrom = addLocalDays(prevTo, -(length - 1));
  }
  return { fromDay: prevFrom, toDay: prevTo, from: startOfDay(prevFrom), to: endOfDay(prevTo) };
};

const rangeView = (range) => ({ from: dayString(range.fromDay), to: dayString(range.toDay) });

// ---------------------------------------------------------------- the shared aggregation layer

/**
 * One pipeline: every journal line grouped by account into opening (date < from) and movement (from <= date <= to), debit and credit
 * apart. Without `from` everything up to `to` is movement. `excludeClose` leaves out the year-end closing entry and its reversal
 * (source period_close), which the income statement must not see. `onlyMovement` skips the entries before `from` altogether.
 * @returns {Promise<Map<string, {openDebit, openCredit, movDebit, movCredit}>>} by account id
 */
const accountTotals = async ({ from = null, to, excludeClose = false, onlyMovement = false, session = null }) => {
  const match = { status: "posted", date: { ...(onlyMovement && from ? { $gte: from } : {}), $lte: to }, ...(excludeClose ? { "source.type": { $ne: "period_close" } } : {}) };
  const isOpen = from ? { $lt: ["$date", from] } : false;
  const sumIf = (condition, field) => ({ $sum: { $cond: [condition, field, 0] } });
  const rows = await JournalEntry.aggregate([
    { $match: match }, { $unwind: "$lines" },
    { $group: {
      _id: "$lines.accountId",
      openDebit: sumIf(isOpen, "$lines.debit"), openCredit: sumIf(isOpen, "$lines.credit"),
      movDebit: from ? sumIf({ $not: [isOpen] }, "$lines.debit") : { $sum: "$lines.debit" },
      movCredit: from ? sumIf({ $not: [isOpen] }, "$lines.credit") : { $sum: "$lines.credit" },
    } },
  ]).allowDiskUse(true).session(session);
  const totals = new Map();
  for (const row of rows) {
    totals.set(String(row._id), {
      openDebit: roundMoney(row.openDebit), openCredit: roundMoney(row.openCredit), movDebit: roundMoney(row.movDebit), movCredit: roundMoney(row.movCredit),
    });
  }
  return totals;
};

const ZERO = Object.freeze({ openDebit: 0, openCredit: 0, movDebit: 0, movCredit: 0 });
const totalsOf = (totals, account) => totals.get(String(account._id)) || ZERO;
/** movement net (debit - credit) / opening net / closing net of one account. */
const movementNet = (t) => roundMoney(t.movDebit - t.movCredit);
const openingNet = (t) => roundMoney(t.openDebit - t.openCredit);
const closingNet = (t) => roundMoney(openingNet(t) + movementNet(t));

const loadChart = async (session = null) => {
  const accounts = await Account.find({}).sort({ code: 1 }).session(session).lean();
  const children = new Map();
  for (const account of accounts) {
    const key = account.parentId ? String(account.parentId) : "root";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(account);
  }
  for (const list of children.values()) list.sort(byCode);
  return { accounts, byId: new Map(accounts.map((account) => [String(account._id), account])), byKey: new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey, a])), children, rootByCode: new Map(accounts.filter((a) => !a.parentId).map((a) => [a.code, a])) };
};

const kidsOf = (chart, account) => chart.children.get(String(account._id)) || [];
const shopNameOf = async () => (await ShopProfile.findOne({ key: "default" }).select("name").lean())?.name || "";
const sideOfBalance = (balance, normalSide) => (balance > 0 ? "debit" : balance < 0 ? "credit" : normalSide);

const baseRow = (account, extra) => ({ id: String(account._id), accountId: account._id, code: account.code, nameAr: account.nameAr, nameEn: account.nameEn, isGroup: Boolean(account.isGroup), isActive: account.isActive !== false, ...extra });

// ---------------------------------------------------------------- income statement

const INVOICE_KEYS = ["SALES", "SALES_RETURNS", "SALES_DISCOUNT", "SHIPPING_INCOME"];

const incomeStatement = async ({ range, compare = false }) => {
  const chart = await loadChart();
  const prevRange = compare ? previousRange(range) : null;
  const [current, previous] = await Promise.all([
    accountTotals({ from: range.from, to: range.to, excludeClose: true, onlyMovement: true }),
    prevRange ? accountTotals({ from: prevRange.from, to: prevRange.to, excludeClose: true, onlyMovement: true }) : null,
  ]);
  // amount of an account in the statement's own direction: revenue accounts credit - debit, expense accounts debit - credit
  const amountOf = (totals, account, direction) => (totals ? roundMoney(direction * movementNet(totalsOf(totals, account))) : null);
  const leafRow = (account, direction, sign) => {
    const amount = amountOf(current, account, direction); const prev = amountOf(previous, account, direction);
    return baseRow(account, { kind: "line", sign, amount, previous: prev, change: prev === null ? null : roundMoney(amount - prev), isZero: amount === 0 && !prev });
  };
  const nodeRow = (account, direction, sign) => {
    const kids = kidsOf(chart, account);
    if (!account.isGroup && !kids.length) return leafRow(account, direction, sign);
    const children = kids.map((kid) => nodeRow(kid, direction, sign));
    const amount = roundMoney(children.reduce((sum, row) => sum + row.amount, 0));
    const prev = previous ? roundMoney(children.reduce((sum, row) => sum + (row.previous || 0), 0)) : null;
    return baseRow(account, { kind: "group", sign, amount, previous: prev, change: prev === null ? null : roundMoney(amount - prev), children, isZero: children.every((row) => row.isZero) });
  };
  const key = (name) => chart.byKey.get(name);
  const money = (...rows) => ({ amount: roundMoney(rows.reduce((sum, row) => sum + (row.amount ?? 0) * (row.sign ?? 1), 0)), previous: previous ? roundMoney(rows.reduce((sum, row) => sum + (row.previous ?? 0) * (row.sign ?? 1), 0)) : null });
  const named = (name, direction, sign) => leafRow(key(name), direction, sign);

  const sales = named("SALES", -1, 1);
  const salesReturns = named("SALES_RETURNS", 1, -1);
  const discount = named("SALES_DISCOUNT", 1, -1);
  const shipping = named("SHIPPING_INCOME", -1, 1);
  const subtotal = (id, nameAr, nameEn, parts) => { const sum = money(...parts); return { id, kind: "subtotal", nameAr, nameEn, sign: 1, amount: sum.amount, previous: sum.previous, change: sum.previous === null ? null : roundMoney(sum.amount - sum.previous), isZero: sum.amount === 0 && !sum.previous }; };
  const netSales = subtotal("netSales", "صافي المبيعات", "Net sales", [sales, salesReturns, discount, shipping]);
  const cogs = named("COGS", 1, -1);
  const grossProfit = subtotal("grossProfit", "مجمل الربح", "Gross profit", [{ ...netSales, sign: 1 }, cogs]);

  const root5 = chart.rootByCode.get("5"); const root4 = chart.rootByCode.get("4");
  const expenseRows = kidsOf(chart, root5).filter((account) => account.systemKey !== "COGS").map((account) => nodeRow(account, 1, -1));
  const totalExpenses = { amount: roundMoney(expenseRows.reduce((sum, row) => sum + row.amount, 0)), previous: previous ? roundMoney(expenseRows.reduce((sum, row) => sum + (row.previous || 0), 0)) : null };
  const expenses = { id: "expenses", kind: "group", nameAr: "المصروفات", nameEn: "Expenses", sign: -1, amount: totalExpenses.amount, previous: totalExpenses.previous, change: previous ? roundMoney(totalExpenses.amount - totalExpenses.previous) : null, children: expenseRows, isZero: expenseRows.every((row) => row.isZero) };
  const otherRows = kidsOf(chart, root4).filter((account) => !INVOICE_KEYS.includes(account.systemKey)).map((account) => nodeRow(account, -1, 1));
  const otherTotal = { amount: roundMoney(otherRows.reduce((sum, row) => sum + row.amount, 0)), previous: previous ? roundMoney(otherRows.reduce((sum, row) => sum + (row.previous || 0), 0)) : null };
  const otherIncome = { id: "otherIncome", kind: "group", nameAr: "إيرادات أخرى", nameEn: "Other income", sign: 1, amount: otherTotal.amount, previous: otherTotal.previous, change: previous ? roundMoney(otherTotal.amount - otherTotal.previous) : null, children: otherRows, isZero: otherRows.every((row) => row.isZero) };
  const netProfit = subtotal("netProfit", "صافي الربح", "Net profit", [{ ...grossProfit, sign: 1 }, { ...expenses, sign: -1 }, otherIncome]);
  netProfit.kind = "total";
  const margin = (profit, net) => (net ? roundMoney((profit / net) * 100) : 0);
  const marginRow = { id: "grossMargin", kind: "percent", nameAr: "هامش مجمل الربح %", nameEn: "Gross margin %", sign: 1, amount: margin(grossProfit.amount, netSales.amount), previous: previous ? margin(grossProfit.previous, netSales.previous) : null, isZero: false };
  marginRow.change = previous ? roundMoney(marginRow.amount - marginRow.previous) : null;

  // The ledger's own net profit for the period (every revenue and expense account), as a check against the rows above.
  const plAccounts = chart.accounts.filter((account) => !account.isGroup && (account.type === "revenue" || account.type === "expense"));
  const ledgerNetProfit = roundMoney(-plAccounts.reduce((sum, account) => sum + movementNet(totalsOf(current, account)), 0));
  return {
    report: "income-statement", period: rangeView(range), comparison: prevRange ? rangeView(prevRange) : null, shopName: await shopNameOf(), currency: "EGP",
    rows: [sales, salesReturns, discount, shipping, netSales, cogs, grossProfit, expenses, otherIncome, netProfit, marginRow],
    summary: {
      sales: sales.amount, netSales: netSales.amount, cogs: cogs.amount, grossProfit: grossProfit.amount, totalExpenses: totalExpenses.amount, otherIncome: otherTotal.amount,
      netProfit: netProfit.amount, grossMarginPct: marginRow.amount,
      ...(previous ? { previous: { netSales: netSales.previous, grossProfit: grossProfit.previous, totalExpenses: totalExpenses.previous, netProfit: netProfit.previous, grossMarginPct: marginRow.previous } } : {}),
    },
    check: { ledgerNetProfit, difference: roundMoney(netProfit.amount - ledgerNetProfit) },
  };
};

// ---------------------------------------------------------------- balance sheet

const balanceSheet = async ({ asOfDay }) => {
  const chart = await loadChart();
  const asOf = endOfDay(asOfDay);
  const totals = await accountTotals({ to: asOf });
  const balanceOf = (account) => closingNet(totalsOf(totals, account)); // movement = everything up to asOf
  const row = (account, sign, children = null, balance = null) => {
    const raw = balance === null ? balanceOf(account) : balance;
    const side = sideOfBalance(raw, account.normalSide);
    // credit-side sections (liabilities, equity) show credit - debit as the amount, assets debit - credit
    const amount = roundMoney(sign * raw);
    return baseRow(account, { kind: children ? "group" : "line", balance: raw, amount, side, absBalance: roundMoney(Math.abs(raw)), opposite: raw !== 0 && side !== account.normalSide, ...(children ? { children } : {}), isZero: raw === 0 });
  };
  const node = (account, sign) => {
    const kids = kidsOf(chart, account);
    if (!account.isGroup && !kids.length) return row(account, sign);
    const children = kids.map((kid) => node(kid, sign));
    const balance = roundMoney(children.reduce((sum, child) => sum + child.balance, 0));
    const group = row(account, sign, children, balance);
    group.isZero = children.every((child) => child.isZero);
    return group;
  };
  const assetsRoot = chart.rootByCode.get("1"); const liabilitiesRoot = chart.rootByCode.get("2"); const equityRoot = chart.rootByCode.get("3");
  const assets = node(assetsRoot, 1); const liabilities = node(liabilitiesRoot, -1); const equityTree = node(equityRoot, -1);
  // current-period profit = revenue - expenses not yet closed into 32 (zero after the year-end closing entry)
  const plAccounts = chart.accounts.filter((account) => !account.isGroup && (account.type === "revenue" || account.type === "expense"));
  const periodProfit = roundMoney(-plAccounts.reduce((sum, account) => sum + balanceOf(account), 0));
  const profitRow = { id: "currentProfit", kind: "line", nameAr: "أرباح الفترة الحالية", nameEn: "Current-period profit", amount: periodProfit, balance: -periodProfit, side: periodProfit >= 0 ? "credit" : "debit", absBalance: Math.abs(periodProfit), opposite: periodProfit < 0, isZero: periodProfit === 0 };
  const equity = { ...equityTree, children: [...equityTree.children, profitRow], amount: roundMoney(equityTree.amount + periodProfit), isZero: equityTree.isZero && periodProfit === 0 };
  const totalAssets = assets.amount; const totalLiabilities = liabilities.amount; const totalEquity = equity.amount;
  return {
    report: "balance-sheet", asOf: dayString(asOfDay), shopName: await shopNameOf(), currency: "EGP",
    sections: { assets, liabilities, equity },
    totals: { assets: totalAssets, liabilities: totalLiabilities, equity: totalEquity, liabilitiesAndEquity: roundMoney(totalLiabilities + totalEquity) },
    periodProfit,
    check: { assets: totalAssets, liabilitiesAndEquity: roundMoney(totalLiabilities + totalEquity), difference: roundMoney(totalAssets - totalLiabilities - totalEquity) },
  };
};

// ---------------------------------------------------------------- trial balance

const trialBalance = async ({ range }) => {
  const chart = await loadChart();
  const totals = await accountTotals({ from: range.from, to: range.to });
  const split = (net) => ({ debit: net > 0 ? roundMoney(net) : 0, credit: net < 0 ? roundMoney(-net) : 0 });
  const columns = (t) => ({
    openingDebit: split(openingNet(t)).debit, openingCredit: split(openingNet(t)).credit,
    movementDebit: t.movDebit, movementCredit: t.movCredit,
    closingDebit: split(closingNet(t)).debit, closingCredit: split(closingNet(t)).credit,
  });
  const sumColumns = (rows) => Object.fromEntries(["openingDebit", "openingCredit", "movementDebit", "movementCredit", "closingDebit", "closingCredit"].map((name) => [name, roundMoney(rows.reduce((sum, row) => sum + row[name], 0))]));
  const node = (account) => {
    const kids = kidsOf(chart, account);
    if (!account.isGroup && !kids.length) {
      const cols = columns(totalsOf(totals, account));
      return baseRow(account, { kind: "line", ...cols, isZero: Object.values(cols).every((value) => value === 0) });
    }
    const children = kids.map(node);
    const cols = sumColumns(children);
    return baseRow(account, { kind: "group", ...cols, children, isZero: children.every((child) => child.isZero) });
  };
  const rows = (chart.children.get("root") || []).map(node);
  const grand = sumColumns(rows);
  return {
    report: "trial-balance", period: rangeView(range), shopName: await shopNameOf(), currency: "EGP", rows, totals: grand,
    balanced: grand.openingDebit === grand.openingCredit && grand.movementDebit === grand.movementCredit && grand.closingDebit === grand.closingCredit,
  };
};

// ---------------------------------------------------------------- box movements

const BOX_KINDS = [
  { key: "opening", ar: "رصيد أول المدة", en: "Opening balance entry" },
  { key: "sales", ar: "مبيعات", en: "Sales" },
  { key: "receipts", ar: "تحصيلات", en: "Receipts" },
  { key: "refunds", ar: "مرتجعات وردّ", en: "Refunds" },
  { key: "invoiceEdit", ar: "تعديل فاتورة", en: "Invoice edit" },
  { key: "expenses", ar: "مصروفات", en: "Expenses" },
  { key: "transfers", ar: "تحويلات", en: "Transfers" },
  { key: "shiftDiff", ar: "عجز وزيادة الورديات", en: "Shift differences" },
  { key: "supplierPayments", ar: "سداد موردين (PV)", en: "Supplier payments (PV)" },
  { key: "supplierRefunds", ar: "استرداد من موردين (SR)", en: "Supplier refunds (SR)" },
  { key: "vatPayments", ar: "سداد ضريبة", en: "VAT payments" },
  { key: "drawings", ar: "مسحوبات المالك", en: "Owner drawings" },
  { key: "payouts", ar: "صرف أرصدة العملاء", en: "Customer payouts" },
  { key: "other", ar: "أخرى", en: "Other" },
];
const KIND_BY_SOURCE = {
  sale: "sales", sale_edit: "invoiceEdit", credit_sale_edit: "invoiceEdit", auto_restock: "sales", receipt: "receipts", return: "refunds", refund: "refunds",
  expense: "expenses", transfer: "transfers", shift: "shiftDiff", shift_open: "shiftDiff", supplier_payment: "supplierPayments", supplier_refund: "supplierRefunds",
  vat_payment: "vatPayments", owner_drawing: "drawings", customer_payout: "payouts", opening: "opening", opening_inventory: "opening",
};
// An invoice edit reverses the sale entry and posts it again (both carry one of these memos, see postInvoiceEdit): together they are
// "تعديل فاتورة" and show only the net, never as a refund plus a new sale.
const EDIT_MEMOS = ["Sale edit", "Credit sale edit"];
/** The kind of a box line from its entry: an invoice edit (its reversal and re-post) is its own kind; a cancelled sale or credit sale (a reversal / legacy reversal) is a refund paid out of the box. */
const boxKindOf = (sourceType, entryType, isEdit = false) => {
  if (isEdit && (sourceType === "sale" || sourceType === "credit_sale")) return "invoiceEdit";
  if ((sourceType === "sale" || sourceType === "credit_sale") && (entryType === "reversal" || entryType === "legacy_reversal")) return "refunds";
  return KIND_BY_SOURCE[sourceType] || "other";
};

const boxMovements = async ({ range }) => {
  const boxes = await CashBox.find({}).sort({ sortOrder: 1, createdAt: 1 }).lean();
  const accounts = await Account.find({ _id: { $in: boxes.map((box) => box.accountId) } }).select("code nameAr").lean();
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const ids = boxes.map((box) => box.accountId);
  const rows = ids.length ? await JournalEntry.aggregate([
    { $match: { status: "posted", date: { $lte: range.to }, "lines.accountId": { $in: ids } } }, { $unwind: "$lines" }, { $match: { "lines.accountId": { $in: ids } } },
    { $group: { _id: { accountId: "$lines.accountId", before: { $lt: ["$date", range.from] }, source: "$source.type", entry: "$type", edit: { $in: ["$memo", EDIT_MEMOS] } }, debit: { $sum: "$lines.debit" }, credit: { $sum: "$lines.credit" } } },
  ]).allowDiskUse(true) : [];
  const perBox = new Map(boxes.map((box) => [String(box.accountId), { opening: 0, byKind: new Map() }]));
  for (const row of rows) {
    const target = perBox.get(String(row._id.accountId));
    if (!target) continue;
    if (row._id.before) { target.opening = roundMoney(target.opening + row.debit - row.credit); continue; }
    const kind = boxKindOf(row._id.source, row._id.entry, row._id.edit);
    const cell = target.byKind.get(kind) || { in: 0, out: 0 };
    cell.in = roundMoney(cell.in + row.debit); cell.out = roundMoney(cell.out + row.credit);
    target.byKind.set(kind, cell);
  }
  const labelOf = new Map(BOX_KINDS.map((kind) => [kind.key, kind]));
  const result = boxes.map((box) => {
    const data = perBox.get(String(box.accountId));
    const byKind = BOX_KINDS.filter((kind) => data.byKind.has(kind.key)).map((kind) => ({ key: kind.key, ar: kind.ar, en: kind.en, in: data.byKind.get(kind.key).in, out: data.byKind.get(kind.key).out }));
    const inTotal = roundMoney(byKind.reduce((sum, kind) => sum + kind.in, 0)); const outTotal = roundMoney(byKind.reduce((sum, kind) => sum + kind.out, 0));
    const account = accountById.get(String(box.accountId));
    return {
      boxId: box._id, accountId: box.accountId, name: box.name, type: box.type, isMain: Boolean(box.isMain), isActive: box.isActive !== false, accountCode: account?.code || null,
      opening: data.opening, in: inTotal, out: outTotal, closing: roundMoney(data.opening + inTotal - outTotal), byKind,
    };
  });
  const sum = (field) => roundMoney(result.reduce((total, box) => total + box[field], 0));
  const kindTotals = new Map();
  for (const box of result) for (const kind of box.byKind) {
    const cell = kindTotals.get(kind.key) || { in: 0, out: 0 };
    cell.in = roundMoney(cell.in + kind.in); cell.out = roundMoney(cell.out + kind.out); kindTotals.set(kind.key, cell);
  }
  return {
    report: "box-movements", period: rangeView(range), shopName: await shopNameOf(), currency: "EGP", kinds: BOX_KINDS, boxes: result,
    totals: { opening: sum("opening"), in: sum("in"), out: sum("out"), closing: sum("closing"), byKind: [...kindTotals.entries()].map(([key, cell]) => ({ key, ar: labelOf.get(key).ar, en: labelOf.get(key).en, ...cell })) },
  };
};

// ---------------------------------------------------------------- customer and supplier balances / aging

const BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90plus"];

const partyBalances = async ({ type = "all" } = {}) => {
  const out = { report: "party-balances", asOf: dayString(now()), shopName: await shopNameOf(), currency: "EGP" };
  const totalsOf2 = (rows) => ({
    count: rows.length, balance: roundMoney(rows.reduce((sum, row) => sum + row.balance, 0)),
    ...Object.fromEntries(BUCKETS.map((bucket) => [bucket, roundMoney(rows.reduce((sum, row) => sum + row.aging[bucket], 0))])),
    advance: roundMoney(rows.reduce((sum, row) => sum + row.advance, 0)), openTotal: roundMoney(rows.reduce((sum, row) => sum + row.aging.total, 0)),
  });
  if (type === "all" || type === "customers") {
    const customers = await Customer.find({}).select("_id name phone").sort({ name: 1 }).lean();
    // The statement balance (customerStatementBalances) and the open items (loadCustomerOpenItems): the same two sources as each statement.
    const [{ balances }, open] = await Promise.all([customerStatementBalances(customers), loadCustomerOpenItems()]);
    const rows = customers.map((customer) => {
      const balance = roundMoney(balances.get(String(customer._id)) || 0);
      const aging = ageOpenItemsFine(open.get(String(customer._id))?.items || []);
      return { partyId: customer._id, name: customer.name, phone: customer.phone || null, balance, side: balance >= 0 ? "debit" : "credit", absBalance: roundMoney(Math.abs(balance)), opposite: balance < 0, aging, advance: roundMoney(Math.max(0, -balance)), isZero: balance === 0 && aging.total === 0 };
    });
    out.customers = { rows, totals: totalsOf2(rows) };
  }
  if (type === "all" || type === "suppliers") {
    const suppliers = await Supplier.find({}).select("_id name phones paymentTermsDays").sort({ name: 1 }).lean();
    const docs = await loadSupplierDocuments(null);
    const rows = suppliers.map((supplier) => {
      const statement = statementFor(supplier, docs);
      const balance = roundMoney(statement.balance); // positive = we owe the supplier
      const aging = Object.fromEntries([...BUCKETS, "total"].map((key) => [key, roundMoney(statement.aging[key] || 0)]));
      return { partyId: supplier._id, name: supplier.name, phone: Array.isArray(supplier.phones) ? supplier.phones[0] || null : null, balance, side: balance >= 0 ? "credit" : "debit", absBalance: roundMoney(Math.abs(balance)), opposite: balance < 0, aging, advance: roundMoney(statement.aging.advance || 0), isZero: balance === 0 && aging.total === 0 };
    });
    out.suppliers = { rows, totals: totalsOf2(rows) };
  }
  return out;
};

module.exports = {
  parseRange, previousRange, parseDay, accountTotals, incomeStatement, balanceSheet, trialBalance, boxMovements, partyBalances, BOX_KINDS, BUCKETS, httpError, dayString,
};
