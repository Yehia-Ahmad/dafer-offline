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

const getAccounts = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
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
  const account = await Account.findById(req.params.id).lean();
  if (!account) { res.status(404); throw new Error("Account not found"); }
  if (req.query.partyId && !mongoose.Types.ObjectId.isValid(req.query.partyId)) { res.status(400); throw new Error("Invalid partyId"); }
  const partyId = req.query.partyId ? new mongoose.Types.ObjectId(req.query.partyId) : null;
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) { res.status(400); throw new Error("Invalid date range"); }
  const query = { "lines.accountId": account._id, status: "posted", ...(from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) };
  const openingPipeline = [
    { $match: { status: "posted", date: { $lt: from || new Date(0) }, "lines.accountId": account._id } },
    { $unwind: "$lines" },
    { $match: { "lines.accountId": account._id, ...(partyId ? { "lines.partyId": partyId } : {}) } },
    { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ];
  const [entries, openingRows, parties] = await Promise.all([
    JournalEntry.find(query).sort({ date: 1, createdAt: 1 }).lean(),
    from ? JournalEntry.aggregate(openingPipeline) : Promise.resolve([]),
    account.systemKey === "CUSTOMERS" ? Customer.find({}).select("_id name phone").sort({ name: 1 }).lean() : Promise.resolve([]),
  ]);
  const lines = entries.flatMap((entry) => (entry.lines || []).filter((line) => !partyId || String(line.partyId) === String(partyId)).map((line) => ({ ...line, entryId: entry._id, number: entry.number, date: entry.date, source: entry.source, memo: entry.memo })));
  const openingBalance = roundMoney(openingRows[0]?.balance || 0);
  let balance = openingBalance; const output = lines.map((line) => ({ ...line, balance: balance = roundMoney(balance + Number(line.debit || 0) - Number(line.credit || 0)) }));
  res.json({ account, parties, openingBalance, lines: output, balance });
};

const getJournal = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const query = {}; if (req.query.type) query.type = req.query.type; if (req.query.sourceType) query["source.type"] = req.query.sourceType; if (req.query.sourceId && mongoose.Types.ObjectId.isValid(req.query.sourceId)) query["source.id"] = req.query.sourceId; if (req.query.sourceNumber) query["source.number"] = req.query.sourceNumber; if (req.query.number) query.number = req.query.number; if (req.query.accountId) query["lines.accountId"] = req.query.accountId; if (req.query.partyId) query["lines.partyId"] = req.query.partyId;
  if (req.query.from || req.query.to) { query.date = {}; if (req.query.from) query.date.$gte = new Date(req.query.from); if (req.query.to) query.date.$lte = new Date(`${req.query.to}T23:59:59.999Z`); }
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [data, totalItems] = await Promise.all([JournalEntry.find(query).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), JournalEntry.countDocuments(query)]);
  res.json({ data, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

const getJournalEntry = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const entry = await JournalEntry.findById(req.params.id).lean(); if (!entry) { res.status(404); throw new Error("Journal entry not found"); } res.json(entry);
};

const getHealth = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const [totals, accountBalances, legacyEditBalances, documentSources, products, customers, sales, credits, returns, receipts, meta, accounts] = await Promise.all([
    JournalEntry.aggregate([{ $match: { status: "posted" } }, { $group: { _id: null, debit: { $sum: "$totalDebit" }, credit: { $sum: "$totalCredit" }, count: { $sum: 1 } } }]),
    JournalEntry.aggregate([{ $match: { status: "posted" } }, { $unwind: "$lines" }, { $group: { _id: "$lines.accountId", balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]),
    JournalEntry.aggregate([{ $match: { status: "posted", "source.type": { $in: ["sale_edit", "credit_sale_edit"] } } }, { $unwind: "$lines" }, { $group: { _id: "$lines.accountId", balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]),
    JournalEntry.aggregate([
      { $match: { status: "posted", "source.type": { $in: ["sale", "credit_sale", "return", "receipt"] } } },
      { $group: { _id: { type: "$source.type", id: "$source.id" } } },
      { $group: { _id: "$_id.type", ids: { $addToSet: "$_id.id" }, count: { $sum: 1 } } },
    ]),
    Product.find({}).select("inventoryCount purchasePrice").lean(), Customer.find({}).lean(), Selling.find({}).lean(), CreditSale.find({}).lean(), ReturnLog.find({}).lean(), Receipt.find({}).select("_id createdAt").lean(), Meta.findById("schema").lean(), Account.find({ systemKey: { $ne: null } }).lean(),
  ]);
  const ledgerStartAt = meta?.ledgerStartAt ? new Date(meta.ledgerStartAt) : null;
  const inLedgerPeriod = (row) => !ledgerStartAt || !row.createdAt || new Date(row.createdAt) >= ledgerStartAt;
  const periodSales = sales.filter(inLedgerPeriod);
  const periodCredits = credits.filter(inLedgerPeriod);
  const preLedgerSales = [...sales, ...credits].filter((sale) => ledgerStartAt && sale.createdAt && new Date(sale.createdAt) < ledgerStartAt);
  const preLedgerById = new Map(preLedgerSales.map((sale) => [String(sale._id), sale]));
  const periodLegacyReturns = returns.filter((row) => ledgerStartAt && row.createdAt && new Date(row.createdAt) >= ledgerStartAt && preLedgerById.has(String(row.invoiceId)) && preLedgerById.get(String(row.invoiceId)).status !== "cancelled");
  const periodLegacyCancels = preLedgerSales.filter((sale) => sale.status === "cancelled" && sale.cancelledAt && new Date(sale.cancelledAt) >= ledgerStartAt);
  const debit = roundMoney(totals[0]?.debit || 0); const credit = roundMoney(totals[0]?.credit || 0);
  const inventoryExpected = roundMoney(products.reduce((sum, product) => sum + Number(product.inventoryCount || 0) * Number(product.purchasePrice || 0), 0));
  const byKey = new Map(accounts.map((account) => [account.systemKey, account]));
  const balanceById = new Map(accountBalances.map((row) => [String(row._id), roundMoney(row.balance)]));
  const editBalanceById = new Map(legacyEditBalances.map((row) => [String(row._id), roundMoney(row.balance)]));
  const actualFor = (account) => balanceById.get(String(account?._id)) || 0;
  const editActualFor = (account) => editBalanceById.get(String(account?._id)) || 0;
  const inventoryAccount = byKey.get("INVENTORY"); const customerAccount = byKey.get("CUSTOMERS");
  // Customer control-account balances are lifetime statement balances: the
  // opening entry carries pre-ledger history, then post-ledger entries adjust it.
  const expectedCustomers = roundMoney(credits.reduce((sum, sale) => {
    const statementPayments = (sale.payments || []).filter((payment) => payment.source !== "return_reallocation").reduce((total, payment) => total + Number(payment.amount || 0), 0);
    let balance = Number(sale.totalPrice || 0) - statementPayments - Number(sale.refundedAmount || 0);
    if (sale.status === "cancelled") balance += -Number(sale.totalPrice || 0) + Number(sale.cancelRefundAmount || 0);
    return sum + balance;
  }, 0));
  const customerActual = actualFor(customerAccount);
  // Matches dashboard definition: active invoices contribute original total
  // less refundedAmount (which already includes returns), with shipping
  // included in totalPrice.
  const legacyEditNetSales = roundMoney(editActualFor(byKey.get("SALES")) * -1 + editActualFor(byKey.get("SALES_RETURNS")) * -1 + editActualFor(byKey.get("SALES_DISCOUNT")) * -1 + editActualFor(byKey.get("SHIPPING_INCOME")) * -1);
  const netSales = roundMoney(
    periodSales.filter((sale) => sale.status !== "cancelled").reduce((sum, sale) => sum + Math.max(0, Number(sale.totalPrice || 0) - Number(sale.refundedAmount || 0)), 0) +
    periodCredits.filter((sale) => sale.status !== "cancelled").reduce((sum, sale) => sum + Math.max(0, Number(sale.totalPrice || 0) - Number(sale.refundedAmount || 0)), 0) -
    periodLegacyReturns.reduce((sum, row) => sum + Number(row.finalReturnedAmount || 0), 0) -
    periodLegacyCancels.reduce((sum, sale) => sum + Number(sale.totalPrice || 0), 0) + legacyEditNetSales
  );
  const salesActual = roundMoney(actualFor(byKey.get("SALES")) * -1 + actualFor(byKey.get("SALES_RETURNS")) * -1 + actualFor(byKey.get("SALES_DISCOUNT")) * -1 + actualFor(byKey.get("SHIPPING_INCOME")) * -1);
  const cogsExpected = roundMoney(
    [...periodSales.filter((sale) => sale.status !== "cancelled"), ...periodCredits.filter((sale) => sale.status !== "cancelled")]
      .reduce((sum, sale) => sum + (sale.items || []).reduce((inner, item) => inner + Number(item.purchasePrice || 0) * Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0)), 0), 0) -
    periodLegacyReturns.reduce((sum, row) => sum + (row.items || []).reduce((inner, item) => inner + Number(item.purchasePrice || 0) * Number(item.quantity || 0), 0), 0) -
    periodLegacyCancels.reduce((sum, sale) => sum + (sale.items || []).reduce((inner, item) => inner + Number(item.purchasePrice || 0) * Number(item.quantity || 0), 0), 0) + editActualFor(byKey.get("COGS"))
  );
  const cogsAccount = byKey.get("COGS");
  const cogsActual = actualFor(cogsAccount);
  const sourceRows = new Map(documentSources.map((row) => [row._id, row]));
  const sinceStart = (row) => !ledgerStartAt || (row.createdAt && new Date(row.createdAt) >= ledgerStartAt);
  const expectedSourceIds = {
    sale: new Set(sales.filter((row) => sinceStart(row) || (row.cancelledAt && new Date(row.cancelledAt) >= ledgerStartAt)).map((row) => String(row._id))),
    credit_sale: new Set(credits.filter((row) => sinceStart(row) || (row.cancelledAt && new Date(row.cancelledAt) >= ledgerStartAt)).map((row) => String(row._id))),
    return: new Set(returns.filter(sinceStart).map((row) => String(row._id))),
    receipt: new Set(receipts.filter(sinceStart).map((row) => String(row._id))),
  };
  const coverageBySource = {}; let expectedEntrySources = 0; let actualEntrySources = 0; let coverageIssues = 0;
  for (const [type, expectedIds] of Object.entries(expectedSourceIds)) {
    const actualIds = new Set((sourceRows.get(type)?.ids || []).map(String));
    const missing = [...expectedIds].filter((id) => !actualIds.has(id));
    const orphaned = [...actualIds].filter((id) => !expectedIds.has(id));
    expectedEntrySources += expectedIds.size; actualEntrySources += actualIds.size; coverageIssues += missing.length + orphaned.length;
    coverageBySource[type] = { expected: expectedIds.size, actual: actualIds.size, missing: missing.length, orphaned: orphaned.length };
  }
  const result = { trialBalance: { expected: 0, actual: roundMoney(debit - credit), difference: roundMoney(debit - credit) }, inventory: { expected: inventoryExpected, actual: actualFor(inventoryAccount), difference: roundMoney(actualFor(inventoryAccount) - inventoryExpected) }, customers: { expected: expectedCustomers, actual: customerActual, difference: roundMoney(customerActual - expectedCustomers) }, netSales: { expected: netSales, actual: salesActual, difference: roundMoney(salesActual - netSales) }, entries: { expected: expectedEntrySources, actual: actualEntrySources, difference: coverageIssues, bySource: coverageBySource } };
  result.cogs = { expected: cogsExpected, actual: cogsActual, difference: roundMoney(cogsActual - cogsExpected) };
  res.json(result);
};

module.exports = { getAccounts, getLedger, getJournal, getJournalEntry, getHealth };
