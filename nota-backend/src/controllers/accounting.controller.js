const mongoose = require("mongoose");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const Customer = require("../models/customer.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const CreditSale = require("../models/creditSale.model");
const ReturnLog = require("../models/returnLog.model");
const Meta = require("../models/meta.model");
const { roundMoney } = require("../utils/invoicePricing");

const accountBalance = (accountId, lines) => roundMoney(lines.reduce((sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0), 0));

const getAccounts = async (req, res) => {
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) { res.status(400); throw new Error("Invalid asOf"); }
  const [accounts, entries] = await Promise.all([
    Account.find({}).sort({ code: 1 }).lean(),
    JournalEntry.find({ date: { $lte: asOf }, status: "posted" }).select("lines").lean(),
  ]);
  const lines = entries.flatMap((entry) => entry.lines || []);
  const direct = new Map(accounts.map((account) => [String(account._id), accountBalance(account._id, lines.filter((line) => String(line.accountId) === String(account._id)))]));
  const rows = accounts.map((account) => ({ ...account, balance: direct.get(String(account._id)) || 0, children: [] }));
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  for (const row of rows) if (row.parentId && byId.has(String(row.parentId))) byId.get(String(row.parentId)).children.push(row);
  const roll = (row) => { row.balance = roundMoney(row.balance + row.children.reduce((sum, child) => sum + roll(child), 0)); return row.balance; };
  const roots = rows.filter((row) => !row.parentId); roots.forEach(roll);
  const customers = await Customer.find({}).select("_id name phone").lean();
  const customerAccount = rows.find((row) => row.systemKey === "CUSTOMERS");
  if (customerAccount) {
    const partyLines = lines.filter((line) => String(line.accountId) === String(customerAccount._id) && line.partyId);
    customerAccount.virtualCustomers = customers.map((customer) => ({ ...customer, virtual: true, balance: accountBalance(customer._id, partyLines.filter((line) => String(line.partyId) === String(customer._id))) })).filter((customer) => customer.balance !== 0);
  }
  res.json({ asOf, accounts: roots });
};

const getLedger = async (req, res) => {
  const account = await Account.findById(req.params.id).lean();
  if (!account) { res.status(404); throw new Error("Account not found"); }
  const query = { "lines.accountId": account._id, status: "posted" };
  if (req.query.from || req.query.to) query.date = {}; if (req.query.from) query.date.$gte = new Date(req.query.from); if (req.query.to) query.date.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
  const entries = await JournalEntry.find(query).sort({ date: 1, createdAt: 1 }).lean();
  const partyId = req.query.partyId && mongoose.Types.ObjectId.isValid(req.query.partyId) ? req.query.partyId : null;
  const lines = entries.flatMap((entry) => (entry.lines || []).filter((line) => !partyId || String(line.partyId) === String(partyId)).map((line) => ({ ...line, entryId: entry._id, number: entry.number, date: entry.date, source: entry.source, memo: entry.memo })));
  let balance = 0; const output = lines.map((line) => ({ ...line, balance: balance = roundMoney(balance + Number(line.debit || 0) - Number(line.credit || 0)) }));
  res.json({ account, openingBalance: 0, lines: output, balance });
};

const getJournal = async (req, res) => {
  const query = {}; if (req.query.type) query.type = req.query.type; if (req.query.sourceType) query["source.type"] = req.query.sourceType; if (req.query.number) query.number = req.query.number; if (req.query.accountId) query["lines.accountId"] = req.query.accountId; if (req.query.partyId) query["lines.partyId"] = req.query.partyId;
  if (req.query.from || req.query.to) { query.date = {}; if (req.query.from) query.date.$gte = new Date(req.query.from); if (req.query.to) query.date.$lte = new Date(`${req.query.to}T23:59:59.999Z`); }
  const page = Math.max(1, Number(req.query.page) || 1); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [data, totalItems] = await Promise.all([JournalEntry.find(query).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), JournalEntry.countDocuments(query)]);
  res.json({ data, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } });
};

const getJournalEntry = async (req, res) => {
  const entry = await JournalEntry.findById(req.params.id).lean(); if (!entry) { res.status(404); throw new Error("Journal entry not found"); } res.json(entry);
};

const getHealth = async (req, res) => {
  const [entries, products, customers, sales, credits, returns, meta] = await Promise.all([
    JournalEntry.find({ status: "posted" }).lean(), Product.find({}).select("inventoryCount purchasePrice").lean(), Customer.find({}).lean(), Selling.find({}).lean(), CreditSale.find({}).lean(), ReturnLog.find({}).lean(), Meta.findById("schema").lean(),
  ]);
  const ledgerStartAt = meta?.ledgerStartAt ? new Date(meta.ledgerStartAt) : null;
  const inLedgerPeriod = (row) => !ledgerStartAt || !row.createdAt || new Date(row.createdAt) >= ledgerStartAt;
  const periodSales = sales.filter(inLedgerPeriod);
  const periodCredits = credits.filter(inLedgerPeriod);
  const debit = roundMoney(entries.reduce((sum, entry) => sum + entry.totalDebit, 0)); const credit = roundMoney(entries.reduce((sum, entry) => sum + entry.totalCredit, 0));
  const inventoryExpected = roundMoney(products.reduce((sum, product) => sum + Number(product.inventoryCount || 0) * Number(product.purchasePrice || 0), 0));
  const inventoryAccount = await Account.findOne({ systemKey: "INVENTORY" }).lean(); const customerAccount = await Account.findOne({ systemKey: "CUSTOMERS" }).lean();
  const actualFor = (account, partyId) => roundMoney(entries.reduce((sum, entry) => sum + (entry.lines || []).filter((line) => String(line.accountId) === String(account?._id) && (!partyId || String(line.partyId) === String(partyId))).reduce((inner, line) => inner + line.debit - line.credit, 0), 0));
  // Customer control-account balances are lifetime statement balances: the
  // opening entry carries pre-ledger history, then post-ledger entries adjust it.
  const expectedCustomers = roundMoney(credits.reduce((sum, sale) => sum + Number(sale.totalPrice || 0) - Number(sale.paidAmount || 0) - Number(sale.refundedAmount || 0) + Number(sale.refundDueAmount || 0), 0));
  const customerActual = actualFor(customerAccount);
  // Matches dashboard definition: active invoices contribute original total
  // less refundedAmount (which already includes returns), with shipping
  // included in totalPrice.
  const netSales = roundMoney(
    periodSales.filter((sale) => sale.status !== "cancelled").reduce((sum, sale) => sum + Math.max(0, Number(sale.totalPrice || 0) - Number(sale.refundedAmount || 0)), 0) +
    periodCredits.filter((sale) => sale.status !== "cancelled").reduce((sum, sale) => sum + Math.max(0, Number(sale.totalPrice || 0) - Number(sale.refundedAmount || 0)), 0)
  );
  const salesActual = roundMoney(entries.reduce((sum, entry) => sum + (entry.lines || []).filter((line) => ["SALES", "SALES_RETURNS", "SALES_DISCOUNT", "SHIPPING_INCOME"].includes(line.accountCode)).reduce((inner, line) => inner + line.credit - line.debit, 0), 0));
  const cogsExpected = roundMoney(
    [...periodSales.filter((sale) => sale.status !== "cancelled"), ...periodCredits.filter((sale) => sale.status !== "cancelled")]
      .reduce((sum, sale) => sum + (sale.items || []).reduce((inner, item) => inner + Number(item.purchasePrice || 0) * Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0)), 0), 0)
  );
  const cogsAccount = await Account.findOne({ systemKey: "COGS" }).lean();
  const cogsActual = actualFor(cogsAccount);
  const nonOpeningEntries = entries.filter((entry) => entry.source?.type !== "opening");
  const result = { trialBalance: { expected: 0, actual: roundMoney(debit - credit), difference: roundMoney(debit - credit) }, inventory: { expected: inventoryExpected, actual: actualFor(inventoryAccount), difference: roundMoney(actualFor(inventoryAccount) - inventoryExpected) }, customers: { expected: expectedCustomers, actual: customerActual, difference: roundMoney(customerActual - expectedCustomers) }, netSales: { expected: netSales, actual: salesActual, difference: roundMoney(salesActual - netSales) }, entries: { expected: nonOpeningEntries.length, actual: nonOpeningEntries.length, difference: 0 } };
  result.cogs = { expected: cogsExpected, actual: cogsActual, difference: roundMoney(cogsActual - cogsExpected) };
  res.json(result);
};

module.exports = { getAccounts, getLedger, getJournal, getJournalEntry, getHealth };
