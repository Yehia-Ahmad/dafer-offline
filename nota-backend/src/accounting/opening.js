const mongoose = require("mongoose");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const Customer = require("../models/customer.model");
const Supplier = require("../models/supplier.model");
const Product = require("../models/product.model");
const Selling = require("../models/selling.model");
const CreditSale = require("../models/creditSale.model");
const ReturnLog = require("../models/returnLog.model");
const Receipt = require("../models/receipt.model");
const Meta = require("../models/meta.model");
const PartyOpening = require("../models/partyOpening.model");
const { roundMoney } = require("../utils/invoicePricing");
const { PREFIXES, nextDocumentNumber } = require("../utils/documentNumber");
const { postEntry, reverseEntry, accountMap, line, getLedgerStartAt, postInventoryAdjustment } = require("./posting");
const { collectedOf } = require("../services/customerOpenItems.service");

// Stage 18: the opening-balance wizard.
//
// Setup mode: the opening has not been finalized AND no sale, credit sale,
// return or receipt belongs to the ledger yet (created on/after ledgerStartAt;
// opening documents do not count). While in setup mode, stock a shop types in
// is its opening stock: stock postings go against CAPITAL (source type
// "opening_inventory") instead of INVENTORY_ADJUSTMENT.

const OPENING_INVENTORY = "opening_inventory";

const httpError = (status, message, data = {}) => {
  const error = new Error(message);
  error.statusCode = status;
  error.responseData = data;
  return error;
};

const getOpeningMeta = async (session) => {
  const meta = await Meta.findById("schema").select("ledgerStartAt opening").session(session || null).lean();
  return { ledgerStartAt: meta?.ledgerStartAt ? new Date(meta.ledgerStartAt) : null, opening: meta?.opening || null };
};

/** True when any real operational document belongs to the ledger period. */
const hasLedgerActivity = async (ledgerStartAt, session) => {
  const filter = { createdAt: { $gte: ledgerStartAt } };
  const checks = await Promise.all([Selling, CreditSale, ReturnLog, Receipt].map((model) => model.exists(filter).session(session || null)));
  return checks.some(Boolean);
};

/** Setup mode (see the header comment). Before the ledger start exists there is no setup mode. */
const isSetupMode = async (session) => {
  const { ledgerStartAt, opening } = await getOpeningMeta(session);
  if (!ledgerStartAt || opening?.status === "finalized") return false;
  return !(await hasLedgerActivity(ledgerStartAt, session));
};

/**
 * Posts a stock value change. In setup mode: Dr/Cr INVENTORY against CAPITAL
 * (source type opening_inventory). Otherwise the normal INVENTORY_ADJUSTMENT
 * entry with the caller's source type. `setup` can be passed to skip the lookup
 * (imports decide once for the whole file).
 */
const postStockAdjustment = async ({ date, source, amount, increase, session, memo, setup }) => {
  const inSetup = setup === undefined ? await isSetupMode(session) : setup;
  if (!inSetup) {
    return postInventoryAdjustment({ date, source, amount, increase, session, memo });
  }
  const accounts = await accountMap(["INVENTORY", "CAPITAL"], session);
  return postEntry({
    date, session, memo: memo || "Opening inventory",
    source: { ...source, type: OPENING_INVENTORY },
    lines: [line(accounts.get("INVENTORY"), amount, increase ? "debit" : "credit"), line(accounts.get("CAPITAL"), amount, increase ? "credit" : "debit")],
  });
};

// ---------------------------------------------------------------- figures

const sumLines = (entry, accountId) => roundMoney((entry?.lines || [])
  .filter((row) => String(row.accountId) === String(accountId))
  .reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0));

const currentOpeningEntry = async (opening, session) => {
  if (opening?.entryId) return JournalEntry.findById(opening.entryId).session(session || null).lean();
  // Upgraded install: OB-000001 from the Stage 17 migration, not yet touched by the wizard.
  return JournalEntry.findOne({ type: "opening", reversedBy: null }).sort({ createdAt: -1 }).session(session || null).lean();
};

/** Entries the wizard folds into one clean opening entry: the unreversed opening entry and the unreversed opening_inventory entries. */
const foldableEntries = (session) => JournalEntry.find({
  reversedBy: null,
  $or: [{ type: "opening" }, { type: "auto", "source.type": OPENING_INVENTORY }],
}).session(session || null).lean();

const stockValue = async (session) => {
  const products = await Product.find({}).select("inventoryCount purchasePrice").session(session || null).lean();
  return roundMoney(products.reduce((sum, product) => sum + Number(product.inventoryCount || 0) * Number(product.purchasePrice || 0), 0));
};

/** INVENTORY ledger balance that is not part of the foldable entries (older adjustments the wizard must keep). */
const inventoryOutsideOpening = async (inventoryAccountId, session) => {
  const [rows, foldable] = await Promise.all([
    JournalEntry.aggregate([{ $match: { status: "posted" } }, { $unwind: "$lines" }, { $match: { "lines.accountId": inventoryAccountId } },
      { $group: { _id: null, balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } }]).session(session || null),
    foldableEntries(session),
  ]);
  const folded = foldable.reduce((sum, entry) => sum + sumLines(entry, inventoryAccountId), 0);
  return roundMoney(Number(rows[0]?.balance || 0) - folded);
};

const bankAccounts = async (session) => {
  const parent = await Account.findOne({ code: "112" }).session(session || null).lean();
  if (!parent) return [];
  return Account.find({ parentId: parent._id }).sort({ code: 1 }).session(session || null).lean();
};

/** The wizard's current figures plus the posted entry. */
const loadOpeningState = async (session = null) => {
  const { ledgerStartAt, opening } = await getOpeningMeta(session);
  const status = opening?.status || "setup";
  const setupMode = Boolean(ledgerStartAt) && status !== "finalized" && !(await hasLedgerActivity(ledgerStartAt, session));
  const entry = await currentOpeningEntry(opening, session);
  const data = opening?.data || {};
  const accounts = await accountMap(["INVENTORY"], session).catch(() => null);
  const banks = (await bankAccounts(session)).map((account) => ({
    accountId: account._id, code: account.code, name: account.nameAr, kind: account.kind,
    amount: roundMoney((data.banks || []).find((row) => String(row.accountId) === String(account._id))?.amount || 0),
  }));
  let inventory;
  if (setupMode) {
    const outside = accounts ? await inventoryOutsideOpening(accounts.get("INVENTORY")._id, session) : 0;
    inventory = { mode: "live", editable: true, amount: roundMoney(await stockValue(session) - outside), stockValue: await stockValue(session) };
  } else {
    inventory = { mode: "carried", editable: false, amount: accounts && entry ? sumLines(entry, accounts.get("INVENTORY")._id) : 0 };
  }
  const [customerRows, supplierRows] = await Promise.all([
    PartyOpening.find({ partyType: "customer" }).session(session).lean(),
    PartyOpening.find({ partyType: "supplier" }).session(session).lean(),
  ]);
  const [customers, suppliers] = await Promise.all([
    Customer.find({ _id: { $in: customerRows.map((row) => row.partyId) } }).select("name phone").session(session).lean(),
    Supplier.find({ _id: { $in: supplierRows.map((row) => row.partyId) } }).select("name").session(session).lean(),
  ]);
  const customerName = new Map(customers.map((row) => [String(row._id), row]));
  const supplierName = new Map(suppliers.map((row) => [String(row._id), row]));
  const carriedCustomers = (data.carriedCustomers || []).map((row) => ({ customerId: row.customerId, amount: roundMoney(row.amount) }));
  const figures = {
    cash: roundMoney(data.cash || 0),
    banks,
    fixedAssets: roundMoney(data.fixedAssets || 0),
    inventory,
    customers: customerRows.map((row) => ({ customerId: row.partyId, name: customerName.get(String(row.partyId))?.name || "", phone: customerName.get(String(row.partyId))?.phone || "", amount: roundMoney(row.amount), collected: collectedOf(row) })),
    suppliers: supplierRows.map((row) => ({ supplierId: row.partyId, name: supplierName.get(String(row.partyId))?.name || "", amount: roundMoney(row.amount) })),
    carriedCustomers,
  };
  return { status, setupMode, ledgerStartAt, finalizedAt: opening?.finalizedAt || null, savedAt: opening?.savedAt || null, figures, totals: openingTotals(figures), entry };
};

/** assets = what the shop has, liabilities = what it owes, capital = the difference (the formula the review shows). */
const openingTotals = (figures) => {
  const sum = (rows, pick) => roundMoney(rows.reduce((total, row) => total + pick(row), 0));
  const customerDebit = roundMoney(sum(figures.customers, (row) => Math.max(0, row.amount)) + sum(figures.carriedCustomers, (row) => Math.max(0, row.amount)));
  const customerCredit = roundMoney(sum(figures.customers, (row) => Math.max(0, -row.amount)) + sum(figures.carriedCustomers, (row) => Math.max(0, -row.amount)));
  const supplierCredit = sum(figures.suppliers, (row) => Math.max(0, row.amount));
  const supplierDebit = sum(figures.suppliers, (row) => Math.max(0, -row.amount));
  const banks = sum(figures.banks, (row) => row.amount);
  const assets = roundMoney(figures.cash + banks + figures.inventory.amount + figures.fixedAssets + customerDebit + supplierDebit);
  const liabilities = roundMoney(supplierCredit + customerCredit);
  return { cash: figures.cash, banks, inventory: figures.inventory.amount, fixedAssets: figures.fixedAssets, customers: customerDebit, customerCredits: customerCredit, suppliers: supplierCredit, supplierDebits: supplierDebit, assets, liabilities, capital: roundMoney(assets - liabilities) };
};

// ---------------------------------------------------------------- save

const isMoney = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const parseAmount = (value, label, { allowNegative = false } = {}) => {
  const amount = value === undefined || value === null || value === "" ? 0 : Number(value);
  if (!isMoney(amount)) throw httpError(400, `قيمة ${label} غير صالحة (حتى خانتين عشريتين)`, { code: "INVALID_AMOUNT" });
  if (!allowNegative && amount < 0) throw httpError(400, `قيمة ${label} لا يمكن أن تكون سالبة`, { code: "INVALID_AMOUNT" });
  return roundMoney(amount);
};
const isId = (value) => mongoose.Types.ObjectId.isValid(String(value || "")) && String(new mongoose.Types.ObjectId(String(value))) === String(value);

const parseRows = (rows, { idKey, label, allowNegative }) => {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw httpError(400, `${label} غير صالحة`, { code: "INVALID_ROWS" });
  const seen = new Set();
  const parsed = [];
  for (const row of rows) {
    if (!row || !isId(row[idKey])) throw httpError(400, `${label}: المعرّف غير صالح`, { code: "INVALID_ROWS" });
    const id = String(row[idKey]);
    if (seen.has(id)) throw httpError(400, `${label}: صف مكرر`, { code: "DUPLICATE_ROW" });
    seen.add(id);
    const amount = parseAmount(row.amount, label, { allowNegative });
    if (amount !== 0) parsed.push({ id, amount });
  }
  return parsed;
};

const nextBankCode = async (session) => {
  const parent = await Account.findOne({ code: "112" }).session(session).lean();
  const children = await Account.find({ parentId: parent._id }).select("code").session(session).lean();
  const max = children.reduce((top, child) => Math.max(top, Number(child.code) || 0), 1120);
  return { parent, code: String(max + 1) };
};

/** Resolves the payload's bank/wallet rows to leaf accounts under 112 (creating the new ones). Returns [{account, amount}]. */
const resolveBanks = async (rows, session) => {
  if (rows === undefined || rows === null) rows = [];
  if (!Array.isArray(rows)) throw httpError(400, "البنوك والمحافظ غير صالحة", { code: "INVALID_ROWS" });
  const known = await bankAccounts(session);
  const knownById = new Map(known.map((account) => [String(account._id), account]));
  const used = new Set();
  const result = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw httpError(400, "صف بنك غير صالح", { code: "INVALID_ROWS" });
    const amount = parseAmount(row.amount, "البنك/المحفظة");
    if (row.accountId) {
      const account = knownById.get(String(row.accountId));
      if (!account) throw httpError(400, "حساب البنك أو المحفظة غير موجود", { code: "INVALID_ROWS" });
      if (used.has(String(account._id))) throw httpError(400, "صف بنك مكرر", { code: "DUPLICATE_ROW" });
      used.add(String(account._id));
      result.push({ account, amount });
      continue;
    }
    if (amount === 0) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || name.length > 120) throw httpError(400, "اسم البنك أو المحفظة مطلوب", { code: "INVALID_ROWS" });
    if (!["bank", "wallet"].includes(row.type)) throw httpError(400, "نوع الحساب يجب أن يكون bank أو wallet", { code: "INVALID_ROWS" });
    const { parent, code } = await nextBankCode(session);
    const [account] = await Account.create([{ code, nameAr: name, nameEn: name, type: "asset", normalSide: "debit", parentId: parent._id, isGroup: false, isSystem: false, kind: row.type, isActive: true }], { session });
    result.push({ account: account.toObject(), amount });
  }
  for (const account of known) if (!used.has(String(account._id))) result.push({ account, amount: 0 });
  return result;
};

const partyOf = (type, party) => ({ partyType: type, partyId: party._id, partyName: party.name });

/**
 * POST /accounting/opening. One transaction: validates, writes the party opening
 * documents, reverses the current opening entry (and folds the setup-mode
 * opening_inventory entries), posts a new OB entry and records what it was built from.
 */
const saveOpening = async (body, { session, actor = null }) => {
  const meta = await getOpeningMeta(session);
  if (!meta.ledgerStartAt) throw httpError(409, "بداية الدفاتر غير مسجلة بعد", { code: "LEDGER_NOT_STARTED" });
  if (meta.opening?.status === "finalized") throw httpError(409, "رصيد البداية معتمد نهائيًا ولا يمكن تعديله", { code: "OPENING_FINALIZED" });
  const input = body && typeof body === "object" ? body : {};
  const cash = parseAmount(input.cash, "الخزنة");
  const fixedAssets = parseAmount(input.fixedAssets, "الأصول الثابتة");
  const customerRows = parseRows(input.customers, { idKey: "customerId", label: "أرصدة العملاء", allowNegative: true });
  const supplierRows = parseRows(input.suppliers, { idKey: "supplierId", label: "أرصدة الموردين", allowNegative: true });

  const [customers, suppliers] = await Promise.all([
    Customer.find({ _id: { $in: customerRows.map((row) => row.id) } }).select("name").session(session).lean(),
    Supplier.find({ _id: { $in: supplierRows.map((row) => row.id) } }).select("name").session(session).lean(),
  ]);
  const customerById = new Map(customers.map((row) => [String(row._id), row]));
  const supplierById = new Map(suppliers.map((row) => [String(row._id), row]));
  for (const row of customerRows) if (!customerById.has(row.id)) throw httpError(404, "عميل غير موجود في أرصدة العملاء", { code: "CUSTOMER_NOT_FOUND", customerId: row.id });
  for (const row of supplierRows) if (!supplierById.has(row.id)) throw httpError(404, "مورد غير موجود في أرصدة الموردين", { code: "SUPPLIER_NOT_FOUND", supplierId: row.id });

  // A customer opening can never go below what receipts already collected from it.
  const existingCustomerOpenings = await PartyOpening.find({ partyType: "customer" }).session(session);
  const newAmountByCustomer = new Map(customerRows.map((row) => [row.id, row.amount]));
  for (const existing of existingCustomerOpenings) {
    const collected = collectedOf(existing);
    const next = newAmountByCustomer.get(String(existing.partyId)) ?? 0;
    if (collected > 0 && next < collected) {
      const customer = await Customer.findById(existing.partyId).select("name").session(session).lean();
      throw httpError(409, `لا يمكن تخفيض رصيد أول المدة للعميل ${customer?.name || ""} عن المبلغ المحصّل منه (${collected})`, { code: "OPENING_BELOW_COLLECTED", customerId: existing.partyId, customerName: customer?.name || "", collected });
    }
  }

  const banks = await resolveBanks(input.banks, session);
  const accounts = await accountMap(["CASH_MAIN", "INVENTORY", "FIXED_ASSETS", "CUSTOMERS", "SUPPLIERS", "CAPITAL"], session);
  const setupMode = !(await hasLedgerActivity(meta.ledgerStartAt, session));
  const previous = await currentOpeningEntry(meta.opening, session);

  // Customer balances that came from invoices before the ledger start (Stage 17 OB) stay as they are.
  let carried = meta.opening?.data?.carriedCustomers;
  if (!carried) {
    const byCustomer = new Map();
    for (const row of previous?.lines || []) {
      if (String(row.accountId) !== String(accounts.get("CUSTOMERS")._id) || !row.partyId) continue;
      byCustomer.set(String(row.partyId), roundMoney((byCustomer.get(String(row.partyId)) || 0) + row.debit - row.credit));
    }
    carried = [...byCustomer].filter(([, amount]) => amount !== 0).map(([customerId, amount]) => ({ customerId, amount }));
  }

  const carriedInventory = previous ? sumLines(previous, accounts.get("INVENTORY")._id) : 0;
  const folded = await foldableEntries(session);
  const date = meta.ledgerStartAt;
  // Each reversal carries its original's date, so the pair nets out in the same period.
  for (const entry of folded) await reverseEntry(entry._id, { date: entry.date, memo: "Opening balance re-save", session });

  const inventory = setupMode
    ? roundMoney(await stockValue(session) - await inventoryOutsideOpening(accounts.get("INVENTORY")._id, session))
    : carriedInventory;

  // Party opening documents.
  const openingNumber = await nextDocumentNumber(PREFIXES.OPENING_BALANCE, session);
  const wantedCustomers = new Set(customerRows.map((row) => row.id));
  for (const existing of existingCustomerOpenings) {
    if (!wantedCustomers.has(String(existing.partyId))) await existing.deleteOne({ session });
  }
  for (const row of customerRows) {
    await PartyOpening.findOneAndUpdate({ partyType: "customer", partyId: row.id }, { $set: { amount: row.amount, date, number: openingNumber } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  }
  const wantedSuppliers = new Set(supplierRows.map((row) => row.id));
  await PartyOpening.deleteMany({ partyType: "supplier", partyId: { $nin: [...wantedSuppliers].map((id) => new mongoose.Types.ObjectId(id)) } }, { session });
  for (const row of supplierRows) {
    await PartyOpening.findOneAndUpdate({ partyType: "supplier", partyId: row.id }, { $set: { amount: row.amount, date, number: openingNumber } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
  }

  const lines = [];
  if (cash > 0) lines.push(line(accounts.get("CASH_MAIN"), cash, "debit"));
  for (const { account, amount } of banks) if (amount > 0) lines.push(line(account, amount, "debit"));
  if (inventory !== 0) lines.push(line(accounts.get("INVENTORY"), Math.abs(inventory), inventory > 0 ? "debit" : "credit"));
  if (fixedAssets > 0) lines.push(line(accounts.get("FIXED_ASSETS"), fixedAssets, "debit"));
  const customerTotals = new Map(customerRows.map((row) => [row.id, row.amount]));
  for (const row of carried) customerTotals.set(String(row.customerId), roundMoney((customerTotals.get(String(row.customerId)) || 0) + row.amount));
  const knownCustomers = new Map((await Customer.find({ _id: { $in: [...customerTotals.keys()] } }).select("name").session(session).lean()).map((row) => [String(row._id), row]));
  for (const [id, amount] of customerTotals) {
    if (amount === 0) continue;
    lines.push(line(accounts.get("CUSTOMERS"), Math.abs(amount), amount > 0 ? "debit" : "credit", partyOf("customer", knownCustomers.get(id) || { _id: id, name: "" })));
  }
  for (const row of supplierRows) lines.push(line(accounts.get("SUPPLIERS"), Math.abs(row.amount), row.amount > 0 ? "credit" : "debit", partyOf("supplier", supplierById.get(row.id))));
  const debits = roundMoney(lines.reduce((sum, row) => sum + row.debit, 0));
  const credits = roundMoney(lines.reduce((sum, row) => sum + row.credit, 0));
  const capital = roundMoney(debits - credits);
  if (capital !== 0) lines.push(line(accounts.get("CAPITAL"), Math.abs(capital), capital > 0 ? "credit" : "debit"));

  let entry = null;
  if (lines.length >= 2) {
    const id = new mongoose.Types.ObjectId();
    entry = await postEntry({ date, type: "opening", number: openingNumber, source: { type: "opening", id, number: openingNumber }, lines, memo: "Opening balances", session, createdBy: actor?._id || null, createdByName: actor?.name || null });
  }
  const data = {
    cash, fixedAssets, inventory, inventoryMode: setupMode ? "live" : "carried",
    banks: banks.map(({ account, amount }) => ({ accountId: account._id, amount })),
    carriedCustomers: carried.map((row) => ({ customerId: row.customerId, amount: row.amount })),
  };
  await Meta.updateOne({ _id: "schema" }, { $set: { opening: { status: "setup", entryId: entry?._id || null, savedAt: new Date(), data } } }, { session });
  const totals = openingTotals({
    cash, banks: banks.map(({ amount }) => ({ amount })), fixedAssets, inventory: { amount: inventory },
    customers: customerRows.map((row) => ({ amount: row.amount })), carriedCustomers: carried, suppliers: supplierRows.map((row) => ({ amount: row.amount })),
  });
  return { entry, number: entry?.number || null, totals, setupMode };
};

const finalizeOpening = async ({ session, actor = null }) => {
  const meta = await getOpeningMeta(session);
  if (meta.opening?.status === "finalized") throw httpError(409, "رصيد البداية معتمد نهائيًا", { code: "OPENING_FINALIZED" });
  if (!meta.opening?.savedAt) throw httpError(409, "احفظ الأرصدة قبل اعتمادها نهائيًا", { code: "OPENING_NOT_SAVED" });
  const finalizedAt = new Date();
  await Meta.updateOne({ _id: "schema" }, { $set: { "opening.status": "finalized", "opening.finalizedAt": finalizedAt, ...(actor ? { "opening.finalizedBy": actor._id, "opening.finalizedByName": actor.name } : {}) } }, { session });
  return { finalizedAt };
};

module.exports = {
  OPENING_INVENTORY, getOpeningMeta, isSetupMode, hasLedgerActivity, postStockAdjustment,
  loadOpeningState, openingTotals, saveOpening, finalizeOpening, currentOpeningEntry, getLedgerStartAt,
};
