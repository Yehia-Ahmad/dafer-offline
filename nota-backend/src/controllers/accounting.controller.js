const mongoose = require("mongoose");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const Customer = require("../models/customer.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const CreditSale = require("../models/creditSale.model");
const ReturnLog = require("../models/returnLog.model");
const Receipt = require("../models/receipt.model");
const Meta = require("../models/meta.model");
const { roundMoney } = require("../utils/invoicePricing");
const { isLedgerDocument, returnedUnits } = require("../accounting/posting");
const { customerStatementBalances } = require("../services/customerStatement.service");

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Query date → Date. A date-only value (YYYY-MM-DD) means the start or the
 * end of that day in the server's local time; anything else is parsed as is.
 */
const parseQueryDate = (value, { endOfDay = false } = {}) => {
  if (value === undefined || value === null || value === "") return null;
  const match = DATE_ONLY.exec(String(value));
  if (match) {
    const [, year, month, day] = match.map(Number);
    return endOfDay ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day, 0, 0, 0, 0);
  }
  return new Date(value);
};

const getAccounts = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const asOf = parseQueryDate(req.query.asOf, { endOfDay: true }) || new Date();
  if (Number.isNaN(asOf.getTime())) { res.status(400); throw new Error("Invalid asOf"); }
  const [accounts, balances] = await Promise.all([
    Account.find({}).sort({ code: 1 }).lean(),
    JournalEntry.aggregate([
      { $match: { date: { $lte: asOf }, status: "posted" } },
      { $unwind: "$lines" },
      { $group: { _id: { accountId: "$lines.accountId", partyId: "$lines.partyId" }, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
    ]),
  ]);
  const direct = new Map();
  for (const row of balances) direct.set(String(row._id.accountId), roundMoney((direct.get(String(row._id.accountId)) || 0) + Number(row.balance || 0)));
  const rows = accounts.map((account) => ({ ...account, balance: direct.get(String(account._id)) || 0, children: [] }));
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  for (const row of rows) if (row.parentId && byId.has(String(row.parentId))) byId.get(String(row.parentId)).children.push(row);
  const roll = (row) => { row.balance = roundMoney(row.balance + row.children.reduce((sum, child) => sum + roll(child), 0)); return row.balance; };
  const roots = rows.filter((row) => !row.parentId); roots.forEach(roll);
  const customerAccount = rows.find((row) => row.systemKey === "CUSTOMERS");
  if (customerAccount) {
    const partyBalances = balances.filter((row) => String(row._id.accountId) === String(customerAccount._id) && row._id.partyId && roundMoney(row.balance) !== 0);
    const customers = await Customer.find({ _id: { $in: partyBalances.map((row) => row._id.partyId) } }).select("_id name phone").lean();
    const byCustomer = new Map(customers.map((customer) => [String(customer._id), customer]));
    customerAccount.virtualCustomers = partyBalances.map((row) => ({ ...(byCustomer.get(String(row._id.partyId)) || { _id: row._id.partyId, name: "" }), virtual: true, balance: roundMoney(row.balance) }));
  }
  res.json({ asOf, accounts: roots });
};

const getLedger = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404); throw new Error("Account not found"); }
  const account = await Account.findById(req.params.id).lean();
  if (!account) { res.status(404); throw new Error("Account not found"); }
  if (req.query.partyId && !mongoose.Types.ObjectId.isValid(req.query.partyId)) { res.status(400); throw new Error("Invalid partyId"); }
  const partyId = req.query.partyId ? new mongoose.Types.ObjectId(req.query.partyId) : null;
  const from = parseQueryDate(req.query.from);
  const to = parseQueryDate(req.query.to, { endOfDay: true });
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) { res.status(400); throw new Error("Invalid date range"); }
  const lineMatch = { "lines.accountId": account._id, ...(partyId ? { "lines.partyId": partyId } : {}) };
  // One row per line of THIS account (never the entry's other lines).
  const linesPipeline = [
    { $match: { status: "posted", "lines.accountId": account._id, ...(from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    { $unwind: "$lines" },
    { $match: lineMatch },
    { $project: { _id: 0, entryId: "$_id", number: 1, date: 1, source: 1, memo: 1, type: 1, line: "$lines" } },
  ];
  const openingPipeline = [
    { $match: { status: "posted", date: { $lt: from || new Date(0) }, "lines.accountId": account._id } },
    { $unwind: "$lines" },
    { $match: lineMatch },
    { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ];
  const [rows, openingRows, parties] = await Promise.all([
    JournalEntry.aggregate(linesPipeline),
    from ? JournalEntry.aggregate(openingPipeline) : Promise.resolve([]),
    account.systemKey === "CUSTOMERS" ? Customer.find({}).select("_id name phone").sort({ name: 1 }).lean() : Promise.resolve([]),
  ]);
  const openingBalance = roundMoney(openingRows[0]?.balance || 0);
  let balance = openingBalance;
  const output = rows.map(({ line, ...entry }) => {
    balance = roundMoney(balance + Number(line.debit || 0) - Number(line.credit || 0));
    return { ...line, ...entry, balance };
  });
  res.json({ account, parties, openingBalance, lines: output, balance });
};

const getJournal = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const query = {}; if (req.query.type) query.type = req.query.type; if (req.query.sourceType) query["source.type"] = req.query.sourceType; if (req.query.sourceId && mongoose.Types.ObjectId.isValid(req.query.sourceId)) query["source.id"] = req.query.sourceId; if (req.query.sourceNumber) query["source.number"] = req.query.sourceNumber; if (req.query.number) query.number = req.query.number; if (req.query.accountId) query["lines.accountId"] = req.query.accountId; if (req.query.partyId) query["lines.partyId"] = req.query.partyId;
  const from = parseQueryDate(req.query.from);
  const to = parseQueryDate(req.query.to, { endOfDay: true });
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) { res.status(400); throw new Error("Invalid date range"); }
  if (from || to) { query.date = {}; if (from) query.date.$gte = from; if (to) query.date.$lte = to; }
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [data, totalItems] = await Promise.all([JournalEntry.find(query).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), JournalEntry.countDocuments(query)]);
  res.json({ data, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

const getJournalEntry = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) { res.status(404); throw new Error("Journal entry not found"); }
  const entry = await JournalEntry.findById(req.params.id).lean(); if (!entry) { res.status(404); throw new Error("Journal entry not found"); } res.json(entry);
};

const check = (expected, actual, extra = {}) => ({ expected: roundMoney(expected), actual: roundMoney(actual), difference: roundMoney(actual - expected), ...extra });
const sum = (rows, fn) => rows.reduce((total, row) => total + Number(fn(row) || 0), 0);

/**
 * Expected COGS removed by cancelling a pre-ledger invoice, from operational
 * data only: the purchasePrice snapshot taken at cancel time × (quantity −
 * units returned in the pre-ledger return logs). A line without a snapshot
 * counts as 0, so a missing snapshot shows up as a cogs difference.
 */
const expectedLegacyCancelCost = (invoice, preLogs) => {
  const items = invoice.items || [];
  const snapshot = new Map((invoice.ledgerTrace?.cancelLines || []).map((row) => [String(row.invoiceItemId), Number(row.purchasePrice || 0)]));
  const returned = new Map();
  for (const log of preLogs) {
    for (const logItem of log.items || []) {
      const lineItem = items.find((item) => logItem.invoiceItemId && String(item._id) === String(logItem.invoiceItemId))
        || items.find((item) => String(item.product || item.productId || "") === String(logItem.productId || logItem.product || ""));
      if (lineItem) returned.set(String(lineItem._id), (returned.get(String(lineItem._id)) || 0) + Number(logItem.quantity || 0));
    }
  }
  return roundMoney(items.reduce((total, item) => total + (snapshot.get(String(item._id)) || 0)
    * Math.max(0, Number(item.quantity || 0) - (returned.get(String(item._id)) || 0)), 0));
};

/**
 * Accounting health. Every "actual" comes from journal lines; every
 * "expected" comes only from operational data (invoices, returns, receipts,
 * products, customer statements). No ledger number feeds an expected value.
 */
const getHealth = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const [lineTotals, balances, documentSources, products, customers, sales, credits, returns, receipts, meta, accounts] = await Promise.all([
    // Trial balance from the lines themselves, never the stored entry totals.
    JournalEntry.aggregate([{ $match: { status: "posted" } }, { $unwind: "$lines" }, { $group: { _id: null, debit: { $sum: "$lines.debit" }, credit: { $sum: "$lines.credit" } } }]),
    JournalEntry.aggregate([{ $match: { status: "posted" } }, { $unwind: "$lines" }, { $group: { _id: { accountId: "$lines.accountId", partyId: "$lines.partyId" }, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]),
    JournalEntry.aggregate([
      { $match: { status: "posted", "source.type": { $in: ["sale", "credit_sale", "return", "receipt"] } } },
      { $group: { _id: { type: "$source.type", id: "$source.id" } } },
      { $group: { _id: "$_id.type", ids: { $addToSet: "$_id.id" } } },
    ]),
    Product.find({}).select("inventoryCount purchasePrice").lean(),
    Customer.find({}).select("_id name").lean(),
    Selling.find({}).select("+ledgerTrace").lean(),
    CreditSale.find({}).select("+ledgerTrace").lean(),
    ReturnLog.find({}).lean(),
    Receipt.find({}).select("_id createdAt").lean(),
    Meta.findById("schema").lean(),
    Account.find({ systemKey: { $ne: null } }).lean(),
  ]);
  const ledgerStartAt = meta?.ledgerStartAt ? new Date(meta.ledgerStartAt) : null;
  const inLedger = (doc) => isLedgerDocument(doc, ledgerStartAt);
  const byKey = new Map(accounts.map((account) => [account.systemKey, account]));
  const accountBalance = new Map(); const partyBalance = new Map();
  const customerAccountId = String(byKey.get("CUSTOMERS")?._id || "");
  for (const row of balances) {
    const accountId = String(row._id.accountId);
    accountBalance.set(accountId, roundMoney((accountBalance.get(accountId) || 0) + Number(row.balance || 0)));
    if (accountId === customerAccountId && row._id.partyId) partyBalance.set(String(row._id.partyId), roundMoney((partyBalance.get(String(row._id.partyId)) || 0) + Number(row.balance || 0)));
  }
  const actual = (key) => accountBalance.get(String(byKey.get(key)?._id)) || 0;

  // 1. Trial balance: Σ line debits − Σ line credits.
  const trialBalance = check(0, Number(lineTotals[0]?.debit || 0) - Number(lineTotals[0]?.credit || 0));

  // 2. Inventory: stock on hand at the current purchase price.
  const inventory = check(sum(products, (product) => Number(product.inventoryCount || 0) * Number(product.purchasePrice || 0)), actual("INVENTORY"));

  // 3. Customers: each customer's ledger party balance against that customer's
  //    Stage 16 statement closing balance. difference = Σ |per-customer difference|.
  const { balances: statementBalances } = await customerStatementBalances(customers);
  const partyIds = new Set([...statementBalances.keys(), ...partyBalance.keys()]);
  const names = new Map(customers.map((customer) => [String(customer._id), customer.name]));
  const byCustomer = [];
  let expectedCustomers = 0; let absoluteDifference = 0;
  for (const id of partyIds) {
    const expected = roundMoney(statementBalances.get(id) || 0);
    const ledger = roundMoney(partyBalance.get(id) || 0);
    expectedCustomers += expected;
    const difference = roundMoney(ledger - expected);
    if (difference) { absoluteDifference += Math.abs(difference); byCustomer.push({ customerId: id, name: names.get(id) ?? null, expected, actual: ledger, difference }); }
  }
  const customerTotal = actual("CUSTOMERS");
  const unassigned = roundMoney(customerTotal - sum([...partyBalance.values()], (value) => value));
  const customersCheck = {
    expected: roundMoney(expectedCustomers), actual: roundMoney(customerTotal),
    difference: roundMoney(absoluteDifference + Math.abs(unassigned)),
    totalDifference: roundMoney(customerTotal - expectedCustomers), unassignedLines: unassigned, byCustomer,
  };

  // 4 + 5. Net sales and COGS that the ledger should hold for the ledger period.
  const returnsByInvoice = new Map();
  for (const row of returns) { const key = String(row.invoiceId); if (!returnsByInvoice.has(key)) returnsByInvoice.set(key, []); returnsByInvoice.get(key).push(row); }
  let expectedNetSales = 0; let expectedCogs = 0;
  for (const invoice of [...sales, ...credits]) {
    const cancelled = invoice.status === "cancelled";
    const items = invoice.items || [];
    if (inLedger(invoice)) {
      if (cancelled) continue;
      expectedNetSales += Number(invoice.totalPrice || 0) - Number(invoice.refundedAmount || 0);
      expectedCogs += sum(items, (item) => Number(item.purchasePrice || 0) * Math.max(0, Number(item.quantity || 0) - returnedUnits(invoice, item)));
      continue;
    }
    // Pre-ledger invoice: only what happened to it after the ledger started.
    const logs = returnsByInvoice.get(String(invoice._id)) || [];
    const postLogs = logs.filter(inLedger); const preLogs = logs.filter((row) => !inLedger(row));
    const trace = invoice.ledgerTrace || {};
    expectedNetSales += Number(trace.editNetSales || 0);
    expectedCogs += Number(trace.editCost || 0);
    const cancelledInLedger = cancelled && invoice.cancelledAt && (!ledgerStartAt || new Date(invoice.cancelledAt) >= ledgerStartAt);
    if (cancelledInLedger) {
      expectedNetSales -= Number(invoice.totalPrice || 0) - sum(preLogs, (row) => row.finalReturnedAmount);
      expectedCogs -= expectedLegacyCancelCost(invoice, preLogs);
    } else if (!cancelled) {
      expectedNetSales -= sum(postLogs, (row) => row.finalReturnedAmount);
      expectedCogs -= sum(postLogs, (row) => sum(row.items || [], (item) => Number(item.purchasePrice || 0) * Number(item.quantity || 0)));
    }
  }
  const netSalesActual = -(actual("SALES") + actual("SALES_RETURNS") + actual("SALES_DISCOUNT") + actual("SHIPPING_INCOME"));
  const netSales = check(expectedNetSales, netSalesActual);
  const cogs = check(expectedCogs, actual("COGS"));

  // 6. Coverage: every ledger-period document has an entry, and no entry is orphaned.
  const sourceRows = new Map(documentSources.map((row) => [row._id, row]));
  const cancelledInLedger = (row) => row.cancelledAt && ledgerStartAt && new Date(row.cancelledAt) >= ledgerStartAt;
  // An all-zero invoice has nothing to post (postEntry returns null).
  const hasValue = (row) => Number(row.totalPrice || 0) !== 0 || Number(row.shippingFees || 0) !== 0
    || sum(row.items || [], (item) => Math.abs(Number(item.totalPrice || 0)) + Number(item.purchasePrice || 0) * Number(item.quantity || 0)) !== 0;
  const expectedSourceIds = {
    sale: new Set(sales.filter((row) => (inLedger(row) || cancelledInLedger(row)) && hasValue(row)).map((row) => String(row._id))),
    credit_sale: new Set(credits.filter((row) => (inLedger(row) || cancelledInLedger(row)) && hasValue(row)).map((row) => String(row._id))),
    return: new Set(returns.filter(inLedger).map((row) => String(row._id))),
    receipt: new Set(receipts.filter(inLedger).map((row) => String(row._id))),
  };
  const bySource = {}; let expectedEntrySources = 0; let actualEntrySources = 0; let coverageIssues = 0;
  for (const [type, expectedIds] of Object.entries(expectedSourceIds)) {
    const actualIds = new Set((sourceRows.get(type)?.ids || []).map(String));
    const missing = [...expectedIds].filter((id) => !actualIds.has(id));
    const orphaned = [...actualIds].filter((id) => !expectedIds.has(id));
    expectedEntrySources += expectedIds.size; actualEntrySources += actualIds.size; coverageIssues += missing.length + orphaned.length;
    bySource[type] = { expected: expectedIds.size, actual: actualIds.size, missing: missing.length, orphaned: orphaned.length };
  }
  const entries = { expected: expectedEntrySources, actual: actualEntrySources, difference: coverageIssues, bySource };

  res.json({ trialBalance, inventory, customers: customersCheck, netSales, cogs, entries });
};

module.exports = { getAccounts, getLedger, getJournal, getJournalEntry, getHealth, parseQueryDate };
