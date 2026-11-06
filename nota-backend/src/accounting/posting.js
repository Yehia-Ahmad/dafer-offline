const mongoose = require("mongoose");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const ReturnLog = require("../models/returnLog.model");
const Product = require("../models/product.model");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");

const ACCOUNT_DEFINITIONS = [
  ["1", "الأصول", "Assets", "asset", "debit", null, true, null], ["11", "أصول متداولة", "Current assets", "asset", "debit", "1", true, null],
  ["111", "الخزائن", "Cash", "asset", "debit", "11", true, null], ["1111", "الخزنة الرئيسية", "Main cash", "asset", "debit", "111", false, "CASH_MAIN"],
  ["112", "البنوك والمحافظ", "Banks and wallets", "asset", "debit", "11", true, null], ["113", "العملاء", "Customers", "asset", "debit", "11", false, "CUSTOMERS"],
  ["114", "المخزون", "Inventory", "asset", "debit", "11", false, "INVENTORY"], ["12", "أصول ثابتة", "Fixed assets", "asset", "debit", "1", true, null],
  ["121", "أثاث ومعدات", "Furniture and equipment", "asset", "debit", "12", false, "FIXED_ASSETS"],
  ["2", "الخصوم", "Liabilities", "liability", "credit", null, true, null], ["21", "الموردين", "Suppliers", "liability", "credit", "2", false, "SUPPLIERS"],
  ["22", "ضريبة القيمة المضافة المستحقة", "VAT payable", "liability", "credit", "2", false, "VAT_PAYABLE"], ["23", "مصروفات مستحقة", "Accrued expenses", "liability", "credit", "2", false, "ACCRUED_EXPENSES"],
  ["3", "حقوق الملكية", "Equity", "equity", "credit", null, true, null], ["31", "رأس المال", "Capital", "equity", "credit", "3", false, "CAPITAL"],
  ["32", "الأرباح المحتجزة", "Retained earnings", "equity", "credit", "3", false, "RETAINED_EARNINGS"], ["33", "جاري المالك", "Owner drawings", "equity", "debit", "3", false, "OWNER_DRAWINGS"],
  ["4", "الإيرادات", "Revenue", "revenue", "credit", null, true, null], ["410", "المبيعات", "Sales", "revenue", "credit", "4", false, "SALES"],
  ["420", "خصم مسموح به", "Sales discount", "revenue", "debit", "4", false, "SALES_DISCOUNT"], ["430", "مردودات المبيعات", "Sales returns", "revenue", "debit", "4", false, "SALES_RETURNS"],
  ["440", "إيراد الشحن", "Shipping income", "revenue", "credit", "4", false, "SHIPPING_INCOME"], ["450", "إيرادات أخرى", "Other income", "revenue", "credit", "4", false, "OTHER_INCOME"],
  ["5", "المصروفات", "Expenses", "expense", "debit", null, true, null], ["510", "تكلفة البضاعة المباعة", "Cost of goods sold", "expense", "debit", "5", false, "COGS"],
  ["520", "مصروفات تشغيل", "Operating expenses", "expense", "debit", "5", true, null], ["521", "مرتبات", "Salaries", "expense", "debit", "520", false, "EXP_SALARIES"],
  ["522", "إيجار", "Rent", "expense", "debit", "520", false, "EXP_RENT"], ["523", "كهرباء ومياه", "Utilities", "expense", "debit", "520", false, "EXP_UTILITIES"],
  ["524", "نقل ومشاوير", "Transport", "expense", "debit", "520", false, "EXP_TRANSPORT"], ["525", "مصروفات متنوعة", "Miscellaneous", "expense", "debit", "520", false, "EXP_MISC"],
  ["530", "عجز وزيادة الخزينة", "Cash over/short", "expense", "debit", "5", false, "CASH_OVER_SHORT"], ["540", "فروق وتسويات المخزون", "Inventory adjustment", "expense", "debit", "5", false, "INVENTORY_ADJUSTMENT"],
];

const seedAccounts = async (session) => {
  const existing = new Map((await Account.find({}).session(session).lean()).map((a) => [a.code, a]));
  const created = [];
  for (const [code, nameAr, nameEn, type, normalSide, parentCode, isGroup, systemKey] of ACCOUNT_DEFINITIONS) {
    const parentId = parentCode ? existing.get(parentCode)?._id : null;
    const account = await Account.findOneAndUpdate(
      { code },
      { $setOnInsert: { code, nameAr, nameEn, type, normalSide, parentId, isGroup, isSystem: true, ...(systemKey ? { systemKey } : {}), isActive: true } },
      { upsert: true, new: true, session }
    );
    existing.set(code, account);
    created.push(account);
  }
  return created;
};

const accountMap = async (keys, session) => {
  let rows = await Account.find({ systemKey: { $in: keys } }).session(session).lean();
  if (rows.length < keys.length) {
    try {
      await seedAccounts(session);
    } catch (error) {
      // Concurrent first-time postings can race while seeding the chart. Let
      // the transaction helper retry from a fresh snapshot instead of
      // surfacing the duplicate-key race as a 500 response.
      if (error?.code === 11000 && typeof error.addErrorLabel === "function") error.addErrorLabel("TransientTransactionError");
      throw error;
    }
    rows = await Account.find({ systemKey: { $in: keys } }).session(session).lean();
  }
  const map = new Map(rows.map((row) => [row.systemKey, row]));
  for (const key of keys) if (!map.has(key)) throw new Error(`Missing accounting account ${key}`);
  return map;
};

const line = (account, amount, side, extra = {}) => ({
  accountId: account._id, accountCode: account.code, accountName: account.nameEn,
  accountNameAr: account.nameAr, accountNameEn: account.nameEn,
  debit: side === "debit" ? roundMoney(amount) : 0, credit: side === "credit" ? roundMoney(amount) : 0,
  ...extra,
});

const postEntry = async ({ date, type = "auto", source, lines, memo = "", session, createdBy = null, createdByName = null, number: suppliedNumber = null }) => {
  if (!session) throw new Error("Accounting entries require a transaction session");
  if (!source?.type || !source.id || lines.length < 2) throw new Error("Invalid journal source or lines");
  const clean = lines.filter((row) => Number(row.debit || 0) > 0 || Number(row.credit || 0) > 0).map((row) => ({ ...row, debit: roundMoney(row.debit || 0), credit: roundMoney(row.credit || 0) }));
  for (const row of clean) {
    if ((row.debit > 0) === (row.credit > 0)) throw new Error("Journal line must have exactly one side");
    const account = await Account.findById(row.accountId).session(session).lean();
    if (!account || account.isGroup || !account.isActive) throw new Error("Cannot post to inactive or group account");
    row.accountCode ||= account.code;
    row.accountNameAr ||= account.nameAr;
    row.accountNameEn ||= account.nameEn;
    row.accountName ||= account.nameEn;
    if (account.systemKey === "CUSTOMERS" && (row.partyType !== "customer" || !row.partyId)) throw new Error("Customer party is required");
    if (account.systemKey !== "CUSTOMERS" && row.partyType === "customer") throw new Error("Party is only allowed on control accounts");
  }
  const totalDebit = roundMoney(clean.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = roundMoney(clean.reduce((sum, row) => sum + row.credit, 0));
  if (totalDebit !== totalCredit) throw new Error(`Unbalanced journal entry: ${totalDebit} != ${totalCredit}`);
  const number = suppliedNumber || await nextDocumentNumber(PREFIXES.JOURNAL, session);
  const [entry] = await JournalEntry.create([{ number, date, type, source, lines: clean, totalDebit, totalCredit, memo, createdBy, createdByName }], { session });
  return entry;
};

const postInventoryAdjustment = async ({ date, source, amount, increase, session, memo }) => {
  const accounts = await accountMap(["INVENTORY", "INVENTORY_ADJUSTMENT"], session);
  return postEntry({ date, source, session, memo, lines: [
    line(accounts.get("INVENTORY"), amount, increase ? "debit" : "credit"),
    line(accounts.get("INVENTORY_ADJUSTMENT"), amount, increase ? "credit" : "debit"),
  ] });
};

const postCostSync = async ({ date, source, amount, increase, session, memo }) => {
  const accounts = await accountMap(["COGS", "INVENTORY_ADJUSTMENT"], session);
  return postEntry({ date, source, session, memo, lines: [
    line(accounts.get("COGS"), amount, increase ? "debit" : "credit"),
    line(accounts.get("INVENTORY_ADJUSTMENT"), amount, increase ? "credit" : "debit"),
  ] });
};

const buildSaleLines = async ({ sale, credit = false, customer, session }) => {
  const keys = ["CASH_MAIN", "CUSTOMERS", "SALES", "SALES_DISCOUNT", "SHIPPING_INCOME", "COGS", "INVENTORY"];
  const accounts = await accountMap(keys, session);
  const total = roundMoney(sale.totalPrice || 0);
  const subtotal = roundMoney((sale.items || []).reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));
  const discount = roundMoney(sale.discountAmount || 0);
  const shipping = roundMoney(sale.shippingFees || 0);
  const cost = roundMoney((sale.items || []).reduce((sum, item) => sum + Number(item.purchasePrice || 0) * Number(item.quantity || 0), 0));
  const lines = [line(accounts.get(credit ? "CUSTOMERS" : "CASH_MAIN"), total, "debit", credit ? { partyType: "customer", partyId: customer?._id, partyName: customer?.name } : {}), line(accounts.get("SALES"), subtotal, "credit")];
  if (discount > 0) lines.push(line(accounts.get("SALES_DISCOUNT"), discount, "debit"));
  if (shipping > 0) lines.push(line(accounts.get("SHIPPING_INCOME"), shipping, "credit"));
  if (cost > 0) { lines.push(line(accounts.get("COGS"), cost, "debit")); lines.push(line(accounts.get("INVENTORY"), cost, "credit")); }
  return lines;
};

const postSale = async ({ sale, credit = false, customer, session, sourceType = credit ? "credit_sale" : "sale" }) => {
  const lines = await buildSaleLines({ sale, credit, customer, session });
  return postEntry({ date: sale.sellingDate, source: { type: sourceType, id: sale._id, number: sale.number }, lines, session });
};

const findSaleEntry = (sourceType, sourceId, session) => JournalEntry.findOne({
  "source.type": sourceType, "source.id": sourceId, type: "auto", reversedBy: null,
}).session(session);

const reverseSaleEntry = async (sourceType, sourceId, options) => {
  const entry = await findSaleEntry(sourceType, sourceId, options.session);
  return entry ? reverseEntry(entry._id, options) : null;
};

const postLegacySaleReversal = async ({ sale, credit = false, customer, date, memo, session }) => {
  const original = await buildSaleLines({ sale, credit, customer, session });
  return postEntry({ date, type: "reversal", source: { type: credit ? "credit_sale" : "sale", id: sale._id, number: sale.number }, memo, session,
    lines: original.map((row) => ({ ...row, debit: row.credit, credit: row.debit })) });
};

const postSaleDifference = async ({ oldSale, newSale, credit = false, customer, date, session }) => {
  const [oldLines, newLines] = await Promise.all([
    buildSaleLines({ sale: oldSale, credit, customer, session }),
    buildSaleLines({ sale: newSale, credit, customer, session }),
  ]);
  const totals = new Map();
  const add = (row, factor) => {
    const key = `${row.accountId}:${row.partyId || ""}`;
    const current = totals.get(key) || { ...row, amount: 0 };
    current.amount = roundMoney(current.amount + factor * (Number(row.debit || 0) - Number(row.credit || 0)));
    totals.set(key, current);
  };
  oldLines.forEach((row) => add(row, -1)); newLines.forEach((row) => add(row, 1));
  const lines = [...totals.values()].filter((row) => row.amount !== 0).map((row) => ({ ...row, debit: row.amount > 0 ? row.amount : 0, credit: row.amount < 0 ? Math.abs(row.amount) : 0 }));
  if (!lines.length) return null;
  return postEntry({ date, source: { type: credit ? "credit_sale_edit" : "sale_edit", id: newSale._id, number: newSale.number }, memo: "Pre-ledger invoice edit difference", lines, session });
};

const postCancelInventoryValueAdjustment = async ({ sale, reversalEntries, session }) => {
  const productIds = [...new Set((sale.items || []).map((item) => String(item.product || item.productId)).filter(Boolean))];
  const products = await Product.find({ _id: { $in: productIds } }).select("purchasePrice").session(session).lean();
  const current = new Map(products.map((product) => [String(product._id), Number(product.purchasePrice || 0)]));
  const desired = roundMoney((sale.items || []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0)) * Number(current.get(String(item.product || item.productId)) || 0), 0));
  const posted = roundMoney((reversalEntries || []).reduce((sum, entry) => sum + (entry?.lines || []).filter((row) => row.accountCode === "114").reduce((inner, row) => inner + Number(row.debit || 0) - Number(row.credit || 0), 0), 0));
  const difference = roundMoney(desired - posted);
  if (!difference) return null;
  return postInventoryAdjustment({ date: sale.cancelledAt || new Date(), source: { type: "cancel_cost_adjustment", id: sale._id, number: sale.number }, amount: Math.abs(difference), increase: difference > 0, session, memo: "Cancel stock restored at current purchase price" });
};

const postReceipt = async ({ receipt, customer, session }) => {
  const accounts = await accountMap(["CASH_MAIN", "CUSTOMERS"], session);
  return postEntry({ date: receipt.paymentDate, source: { type: "receipt", id: receipt._id, number: receipt.number }, session, lines: [
    line(accounts.get("CASH_MAIN"), receipt.amount, "debit"), line(accounts.get("CUSTOMERS"), receipt.amount, "credit", { partyType: "customer", partyId: customer._id, partyName: customer.name }),
  ] });
};

const postReturn = async ({ returnLog, sale, customer, session }) => {
  const accounts = await accountMap(["SALES_RETURNS", "SHIPPING_INCOME", "SALES_DISCOUNT", "CASH_MAIN", "CUSTOMERS", "INVENTORY", "COGS", "INVENTORY_ADJUSTMENT"], session);
  const subtotal = roundMoney(returnLog.subtotalReturnedAmount || 0); const discount = roundMoney(returnLog.discountAmount || 0); const shipping = roundMoney(returnLog.shippingFees || 0); const total = roundMoney(returnLog.finalReturnedAmount || 0);
  const lines = [line(accounts.get("SALES_RETURNS"), subtotal, "debit"), line(accounts.get(returnLog.returnType === "cash" ? "CASH_MAIN" : "CUSTOMERS"), total, "credit", returnLog.returnType === "credit" ? { partyType: "customer", partyId: customer?._id, partyName: customer?.name } : {})];
  if (discount > 0) lines.push(line(accounts.get("SALES_DISCOUNT"), discount, "credit"));
  if (shipping > 0) lines.push(line(accounts.get("SHIPPING_INCOME"), shipping, "debit"));
  const originalCost = roundMoney((returnLog.items || []).reduce((sum, item) => {
    const stored = Number(item.purchasePrice);
    if (Number.isFinite(stored) && stored >= 0) return sum + stored * Number(item.quantity || 0);
    const original = (sale.items || []).find((lineItem) => String(lineItem._id) === String(item.invoiceItemId) || String(lineItem.productId || lineItem.product) === String(item.productId || item.product));
    return sum + Number(original?.purchasePrice || 0) * Number(item.quantity || 0);
  }, 0));
  const productIds = [...new Set((returnLog.items || []).map((item) => String(item.productId || item.product)).filter(Boolean))];
  const products = await Product.find({ _id: { $in: productIds } }).select("purchasePrice").session(session).lean();
  const currentById = new Map(products.map((product) => [String(product._id), Number(product.purchasePrice || 0)]));
  const inventoryCost = roundMoney((returnLog.items || []).reduce((sum, item) => sum + Number(item.quantity || 0) * Number(currentById.get(String(item.productId || item.product)) || 0), 0));
  if (inventoryCost > 0) lines.push(line(accounts.get("INVENTORY"), inventoryCost, "debit"));
  if (originalCost > 0) lines.push(line(accounts.get("COGS"), originalCost, "credit"));
  const costDifference = roundMoney(inventoryCost - originalCost);
  if (costDifference > 0) lines.push(line(accounts.get("INVENTORY_ADJUSTMENT"), costDifference, "credit"));
  if (costDifference < 0) lines.push(line(accounts.get("INVENTORY_ADJUSTMENT"), Math.abs(costDifference), "debit"));
  return postEntry({ date: returnLog.returnDate, source: { type: "return", id: returnLog._id, number: returnLog.number }, lines, session });
};

const reverseEntry = async (id, { date, memo, session }) => {
  const original = await JournalEntry.findById(id).session(session);
  if (!original) return null;
  const existing = await JournalEntry.findOne({ reversalOf: original._id }).session(session);
  if (existing) return existing;
  const reversed = await postEntry({ date, type: "reversal", source: original.source, memo, session, lines: original.lines.map((row) => ({ ...(row.toObject?.() || row), debit: row.credit, credit: row.debit })) });
  original.reversedBy = reversed._id;
  await original.save({ session });
  return reversed;
};

const reverseAllFor = async (sourceType, sourceId, options) => {
  const sourceIds = [sourceId];
  if (sourceType === "sale" || sourceType === "credit_sale") {
    const logs = await ReturnLog.find({ invoiceId: sourceId }).select("_id").session(options.session).lean();
    const returnEntries = await JournalEntry.find({ "source.type": "return", "source.id": { $in: logs.map((log) => log._id) }, type: "auto", reversedBy: null }).session(options.session);
    for (const entry of returnEntries) sourceIds.push(entry._id);
  }
  const entries = await JournalEntry.find({ $or: [{ "source.type": sourceType, "source.id": sourceId, type: "auto", reversedBy: null }, { _id: { $in: sourceIds.slice(1) } }] }).session(options.session);
  const results = [];
  for (const entry of entries) results.push(await reverseEntry(entry._id, options));
  return results;
};

module.exports = { ACCOUNT_DEFINITIONS, seedAccounts, postEntry, postSale, postReceipt, postReturn, postInventoryAdjustment, postCostSync, reverseEntry, reverseSaleEntry, reverseAllFor, postLegacySaleReversal, postSaleDifference, postCancelInventoryValueAdjustment, accountMap, line, buildSaleLines };
