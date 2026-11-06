const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const CashBox = require("../models/cashBox.model");
const ReturnLog = require("../models/returnLog.model");
const Product = require("../models/product.model");
const Meta = require("../models/meta.model");
const Supplier = require("../models/supplier.model");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { computeCustomerStatement } = require("../services/customerStatement.service");

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

/**
 * Stage 19: the ledger account of the box a money document went through. A document without a box
 * (created before Stage 19) belongs to the main box, which is account 1111 (CASH_MAIN).
 */
const boxAccount = async (boxId, session) => {
  if (!boxId) return (await accountMap(["CASH_MAIN"], session)).get("CASH_MAIN");
  const box = await CashBox.findById(boxId).select("accountId").session(session || null).lean();
  if (!box) throw new Error(`Cash box ${boxId} does not exist`);
  const account = await Account.findById(box.accountId).session(session || null).lean();
  if (!account) throw new Error(`Cash box ${boxId} has no account`);
  return account;
};

const customerParty = (customer) => ({ partyType: "customer", partyId: customer?._id, partyName: customer?.name });

/** The ledger start date (Meta.ledgerStartAt), or null before the Stage 17 migration ran. */
const getLedgerStartAt = async (session) => {
  const meta = await Meta.findById("schema").select("ledgerStartAt").session(session).lean();
  return meta?.ledgerStartAt ? new Date(meta.ledgerStartAt) : null;
};

/**
 * A document belongs to the ledger when it was created on/after ledgerStartAt.
 * The health check uses the same rule, so posting and checking agree.
 */
const isLedgerDocument = (doc, ledgerStartAt) =>
  !ledgerStartAt || Boolean(doc?.createdAt && new Date(doc.createdAt) >= ledgerStartAt);

/**
 * Posts one journal entry. Returns null when every line is zero (a document
 * with nothing to post), so callers never need to special-case free invoices.
 */
const postEntry = async ({ date, type = "auto", source, lines, memo = "", session, createdBy = null, createdByName = null, number: suppliedNumber = null, reversalOf = null }) => {
  if (!session) throw new Error("Accounting entries require a transaction session");
  if (!source?.type || !source.id || !Array.isArray(lines)) throw new Error("Invalid journal source or lines");
  for (const row of lines) {
    if (Number(row.debit || 0) < 0 || Number(row.credit || 0) < 0) throw new Error("Journal line amounts cannot be negative");
  }
  const clean = lines
    .map((row) => ({ ...row, debit: roundMoney(row.debit || 0), credit: roundMoney(row.credit || 0) }))
    .filter((row) => row.debit > 0 || row.credit > 0);
  if (clean.length === 0) return null;
  if (clean.length < 2) throw new Error("A journal entry needs at least two non-zero lines");
  for (const row of clean) {
    if ((row.debit > 0) === (row.credit > 0)) throw new Error("Journal line must have exactly one side");
    if (row.partyId && !row.partyType) throw new Error("Party type is required when a party is set");
    const account = await Account.findById(row.accountId).session(session).lean();
    if (!account || account.isGroup || !account.isActive) throw new Error("Cannot post to inactive or group account");
    row.accountCode ||= account.code;
    row.accountNameAr ||= account.nameAr;
    row.accountNameEn ||= account.nameEn;
    row.accountName ||= account.nameEn;
    if (account.systemKey === "CUSTOMERS" && (row.partyType !== "customer" || !row.partyId)) throw new Error("Customer party is required");
    if (account.systemKey === "SUPPLIERS") {
      if (row.partyType !== "supplier" || !row.partyId) throw new Error("Supplier party is required");
      if (!(await Supplier.exists({ _id: row.partyId }).session(session))) throw new Error("Supplier party does not exist");
    }
    if (account.systemKey !== "CUSTOMERS" && account.systemKey !== "SUPPLIERS" && (row.partyType || row.partyId)) throw new Error("Party is only allowed on control accounts");
  }
  const totalDebit = roundMoney(clean.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = roundMoney(clean.reduce((sum, row) => sum + row.credit, 0));
  if (totalDebit !== totalCredit) throw new Error(`Unbalanced journal entry: ${totalDebit} != ${totalCredit}`);
  const number = suppliedNumber || await nextDocumentNumber(PREFIXES.JOURNAL, session);
  const [entry] = await JournalEntry.create([{ number, date, type, source, lines: clean, totalDebit, totalCredit, memo, createdBy, createdByName, reversalOf }], { session });
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

const itemProductId = (item) => String(item?.product || item?.productId || "");
/** Units of an invoice line already returned (stored count, else summed from refunds like the controllers do). */
const returnedUnits = (sale, item) => {
  if (item?.returnedQuantity !== undefined && item?.returnedQuantity !== null) return Number(item.returnedQuantity || 0);
  return (sale?.refunds || []).reduce((total, refund) => total + (refund.items || []).reduce(
    (sum, refundItem) => sum + (String(refundItem.invoiceItemId) === String(item?._id) ? Number(refundItem.quantity || 0) : 0), 0), 0);
};
const lineCost = (items) => roundMoney((items || []).reduce((sum, item) => sum + Number(item.purchasePrice || 0) * Number(item.quantity || 0), 0));

const buildSaleLines = async ({ sale, credit = false, customer, session }) => {
  const keys = ["CASH_MAIN", "CUSTOMERS", "SALES", "SALES_DISCOUNT", "SHIPPING_INCOME", "COGS", "INVENTORY"];
  const accounts = await accountMap(keys, session);
  const total = roundMoney(sale.totalPrice || 0);
  const subtotal = roundMoney((sale.items || []).reduce((sum, item) => sum + Number(item.totalPrice || 0), 0));
  const discount = roundMoney(sale.discountAmount || 0);
  const shipping = roundMoney(sale.shippingFees || 0);
  const cost = lineCost(sale.items);
  const payAccount = credit ? accounts.get("CUSTOMERS") : await boxAccount(sale.boxId, session);
  const lines = [line(payAccount, total, "debit", credit ? customerParty(customer) : {}), line(accounts.get("SALES"), subtotal, "credit")];
  if (discount > 0) lines.push(line(accounts.get("SALES_DISCOUNT"), discount, "debit"));
  if (shipping > 0) lines.push(line(accounts.get("SHIPPING_INCOME"), shipping, "credit"));
  if (cost > 0) { lines.push(line(accounts.get("COGS"), cost, "debit")); lines.push(line(accounts.get("INVENTORY"), cost, "credit")); }
  return lines;
};

const postSale = async ({ sale, credit = false, customer, session, sourceType = credit ? "credit_sale" : "sale" }) => {
  const lines = await buildSaleLines({ sale, credit, customer, session });
  return postEntry({ date: sale.sellingDate, source: { type: sourceType, id: sale._id, number: sale.number }, lines, session });
};

/** Nets signed lines per account+party into debit/credit lines. */
const netLines = (signedRows) => {
  const totals = new Map();
  for (const { row, factor } of signedRows) {
    const key = `${row.accountId}:${row.partyId || ""}`;
    const current = totals.get(key) || { ...row, amount: 0 };
    current.amount = roundMoney(current.amount + factor * (Number(row.debit || 0) - Number(row.credit || 0)));
    totals.set(key, current);
  }
  return [...totals.values()].filter((row) => row.amount !== 0).map(({ amount, ...row }) => ({ ...row, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0 }));
};

/**
 * options.redirect = { from: Set<accountId string>, to: account }: lines on one of the `from` accounts are
 * reversed on the `to` account instead (Stage 19: see reverseAllFor).
 */
const reverseEntry = async (id, { date, memo, session, redirect = null }) => {
  const original = await JournalEntry.findById(id).session(session);
  if (!original) return null;
  const existing = await JournalEntry.findOne({ reversalOf: original._id }).session(session)
    || (original.reversedBy ? await JournalEntry.findById(original.reversedBy).session(session) : null);
  if (existing) return existing;
  const reversed = await postEntry({
    date, type: "reversal", source: original.source, memo, session, reversalOf: original._id,
    lines: original.lines.map((row) => {
      const reversed = { ...(row.toObject?.() || row), debit: row.credit, credit: row.debit };
      if (redirect && redirect.from.has(String(row.accountId))) {
        Object.assign(reversed, { accountId: redirect.to._id, accountCode: redirect.to.code, accountName: redirect.to.nameEn, accountNameAr: redirect.to.nameAr, accountNameEn: redirect.to.nameEn });
      }
      return reversed;
    }),
  });
  original.reversedBy = reversed._id;
  await original.save({ session });
  return reversed;
};

const openAutoEntries = (filters, session) => JournalEntry.find({ $or: filters.map((filter) => ({ ...filter, type: "auto", reversedBy: null })) }).sort({ createdAt: 1, _id: 1 }).session(session);

/** Reverses an invoice's sale entry and its cost_sync entries (used by edits). */
const reverseSaleAndCostSync = async (sourceType, sourceId, options) => {
  const entries = await openAutoEntries([{ "source.type": sourceType, "source.id": sourceId }, { "source.type": "cost_sync", "source.id": sourceId }], options.session);
  const results = [];
  for (const entry of entries) results.push(await reverseEntry(entry._id, options));
  return results;
};

/**
 * Cancel: reverses the invoice's sale, cost_sync and return entries.
 * Stage 19: for a cash invoice (options.saleBoxId given, null = main box), a cash return's refund line is
 * reversed on the SALE's box. The cancel then pays the customer (total - already returned) out of the sale's
 * box, so every box ends where the cash really is whichever box each refund came from.
 */
const reverseAllFor = async (sourceType, sourceId, options) => {
  const filters = [{ "source.type": sourceType, "source.id": sourceId }];
  if (sourceType === "sale" || sourceType === "credit_sale") {
    filters.push({ "source.type": "cost_sync", "source.id": sourceId });
    const logs = await ReturnLog.find({ invoiceId: sourceId }).select("_id").session(options.session).lean();
    if (logs.length) filters.push({ "source.type": "return", "source.id": { $in: logs.map((log) => log._id) } });
  }
  const entries = await openAutoEntries(filters, options.session);
  const { saleBoxId, ...reverseOptions } = options;
  let redirect = null;
  if (saleBoxId !== undefined && sourceType === "sale") {
    const boxes = await CashBox.find({}).select("accountId").session(options.session || null).lean();
    redirect = { from: new Set(boxes.map((box) => String(box.accountId))), to: await boxAccount(saleBoxId, options.session) };
  }
  const results = [];
  for (const entry of entries) results.push(await reverseEntry(entry._id, { ...reverseOptions, redirect: entry.source.type === "return" ? redirect : null }));
  return results;
};

/**
 * Units returned before the ledger started, per invoice line. Those returns
 * have no journal entry, so a pre-ledger cancel must not reverse them again.
 */
const preLedgerReturnedUnits = async (sale, ledgerStartAt, session) => {
  const logs = await ReturnLog.find({ invoiceId: sale._id }).session(session).lean();
  const postLedger = logs.filter((log) => isLedgerDocument(log, ledgerStartAt));
  const preLedger = logs.filter((log) => !isLedgerDocument(log, ledgerStartAt));
  const postUnits = new Map();
  for (const log of postLedger) {
    for (const item of log.items || []) {
      const lineItem = (sale.items || []).find((candidate) => (item.invoiceItemId && String(candidate._id) === String(item.invoiceItemId)))
        || (sale.items || []).find((candidate) => itemProductId(candidate) === String(item.productId || item.product));
      if (lineItem) postUnits.set(String(lineItem._id), (postUnits.get(String(lineItem._id)) || 0) + Number(item.quantity || 0));
    }
  }
  const units = new Map((sale.items || []).map((item) => [String(item._id), Math.max(0, returnedUnits(sale, item) - (postUnits.get(String(item._id)) || 0))]));
  const money = preLedger.reduce((sum, log) => ({
    subtotal: sum.subtotal + Number(log.subtotalReturnedAmount || 0),
    discount: sum.discount + Number(log.discountAmount || 0),
    shipping: sum.shipping + Number(log.shippingFees || 0),
    total: sum.total + Number(log.finalReturnedAmount || 0),
  }), { subtotal: 0, discount: 0, shipping: 0, total: 0 });
  return { units, money };
};

/**
 * Cancel of an invoice created before the ledger started: there is no sale
 * entry to reverse, so post the reversal of the position the invoice still
 * held at the ledger start (the sale less returns made before the ledger).
 * Its type is "legacy_reversal": it has no original entry, so no reversalOf.
 */
const postLegacySaleReversal = async ({ sale, credit = false, customer, date, memo, session }) => {
  const ledgerStartAt = await getLedgerStartAt(session);
  const accounts = await accountMap(["CASH_MAIN", "CUSTOMERS", "SALES", "SALES_DISCOUNT", "SHIPPING_INCOME", "COGS", "INVENTORY"], session);
  const { units, money } = await preLedgerReturnedUnits(sale, ledgerStartAt, session);
  const cost = roundMoney((sale.items || []).reduce((sum, item) => sum + Number(item.purchasePrice || 0) * Math.max(0, Number(item.quantity || 0) - (units.get(String(item._id)) || 0)), 0));
  const subtotal = roundMoney((sale.items || []).reduce((sum, item) => sum + Number(item.totalPrice || 0), 0) - money.subtotal);
  const discount = roundMoney(Number(sale.discountAmount || 0) - money.discount);
  const shipping = roundMoney(Number(sale.shippingFees || 0) - money.shipping);
  const total = roundMoney(Number(sale.totalPrice || 0) - money.total);
  const legacyPayAccount = credit ? accounts.get("CUSTOMERS") : await boxAccount(sale.boxId, session);
  const position = [
    line(legacyPayAccount, total, "debit", credit ? customerParty(customer) : {}),
    line(accounts.get("SALES"), subtotal, "credit"),
    line(accounts.get("SALES_DISCOUNT"), discount, "debit"),
    line(accounts.get("SHIPPING_INCOME"), shipping, "credit"),
    line(accounts.get("COGS"), cost, "debit"),
    line(accounts.get("INVENTORY"), cost, "credit"),
  ];
  return postEntry({ date, type: "legacy_reversal", source: { type: credit ? "credit_sale" : "sale", id: sale._id, number: sale.number }, memo, session,
    lines: netLines(position.map((row) => ({ row, factor: -1 }))) });
};

/** Edit of a pre-ledger invoice: posts only new − old. */
const postSaleDifference = async ({ oldSale, newSale, credit = false, customer, oldCustomer = customer, date, session }) => {
  const [oldLines, newLines] = await Promise.all([
    buildSaleLines({ sale: oldSale, credit, customer: oldCustomer, session }),
    buildSaleLines({ sale: newSale, credit, customer, session }),
  ]);
  const lines = netLines([...oldLines.map((row) => ({ row, factor: -1 })), ...newLines.map((row) => ({ row, factor: 1 }))]);
  if (!lines.length) return null;
  return postEntry({ date, source: { type: credit ? "credit_sale_edit" : "sale_edit", id: newSale._id, number: newSale.number }, memo: "Pre-ledger invoice edit difference", lines, session });
};

/**
 * Stock that comes back (or leaves) during a cancel or an edit is valued at
 * the product's CURRENT purchasePrice. The entries just posted moved
 * INVENTORY at the invoice line costs; the difference goes to
 * INVENTORY_ADJUSTMENT. Inventory lines are found by accountId (systemKey
 * INVENTORY), never by account code.
 * @param {Map<string, number>} restoredUnits productId → units back in stock (negative: units out)
 */
const postInventoryValueAdjustment = async ({ restoredUnits, entries, date, source, memo, session }) => {
  const accounts = await accountMap(["INVENTORY"], session);
  const inventoryId = String(accounts.get("INVENTORY")._id);
  const productIds = [...restoredUnits.keys()].filter(Boolean);
  const products = await Product.find({ _id: { $in: productIds } }).select("purchasePrice").session(session).lean();
  const current = new Map(products.map((product) => [String(product._id), Number(product.purchasePrice || 0)]));
  const desired = roundMoney([...restoredUnits.entries()].reduce((sum, [productId, units]) => sum + Number(units || 0) * (current.get(productId) || 0), 0));
  const posted = roundMoney((entries || []).filter(Boolean).reduce((sum, entry) => sum + (entry.lines || [])
    .filter((row) => String(row.accountId) === inventoryId)
    .reduce((inner, row) => inner + Number(row.debit || 0) - Number(row.credit || 0), 0), 0));
  const difference = roundMoney(desired - posted);
  if (!difference) return null;
  return postInventoryAdjustment({ date, source, amount: Math.abs(difference), increase: difference > 0, session, memo });
};

const postCancelInventoryValueAdjustment = async ({ sale, reversalEntries, session }) => {
  const restoredUnits = new Map();
  for (const item of sale.items || []) {
    const productId = itemProductId(item);
    restoredUnits.set(productId, (restoredUnits.get(productId) || 0) + Math.max(0, Number(item.quantity || 0) - returnedUnits(sale, item)));
  }
  return postInventoryValueAdjustment({ restoredUnits, entries: reversalEntries, date: sale.cancelledAt || new Date(), session,
    source: { type: "cancel_cost_adjustment", id: sale._id, number: sale.number }, memo: "Cancel stock restored at current purchase price" });
};

const postEditInventoryValueAdjustment = async ({ oldSale, newSale, entries, date, session }) => {
  const restoredUnits = new Map();
  for (const item of oldSale.items || []) restoredUnits.set(itemProductId(item), (restoredUnits.get(itemProductId(item)) || 0) + Number(item.quantity || 0));
  for (const item of newSale.items || []) restoredUnits.set(itemProductId(item), (restoredUnits.get(itemProductId(item)) || 0) - Number(item.quantity || 0));
  return postInventoryValueAdjustment({ restoredUnits, entries, date, session,
    source: { type: "edit_cost_adjustment", id: newSale._id, number: newSale.number }, memo: "Edit at current purchase price: units back in stock revalued from line cost, and kept units re-costed in the re-posted sale" });
};

/**
 * All ledger postings for an invoice edit (cash or credit).
 * - Ledger invoice: reverse the sale entry and its cost_sync entries, re-post
 *   the sale at the current line costs.
 * - Pre-ledger invoice: post new − old, and record that difference on the
 *   invoice (ledgerTrace) for the health check.
 * Both: value stock moved by the edit at the current purchase price.
 */
const postInvoiceEdit = async ({ Model, oldSale, newSale, credit = false, customer, oldCustomer = customer, date, session }) => {
  const sourceType = credit ? "credit_sale" : "sale";
  const ledgerStartAt = await getLedgerStartAt(session);
  let entries;
  if (isLedgerDocument(oldSale, ledgerStartAt)) {
    const reversals = await reverseSaleAndCostSync(sourceType, newSale._id, { date, memo: credit ? "Credit sale edit" : "Sale edit", session });
    entries = [...reversals, await postSale({ sale: newSale, credit, customer, session })];
  } else {
    entries = [await postSaleDifference({ oldSale, newSale, credit, customer, oldCustomer, date, session })];
    const netSalesDelta = roundMoney(Number(newSale.totalPrice || 0) - Number(oldSale.totalPrice || 0));
    const costDelta = roundMoney(lineCost(newSale.items) - lineCost(oldSale.items));
    if (netSalesDelta || costDelta) {
      await Model.updateOne({ _id: newSale._id }, { $inc: { "ledgerTrace.editNetSales": netSalesDelta, "ledgerTrace.editCost": costDelta } }, { session });
    }
  }
  await postEditInventoryValueAdjustment({ oldSale, newSale, entries, date, session });
  if (credit && oldCustomer?._id && customer?._id && String(oldCustomer._id) !== String(customer._id)) {
    await postCustomerTransfer({ sale: oldSale, from: oldCustomer, to: customer, date, session });
  }
  return entries;
};

/**
 * A credit invoice moved to another customer: the sale entries above moved the
 * invoice total; this moves the invoice's payments and returns, measured with
 * the Stage 16 statement function so the ledger keeps matching each statement.
 */
const postCustomerTransfer = async ({ sale, from, to, date, session }) => {
  const returns = await ReturnLog.find({ returnType: "credit", invoiceId: sale._id }).session(session).lean();
  const { totals } = computeCustomerStatement({ invoices: [sale], returnById: new Map(returns.map((row) => [String(row._id), row])) });
  const credits = roundMoney(Number(sale.totalPrice || 0) - totals.balance);
  if (!credits) return null;
  const accounts = await accountMap(["CUSTOMERS"], session);
  const customers = accounts.get("CUSTOMERS");
  // Positive credits: the old customer loses them (debit), the new one gains them (credit).
  const amount = Math.abs(credits);
  return postEntry({ date, source: { type: "customer_transfer", id: sale._id, number: sale.number }, memo: "Credit invoice moved to another customer", session, lines: [
    line(customers, amount, credits > 0 ? "debit" : "credit", customerParty(from)),
    line(customers, amount, credits > 0 ? "credit" : "debit", customerParty(to)),
  ] });
};

/**
 * All ledger postings for an invoice cancel (cash or credit), except the
 * down-payment refund which only credit cancels have.
 */
const postInvoiceCancel = async ({ Model, sale, credit = false, customer, session }) => {
  const sourceType = credit ? "credit_sale" : "sale";
  const date = sale.cancelledAt || new Date();
  const memo = credit ? "Credit sale cancellation" : "Sale cancellation";
  const ledgerStartAt = await getLedgerStartAt(session);
  const reversals = await reverseAllFor(sourceType, sale._id, { date, memo, session, ...(credit ? {} : { saleBoxId: sale.boxId || null }) });
  if (!isLedgerDocument(sale, ledgerStartAt)) {
    const memoText = `${credit ? "Pre-ledger credit invoice" : "Pre-ledger invoice"} cancelled: reverses the position held at the ledger start (no original entry to link)`;
    reversals.push(await postLegacySaleReversal({ sale, credit, customer, date, memo: memoText, session }));
    // Operational snapshot only: each line's purchasePrice now (a later sync
    // rewrites it). Health derives the expected cost from it independently.
    const cancelLines = (sale.items || []).map((item) => ({ invoiceItemId: item._id, purchasePrice: Number(item.purchasePrice || 0) }));
    await Model.updateOne({ _id: sale._id }, { $set: { "ledgerTrace.cancelLines": cancelLines } }, { session });
  }
  await postCancelInventoryValueAdjustment({ sale, reversalEntries: reversals, session });
  return reversals;
};

const postReceipt = async ({ receipt, customer, session }) => {
  const accounts = await accountMap(["CUSTOMERS"], session);
  const payAccount = await boxAccount(receipt.boxId, session);
  return postEntry({ date: receipt.paymentDate, source: { type: "receipt", id: receipt._id, number: receipt.number }, session, lines: [
    line(payAccount, receipt.amount, "debit"), line(accounts.get("CUSTOMERS"), receipt.amount, "credit", customerParty(customer)),
  ] });
};

const postReturn = async ({ returnLog, sale, customer, session }) => {
  const accounts = await accountMap(["SALES_RETURNS", "SHIPPING_INCOME", "SALES_DISCOUNT", "CUSTOMERS", "INVENTORY", "COGS", "INVENTORY_ADJUSTMENT"], session);
  const refundAccount = returnLog.returnType === "cash" ? await boxAccount(returnLog.boxId, session) : accounts.get("CUSTOMERS");
  const subtotal = roundMoney(returnLog.subtotalReturnedAmount || 0); const discount = roundMoney(returnLog.discountAmount || 0); const shipping = roundMoney(returnLog.shippingFees || 0); const total = roundMoney(returnLog.finalReturnedAmount || 0);
  const lines = [line(accounts.get("SALES_RETURNS"), subtotal, "debit"), line(refundAccount, total, "credit", returnLog.returnType === "credit" ? customerParty(customer) : {})];
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

module.exports = {
  ACCOUNT_DEFINITIONS, seedAccounts, postEntry, postSale, postReceipt, postReturn, postInventoryAdjustment, postCostSync,
  boxAccount, reverseEntry, reverseAllFor, reverseSaleAndCostSync, postLegacySaleReversal, postSaleDifference,
  postInventoryValueAdjustment, postCancelInventoryValueAdjustment, postEditInventoryValueAdjustment,
  postInvoiceEdit, postInvoiceCancel, accountMap, line, buildSaleLines, getLedgerStartAt, isLedgerDocument, returnedUnits,
};
