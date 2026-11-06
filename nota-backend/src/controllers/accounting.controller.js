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
const Supplier = require("../models/supplier.model");
const PartyOpening = require("../models/partyOpening.model");
const { loadOpeningState, saveOpening, finalizeOpening, currentOpeningEntry, getOpeningMeta } = require("../accounting/opening");
const { audit } = require("../auth/audit");
const CashBox = require("../models/cashBox.model");
const { boxEvents } = require("../cashbox/events");
const { withTransaction } = require("../utils/transaction");
const { hasPermission } = require("../auth/permissions");

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

/** Additive display fields: the side the signed balance sits on and its absolute value (a zero balance sits on the normal side). */
const sideOf = (balance, normalSide = "debit") => (balance > 0 ? "debit" : balance < 0 ? "credit" : normalSide);
const withSide = (row, balance, normalSide) => ({ ...row, side: sideOf(balance, normalSide), absBalance: roundMoney(Math.abs(balance)) });

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
  for (const row of rows) { row.side = sideOf(row.balance, row.normalSide); row.absBalance = roundMoney(Math.abs(row.balance)); }
  const customerAccount = rows.find((row) => row.systemKey === "CUSTOMERS");
  if (customerAccount) {
    const partyBalances = balances.filter((row) => String(row._id.accountId) === String(customerAccount._id) && row._id.partyId && roundMoney(row.balance) !== 0);
    const customers = await Customer.find({ _id: { $in: partyBalances.map((row) => row._id.partyId) } }).select("_id name phone").lean();
    const byCustomer = new Map(customers.map((customer) => [String(customer._id), customer]));
    customerAccount.virtualCustomers = partyBalances.map((row) => withSide({ ...(byCustomer.get(String(row._id.partyId)) || { _id: row._id.partyId, name: "" }), virtual: true, balance: roundMoney(row.balance) }, roundMoney(row.balance), "debit"));
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
    account.systemKey === "CUSTOMERS" ? Customer.find({}).select("_id name phone").sort({ name: 1 }).lean()
      : account.systemKey === "SUPPLIERS" ? Supplier.find({}).select("_id name phones").sort({ name: 1 }).lean() : Promise.resolve([]),
  ]);
  const openingBalance = roundMoney(openingRows[0]?.balance || 0);
  let balance = openingBalance;
  const output = rows.map(({ line, ...entry }) => {
    balance = roundMoney(balance + Number(line.debit || 0) - Number(line.credit || 0));
    return withSide({ ...line, ...entry, balance }, balance, account.normalSide);
  });
  res.json({ account, parties, openingBalance, openingSide: sideOf(openingBalance, account.normalSide), openingAbsBalance: roundMoney(Math.abs(openingBalance)), lines: output, balance, side: sideOf(balance, account.normalSide), absBalance: roundMoney(Math.abs(balance)) });
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
  const supplierAccountId = String(byKey.get("SUPPLIERS")?._id || "");
  const supplierPartyBalance = new Map();
  for (const row of balances) {
    const accountId = String(row._id.accountId);
    accountBalance.set(accountId, roundMoney((accountBalance.get(accountId) || 0) + Number(row.balance || 0)));
    if (accountId === customerAccountId && row._id.partyId) partyBalance.set(String(row._id.partyId), roundMoney((partyBalance.get(String(row._id.partyId)) || 0) + Number(row.balance || 0)));
    if (accountId === supplierAccountId && row._id.partyId) supplierPartyBalance.set(String(row._id.partyId), roundMoney((supplierPartyBalance.get(String(row._id.partyId)) || 0) + Number(row.balance || 0)));
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

  // 7. Suppliers (Stage 18): each supplier's ledger party balance against the supplier opening record,
  //    until Stage 20 adds purchases and payments. Ledger balances are signed (credit negative), so expected = -amount.
  const supplierOpenings = await PartyOpening.find({ partyType: "supplier" }).lean();
  const supplierNames = new Map((await Supplier.find({}).select("name").lean()).map((row) => [String(row._id), row.name]));
  const expectedBySupplier = new Map(supplierOpenings.map((row) => [String(row.partyId), roundMoney(-row.amount)]));
  const supplierIds = new Set([...expectedBySupplier.keys(), ...supplierPartyBalance.keys()]);
  const bySupplier = []; let expectedSuppliers = 0; let supplierDifference = 0;
  for (const id of supplierIds) {
    const expected = expectedBySupplier.get(id) || 0; const ledger = supplierPartyBalance.get(id) || 0;
    expectedSuppliers += expected;
    const difference = roundMoney(ledger - expected);
    if (difference) { supplierDifference += Math.abs(difference); bySupplier.push({ supplierId: id, name: supplierNames.get(id) ?? null, expected, actual: ledger, difference }); }
  }
  const supplierTotal = actual("SUPPLIERS");
  const supplierUnassigned = roundMoney(supplierTotal - sum([...supplierPartyBalance.values()], (value) => value));
  const suppliersCheck = {
    expected: roundMoney(expectedSuppliers), actual: roundMoney(supplierTotal),
    difference: roundMoney(supplierDifference + Math.abs(supplierUnassigned)),
    totalDifference: roundMoney(supplierTotal - expectedSuppliers), unassignedLines: supplierUnassigned, bySupplier,
  };

  // 8. Opening (Stage 18): the current opening entry's lines against the data the wizard stored
  //    (cash, banks, fixed assets, inventory as saved, customers, suppliers, capital as the difference).
  const openingCheck = await buildOpeningCheck({ meta, byKey, supplierOpenings });

  // 9. Boxes (Stage 19).
  const accountsAll = await Account.find({}).select("code systemKey").lean();
  const boxesCheck = await buildBoxesCheck({ meta, ledgerStartAt, accountBalance, accounts: accountsAll });

  res.json({ trialBalance, inventory, customers: customersCheck, suppliers: suppliersCheck, opening: openingCheck, netSales, cogs, entries, boxes: boxesCheck });
};

const signedKey = (accountId, partyId) => `${accountId}:${partyId || ""}`;

const buildOpeningCheck = async ({ meta, byKey, supplierOpenings }) => {
  const stored = meta?.opening?.data;
  if (!stored) return { expected: 0, actual: 0, difference: 0, saved: false, byLine: [], entryReversed: false, unreversedEntries: 0, countOk: true, ok: true };
  const [customerOpenings, entry, unreversedCount] = await Promise.all([
    PartyOpening.find({ partyType: "customer" }).lean(), currentOpeningEntry(meta.opening),
    JournalEntry.countDocuments({ type: "opening", reversedBy: null }),
  ]);
  const expected = new Map();
  const add = (map, key, amount) => map.set(key, roundMoney((map.get(key) || 0) + amount));
  const account = (key) => String(byKey.get(key)?._id);
  add(expected, signedKey(account("CASH_MAIN")), Number(stored.cash || 0));
  for (const bank of stored.banks || []) add(expected, signedKey(String(bank.accountId)), Number(bank.amount || 0));
  add(expected, signedKey(account("INVENTORY")), Number(stored.inventory || 0));
  add(expected, signedKey(account("FIXED_ASSETS")), Number(stored.fixedAssets || 0));
  const customerTotals = new Map();
  for (const row of customerOpenings) add(customerTotals, String(row.partyId), Number(row.amount || 0));
  for (const row of stored.carriedCustomers || []) add(customerTotals, String(row.customerId), Number(row.amount || 0));
  for (const [id, amount] of customerTotals) add(expected, signedKey(account("CUSTOMERS"), id), amount);
  for (const row of supplierOpenings) add(expected, signedKey(account("SUPPLIERS"), String(row.partyId)), -Number(row.amount || 0));
  const capital = roundMoney(-[...expected.values()].reduce((total, value) => total + value, 0));
  add(expected, signedKey(account("CAPITAL")), capital);
  const actualMap = new Map();
  for (const row of entry?.lines || []) add(actualMap, signedKey(String(row.accountId), row.partyId ? String(row.partyId) : ""), roundMoney(Number(row.debit || 0) - Number(row.credit || 0)));
  const keys = new Set([...expected.keys(), ...actualMap.keys()]);
  const byLine = []; let difference = 0;
  for (const key of keys) {
    const expectedAmount = expected.get(key) || 0; const actualAmount = actualMap.get(key) || 0;
    const delta = roundMoney(actualAmount - expectedAmount);
    if (delta) { difference += Math.abs(delta); byLine.push({ key, expected: expectedAmount, actual: actualAmount, difference: delta }); }
  }
  const absTotal = (map) => roundMoney([...map.values()].reduce((total, value) => total + Math.abs(value), 0));
  // Ledger side: the current opening entry must not be reversed, and exactly one opening entry may be unreversed
  // (none only when there is no opening data at all).
  const hasData = [...expected.values()].some((value) => value !== 0);
  const entryReversed = Boolean(entry?.reversedBy);
  const countOk = hasData ? unreversedCount === 1 : unreversedCount <= 1;
  // `difference` is money only; the structural failures are separate flags and `ok` covers both.
  const moneyDifference = roundMoney(difference);
  return { expected: absTotal(expected), actual: absTotal(actualMap), difference: moneyDifference, saved: true, byLine, entryReversed, unreversedEntries: unreversedCount, countOk, ok: moneyDifference === 0 && !entryReversed && countOk };
};

/**
 * Stage 19: per box, the ledger balance of its account against an independent total from operational documents:
 * its opening amount + cash sales, receipts and down payments - refunds (returns, cancels, "رد المقدم") - expenses
 * +/- transfers +/- shift differences - drawings and payouts, cancelled documents netted out. Money on a 111/112 leaf
 * account that has no box at all also counts as a difference. difference = Σ |per-box difference| + unboxed.
 */
const buildBoxesCheck = async ({ meta, ledgerStartAt, accountBalance, accounts }) => {
  const boxList = await CashBox.find({}).sort({ sortOrder: 1, createdAt: 1 }).lean();
  const stored = meta?.opening?.data;
  const openingOf = (box) => {
    if (!stored) return 0;
    if (box.isMain) return Number(stored.cash || 0);
    return Number((stored.banks || []).find((row) => String(row.accountId) === String(box.accountId))?.amount || 0);
  };
  const byBox = []; let expectedTotal = 0; let actualTotal = 0; let difference = 0;
  for (const box of boxList) {
    const events = await boxEvents(box, { ledgerStartAt: ledgerStartAt || null });
    const expected = roundMoney(openingOf(box) + events.reduce((total, event) => total + event.delta, 0));
    const actual = roundMoney(accountBalance.get(String(box.accountId)) || 0);
    const boxDifference = roundMoney(actual - expected);
    expectedTotal += expected; actualTotal += actual; difference += Math.abs(boxDifference);
    byBox.push({ boxId: box._id, name: box.name, type: box.type, expected, actual, difference: boxDifference });
  }
  // Leaf accounts under 111 and 112 that no box points to must hold nothing.
  const boxed = new Set(boxList.map((box) => String(box.accountId)));
  const parentIds = new Set(accounts.filter((account) => account.code === "111" || account.code === "112").map((account) => String(account._id)));
  const leaves = await Account.find({ parentId: { $in: [...parentIds].map((id) => new mongoose.Types.ObjectId(id)) }, isGroup: false }).lean();
  let unboxed = 0;
  for (const account of leaves) {
    if (boxed.has(String(account._id))) continue;
    if (account.systemKey === "CASH_MAIN" && !boxList.length) continue;
    unboxed += Math.abs(accountBalance.get(String(account._id)) || 0);
  }
  unboxed = roundMoney(unboxed);
  return { expected: roundMoney(expectedTotal), actual: roundMoney(actualTotal), difference: roundMoney(difference + unboxed), unboxed, byBox };
};

// ---------------------------------------------------------------- Stage 18 opening wizard

const auditTotals = (req, totals) => {
  const canSeeCost = !req.user || hasPermission(req.user, "products.viewCost");
  // Inventory (and so capital and assets) is valued at purchase price: only for users who may see cost.
  const { inventory, capital, assets, ...safe } = totals;
  return canSeeCost ? totals : safe;
};

const getOpening = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const state = await loadOpeningState();
  res.json(state);
};

const saveOpeningHandler = async (req, res) => {
  const result = await withTransaction(async (session) => {
    const saved = await saveOpening(req.body, { session, actor: req.user || null });
    await audit(req, { action: "opening.saved", entity: "Opening", entityId: saved.entry?._id || "none", details: { number: saved.number, ...auditTotals(req, saved.totals) }, session, strict: true });
    return saved;
  });
  const state = await loadOpeningState();
  res.json({ message: "تم حفظ أرصدة بداية المحل", number: result.number, ...state });
};

const finalizeOpeningHandler = async (req, res) => {
  if (!req.body || req.body.confirm !== true) { res.status(400); throw new Error("يجب تأكيد الاعتماد النهائي"); }
  const result = await withTransaction(async (session) => {
    const done = await finalizeOpening({ session, actor: req.user || null });
    const current = await loadOpeningState(session);
    await audit(req, { action: "opening.finalized", entity: "Opening", entityId: current.entry?._id || "none", details: { number: current.entry?.number, ...auditTotals(req, current.totals) }, session, strict: true });
    return done;
  });
  const state = await loadOpeningState();
  res.json({ message: "تم اعتماد أرصدة بداية المحل نهائيًا", finalizedAt: result.finalizedAt, ...state });
};

module.exports = { getAccounts, getLedger, getJournal, getJournalEntry, getHealth, parseQueryDate, getOpening, saveOpening: saveOpeningHandler, finalizeOpening: finalizeOpeningHandler };
