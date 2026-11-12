// Stage 22: manual journal entries. A draft (ManualEntryDraft) is edited freely; posting validates it and creates one JournalEntry
// (type "manual", source { type: "manual", id: draftId }) in the same transaction. A posted entry is never edited: a reversal posts
// the mirror (reverseEntry) and undoes the customer-credit allocation exactly.
const mongoose = require("mongoose");
const Account = require("../models/account.model");
const Customer = require("../models/customer.model");
const Supplier = require("../models/supplier.model");
const CashBox = require("../models/cashBox.model");
const CreditSale = require("../models/creditSale.model");
const PartyOpening = require("../models/partyOpening.model");
const ManualEntryDraft = require("../models/manualEntryDraft.model");
const { postEntry, reverseEntry, line } = require("./posting");
const { assertOpenDate } = require("./period");
const { nextDocumentNumber, PREFIXES } = require("../utils/documentNumber");
const { roundMoney } = require("../utils/invoicePricing");
const { businessDay, localDayAsUtc, now } = require("../utils/clock");
const { loadCustomerOpenItems, sortForCollection } = require("../services/customerOpenItems.service");

const httpError = (statusCode, code, message, extra = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.responseData = { code, ...extra };
  return error;
};

const isId = (value) => mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(String(value))) === String(value);

const INVOICE_ACCOUNT_KEYS = new Set(["SALES", "SALES_DISCOUNT", "SALES_RETURNS", "SHIPPING_INCOME", "COGS"]);

const BLOCK_MESSAGES = Object.freeze({
  BOX_ACCOUNT: "استخدم شاشة الخزائن أو المصروفات",
  INVENTORY_ACCOUNT: "استخدم تعديل الصنف",
  VAT_ACCOUNT: "استخدم شاشة الضريبة",
  INVOICE_ACCOUNT: "الحساب ده بيتحرك من الفواتير؛ صحّح بالمرتجع أو الإلغاء أو تعديل الفاتورة",
  CUSTOMER_DEBIT: "اعمل فاتورة آجل بدل القيد اليدوي",
  GROUP_ACCOUNT: "الحساب ده تجميعي، اختار حساب فرعي",
  INACTIVE_ACCOUNT: "الحساب ده موقوف",
});

/**
 * Why an account cannot be used in a manual entry, or null. Box accounts, INVENTORY, VAT (22 and 115: always, whether VAT is on or off) and the invoice accounts
 * have operational documents behind them and health compares them with those documents.
 * ctx: { boxAccountIds: Set<string> }.
 */
const blockReasonOf = (account, ctx) => {
  if (account.isGroup) return { code: "GROUP_ACCOUNT", message: BLOCK_MESSAGES.GROUP_ACCOUNT };
  if (account.isActive === false) return { code: "INACTIVE_ACCOUNT", message: BLOCK_MESSAGES.INACTIVE_ACCOUNT };
  const code = String(account.code || "");
  if (ctx.boxAccountIds.has(String(account._id)) || code.startsWith("111") || code.startsWith("112")) return { code: "BOX_ACCOUNT", message: BLOCK_MESSAGES.BOX_ACCOUNT };
  if (account.systemKey === "INVENTORY") return { code: "INVENTORY_ACCOUNT", message: BLOCK_MESSAGES.INVENTORY_ACCOUNT };
  if (account.systemKey === "VAT_INPUT" || account.systemKey === "VAT_PAYABLE") return { code: "VAT_ACCOUNT", message: BLOCK_MESSAGES.VAT_ACCOUNT };
  if (INVOICE_ACCOUNT_KEYS.has(account.systemKey)) return { code: "INVOICE_ACCOUNT", message: BLOCK_MESSAGES.INVOICE_ACCOUNT };
  return null;
};

const blockContext = async (session = null) => {
  const boxes = await CashBox.find({}).select("accountId").session(session).lean();
  return { boxAccountIds: new Set(boxes.map((box) => String(box.accountId))) };
};

/** Accounts a manual entry may use, each with its block reason (the picker shows blocked ones disabled). */
const accountOptions = async () => {
  const [accounts, ctx] = await Promise.all([Account.find({ isGroup: false, isActive: true }).sort({ code: 1 }).lean(), blockContext()]);
  return accounts.map((account) => ({
    _id: account._id, code: account.code, nameAr: account.nameAr, nameEn: account.nameEn, type: account.type, normalSide: account.normalSide,
    systemKey: account.systemKey || null, needsParty: account.systemKey === "CUSTOMERS" ? "customer" : account.systemKey === "SUPPLIERS" ? "supplier" : null,
    blocked: blockReasonOf(account, ctx),
  }));
};

// ---------------------------------------------------------------- body parsing

const today = () => localDayAsUtc(now());

/** YYYY-MM-DD or ISO -> the business day (UTC midnight). Future dates are refused. */
const parseEntryDate = (value, label = "التاريخ") => {
  if (value === undefined || value === null || value === "") throw httpError(400, "DATE_REQUIRED", `${label} مطلوب`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw httpError(400, "INVALID_DATE", `${label} غير صالح`);
  const day = businessDay(parsed);
  if (day.getTime() > today().getTime()) throw httpError(400, "FUTURE_DATE", `${label} مينفعش يكون في المستقبل`);
  return day;
};

const money = (value, label) => {
  if (value === undefined || value === null || value === "") return 0;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw httpError(400, "INVALID_AMOUNT", `${label} لازم يكون رقم صفر أو أكبر`);
  if (Math.abs(roundMoney(number) - number) > 1e-9) throw httpError(400, "INVALID_AMOUNT", `${label} لا يزيد عن خانتين عشريتين`);
  return roundMoney(number);
};

/** The lines of a request body, shaped (not yet checked against the chart: that is the post's job). */
const parseLines = (raw) => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw httpError(400, "INVALID_LINES", "سطور القيد غير صالحة");
  if (raw.length > 100) throw httpError(400, "INVALID_LINES", "القيد لا يزيد عن 100 سطر");
  return raw.map((row, index) => {
    if (!row || typeof row !== "object") throw httpError(400, "INVALID_LINES", `السطر ${index + 1} غير صالح`);
    if (!isId(row.accountId)) throw httpError(400, "ACCOUNT_REQUIRED", `اختار الحساب في السطر ${index + 1}`);
    const description = typeof row.description === "string" ? row.description.trim().slice(0, 200) : "";
    const debit = money(row.debit, "المدين");
    const credit = money(row.credit, "الدائن");
    const partyId = row.partyId ? (isId(row.partyId) ? new mongoose.Types.ObjectId(String(row.partyId)) : (() => { throw httpError(400, "INVALID_PARTY", `الطرف في السطر ${index + 1} غير صالح`); })()) : null;
    const partyType = partyId ? (row.partyType === "customer" || row.partyType === "supplier" ? row.partyType : (() => { throw httpError(400, "INVALID_PARTY", `نوع الطرف في السطر ${index + 1} غير صالح`); })()) : null;
    return { accountId: new mongoose.Types.ObjectId(String(row.accountId)), description, debit, credit, partyType, partyId };
  });
};

const parseDraftBody = (body, { partial = false } = {}) => {
  const data = body && typeof body === "object" ? body : {};
  const out = {};
  if (!partial || data.date !== undefined) out.date = parseEntryDate(data.date);
  if (data.memo !== undefined) {
    if (typeof data.memo !== "string") throw httpError(400, "INVALID_MEMO", "البيان غير صالح");
    out.memo = data.memo.trim().slice(0, 500);
  }
  const lines = parseLines(data.lines);
  if (lines !== undefined) out.lines = lines;
  return out;
};

// ---------------------------------------------------------------- validation at post

/** Everything a posted entry must satisfy. Throws 400 with a clear Arabic message; returns the ledger lines. */
const validateForPost = async (draft, session) => {
  if (!draft.memo || !String(draft.memo).trim()) throw httpError(400, "MEMO_REQUIRED", "البيان مطلوب");
  const rows = draft.lines || [];
  if (rows.length < 2) throw httpError(400, "LINES_REQUIRED", "القيد لازم يكون فيه سطرين على الأقل");
  const accounts = await Account.find({ _id: { $in: rows.map((row) => row.accountId) } }).session(session).lean();
  const byId = new Map(accounts.map((account) => [String(account._id), account]));
  const ctx = await blockContext(session);
  const ledgerLines = [];
  let totalDebit = 0; let totalCredit = 0;
  for (const [index, row] of rows.entries()) {
    const account = byId.get(String(row.accountId));
    if (!account) throw httpError(400, "ACCOUNT_NOT_FOUND", `الحساب في السطر ${index + 1} غير موجود`);
    const debit = roundMoney(row.debit || 0); const credit = roundMoney(row.credit || 0);
    if ((debit > 0) === (credit > 0)) throw httpError(400, "LINE_ONE_SIDE", `السطر ${index + 1}: لازم مدين أو دائن (واحد بس)`);
    const block = blockReasonOf(account, ctx);
    if (block) throw httpError(400, "FORBIDDEN_ACCOUNT", `${account.code} · ${account.nameAr}: ${block.message}`, { reason: block.code, accountId: account._id, line: index + 1 });
    let party = {};
    if (account.systemKey === "CUSTOMERS") {
      if (debit > 0) throw httpError(400, "CUSTOMER_DEBIT_FORBIDDEN", BLOCK_MESSAGES.CUSTOMER_DEBIT, { reason: "CUSTOMER_DEBIT", accountId: account._id, line: index + 1 });
      if (row.partyType !== "customer" || !row.partyId) throw httpError(400, "PARTY_REQUIRED", `السطر ${index + 1}: اختار العميل`);
      const customer = await Customer.findById(row.partyId).select("name").session(session).lean();
      if (!customer) throw httpError(400, "PARTY_NOT_FOUND", `السطر ${index + 1}: العميل غير موجود`);
      party = { partyType: "customer", partyId: customer._id, partyName: customer.name };
    } else if (account.systemKey === "SUPPLIERS") {
      if (row.partyType !== "supplier" || !row.partyId) throw httpError(400, "PARTY_REQUIRED", `السطر ${index + 1}: اختار المورد`);
      const supplier = await Supplier.findById(row.partyId).select("name").session(session).lean();
      if (!supplier) throw httpError(400, "PARTY_NOT_FOUND", `السطر ${index + 1}: المورد غير موجود`);
      party = { partyType: "supplier", partyId: supplier._id, partyName: supplier.name };
    } else if (row.partyId) {
      throw httpError(400, "PARTY_NOT_ALLOWED", `السطر ${index + 1}: الطرف بيتحدد على العملاء والموردين بس`);
    }
    totalDebit = roundMoney(totalDebit + debit); totalCredit = roundMoney(totalCredit + credit);
    ledgerLines.push(line(account, debit || credit, debit > 0 ? "debit" : "credit", { ...party, description: row.description || "" }));
  }
  if (totalDebit !== totalCredit) throw httpError(400, "UNBALANCED", `القيد مش متوازن: المدين ${totalDebit} والدائن ${totalCredit}`, { totalDebit, totalCredit });
  return ledgerLines;
};

// ---------------------------------------------------------------- customer credit allocation

const touchCustomer = (customerId, session) => Customer.collection.updateOne({ _id: customerId }, { $currentDate: { updatedAt: true } }, { session });

/**
 * A CREDIT on CUSTOMERS (a bad debt write-off) is set against that customer's open items, oldest first (the opening first, then
 * the invoices), the Stage 19 apply-credit mechanism with source "manual_entry": remainingAmount drops on the invoices / the
 * PartyOpening, so collection routes never try to collect what was written off. What no open item can take stays as customer credit.
 */
const allocateCustomerCredit = async ({ customerId, amount, draftId, number, session }) => {
  // required lazily: the credit-sale controller loads a lot of the app
  const { calculateCreditAmounts, applyCreditAmountsToInvoice } = require("../controllers/creditSale.controller");
  await touchCustomer(customerId, session);
  const items = sortForCollection((await loadCustomerOpenItems([customerId], { session })).get(String(customerId))?.items || [], "firstInvoice");
  const when = new Date();
  const allocations = [];
  let left = roundMoney(amount);
  for (const item of items) {
    if (left <= 0) break;
    const portion = roundMoney(Math.min(left, item.remaining));
    if (portion <= 0) continue;
    const payment = { amount: portion, paymentDate: when, note: `قيد يدوي ${number}`, source: "manual_entry", manualEntryId: draftId };
    if (item.kind === "opening") {
      const opening = await PartyOpening.findById(item.id).session(session);
      opening.payments.push(payment);
      await opening.save({ session });
    } else {
      const invoice = await CreditSale.findById(item.id).session(session);
      invoice.payments.push(payment);
      const amounts = calculateCreditAmounts(roundMoney(Number(invoice.totalPrice || 0) - Number(invoice.refundedAmount || 0)), invoice.payments, invoice.returnedPaidAmount, invoice.reallocatedPaidAmount);
      if (!amounts) throw httpError(409, "INVALID_INVOICE_AMOUNTS", "تعذر حساب مبالغ الفاتورة");
      applyCreditAmountsToInvoice(invoice, amounts);
      await invoice.save({ session });
    }
    allocations.push({ customerId, kind: item.kind === "opening" ? "opening" : "invoice", itemId: item.id, number: item.number || null, amount: portion });
    left = roundMoney(left - portion);
  }
  return allocations;
};

/**
 * The exact undo of allocateCustomerCredit: the payments this entry added are removed from the same items and the amounts are
 * recomputed, so every remainingAmount goes back to what it was before the entry. If an item was paid since, removing the
 * write-off payment simply reopens it for the written-off amount (the customer owes it again as that invoice's remaining debit).
 * An item that was cancelled or returned since cannot be restored exactly: 409 ALLOCATION_LOCKED.
 */
const undoCustomerAllocations = async (draft, session) => {
  const { calculateCreditAmounts, applyCreditAmountsToInvoice } = require("../controllers/creditSale.controller");
  const customers = [...new Set((draft.allocations || []).map((row) => String(row.customerId)))];
  for (const customerId of customers) await touchCustomer(new mongoose.Types.ObjectId(customerId), session);
  const isMine = (payment) => payment.source === "manual_entry" && String(payment.manualEntryId) === String(draft._id);
  for (const allocation of draft.allocations || []) {
    if (allocation.kind === "opening") {
      const opening = await PartyOpening.findById(allocation.itemId).session(session);
      if (!opening) continue;
      opening.payments = opening.payments.filter((payment) => !isMine(payment));
      await opening.save({ session });
      continue;
    }
    const invoice = await CreditSale.findById(allocation.itemId).session(session);
    if (!invoice) continue;
    if (!["pending", "partially_paid", "paid"].includes(invoice.status)) {
      throw httpError(409, "ALLOCATION_LOCKED", `مينفعش نعكس القيد: الفاتورة ${invoice.number || ""} اتغيرت بعد القيد (ملغية أو مرتجعة)`, { invoice: invoice.number || null });
    }
    invoice.payments = invoice.payments.filter((payment) => !isMine(payment));
    const amounts = calculateCreditAmounts(roundMoney(Number(invoice.totalPrice || 0) - Number(invoice.refundedAmount || 0)), invoice.payments, invoice.returnedPaidAmount, invoice.reallocatedPaidAmount);
    if (!amounts) throw httpError(409, "ALLOCATION_LOCKED", `مينفعش نعكس القيد: تعذر استرجاع الفاتورة ${invoice.number || ""}`, { invoice: invoice.number || null });
    applyCreditAmountsToInvoice(invoice, amounts);
    await invoice.save({ session });
  }
};

// ---------------------------------------------------------------- post / reverse

/** Posts a draft. Run inside a transaction. Returns { draft, entry }. */
const postDraft = async (draftId, { session, actor = null }) => {
  if (!isId(draftId)) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  const draft = await ManualEntryDraft.findById(draftId).session(session);
  if (!draft) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  if (draft.status === "posted") throw httpError(409, "ALREADY_POSTED", "القيد اترحّل بالفعل");
  const ledgerLines = await validateForPost(draft, session);
  await assertOpenDate(draft.date, { session });
  const number = await nextDocumentNumber(PREFIXES.JOURNAL, session);
  const entry = await postEntry({
    date: draft.date, type: "manual", source: { type: "manual", id: draft._id, number }, memo: draft.memo, number, lines: ledgerLines, session,
    createdBy: actor?._id || null, createdByName: actor?.name || null,
  });
  // A customer credit goes against that customer's open items. A credit and a debit never share a CUSTOMERS line (debits are refused).
  const creditByCustomer = new Map();
  for (const row of ledgerLines) {
    if (row.partyType === "customer" && row.credit > 0) creditByCustomer.set(String(row.partyId), roundMoney((creditByCustomer.get(String(row.partyId)) || 0) + row.credit));
  }
  const allocations = [];
  for (const [customerId, amount] of creditByCustomer) {
    allocations.push(...await allocateCustomerCredit({ customerId: new mongoose.Types.ObjectId(customerId), amount, draftId: draft._id, number, session }));
  }
  draft.lines = ledgerLines.map((row) => ({ accountId: row.accountId, description: row.description, debit: row.debit, credit: row.credit, partyType: row.partyType || null, partyId: row.partyId || null, partyName: row.partyName || null }));
  draft.status = "posted"; draft.number = number; draft.entryId = entry._id; draft.postedAt = new Date();
  draft.postedBy = actor?._id; draft.postedByName = actor?.name; draft.allocations = allocations;
  await draft.save({ session });
  return { draft, entry, allocations };
};

/** Reverses a posted manual entry (linked both ways), dated `date` (an open date, today by default). Run inside a transaction. */
const reverseDraft = async (draftId, { reason, date, session, actor = null }) => {
  if (!isId(draftId)) throw httpError(404, "DRAFT_NOT_FOUND", "القيد غير موجود");
  const draft = await ManualEntryDraft.findById(draftId).session(session);
  if (!draft || draft.status !== "posted") throw httpError(404, "DRAFT_NOT_FOUND", "القيد المرحّل غير موجود");
  if (draft.reversal) throw httpError(409, "ALREADY_REVERSED", "القيد اتعكس بالفعل");
  const reversalDate = date === undefined || date === null || date === "" ? today() : parseEntryDate(date, "تاريخ القيد العكسي");
  await assertOpenDate(reversalDate, { session });
  await undoCustomerAllocations(draft, session);
  const reversal = await reverseEntry(draft.entryId, { date: reversalDate, memo: reason, session });
  draft.reversal = { entryId: reversal._id, number: reversal.number, date: reversalDate, reason, at: new Date(), by: actor?._id, byName: actor?.name };
  await draft.save({ session });
  return { draft, reversal };
};

module.exports = {
  httpError, isId, BLOCK_MESSAGES, blockReasonOf, blockContext, accountOptions, parseEntryDate, parseDraftBody, validateForPost,
  allocateCustomerCredit, undoCustomerAllocations, postDraft, reverseDraft, today,
};
