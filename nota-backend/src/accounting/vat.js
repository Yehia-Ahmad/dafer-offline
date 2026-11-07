// Stage 21: VAT at the document level: the shop's settings, the vatPeriod rule, the VatEvent rows the monthly return reads,
// and the helpers the sale/return/purchase/expense controllers call INSIDE their transaction.
const ShopProfile = require("../models/shopProfile.model");
const VatEvent = require("../models/vatEvent.model");
const VatReturn = require("../models/vatReturn.model");
const Meta = require("../models/meta.model");
const Account = require("../models/account.model");
const JournalEntry = require("../models/journalEntry.model");
const { businessDay, localDayAsUtc, now } = require("../utils/clock");
const { computeSaleVat, resolvePeriod, monthOf, round2 } = require("../utils/vat");

const loadVatSettings = async (session) => {
  const profile = await ShopProfile.findOne({ key: "default" }).select("vat").session(session || null).lean();
  const vat = profile?.vat || {};
  return { enabled: Boolean(vat.enabled), rate: vat.rate ?? 14, pricesIncludeVat: vat.pricesIncludeVat !== false, startDate: vat.startDate || null };
};

/** { rate, included } when a NEW document dated `date` is taxable (VAT on and the date is on/after the start date), else null. */
const vatContext = (settings, date) => {
  if (!settings.enabled || !settings.startDate) return null;
  if (businessDay(date) < businessDay(settings.startDate)) return null;
  return { rate: settings.rate, included: settings.pricesIncludeVat };
};

/** The latest filed period ("YYYY-MM"), or null. Returns are filed in month order with no gaps, so it is the cut-off. */
const lastFiledPeriod = async (session) => {
  const row = await VatReturn.findOne({ status: "filed" }).sort({ period: -1 }).select("period").session(session || null).lean();
  return row ? row.period : null;
};

/** vatPeriod of a business date: its month, or the first unfiled month after it when that month is already filed. */
const periodFor = async (date, session) => resolvePeriod(businessDay(date), await lastFiledPeriod(session));

const today = () => localDayAsUtc(now());

/**
 * What the shop owes for VAT right now, from the ledger: the VAT_PAYABLE balance (owed) less the VAT_INPUT balance (recoverable),
 * never below 0. Filing only moves an equal amount between the two, and paying lowers VAT_PAYABLE, so it is what would be due
 * if every month were filed today.
 */
const vatPosition = async (session) => {
  const accounts = await Account.find({ systemKey: { $in: ["VAT_PAYABLE", "VAT_INPUT"] } }).select("_id systemKey").session(session || null).lean();
  if (accounts.length === 0) return { payable: 0, input: 0, due: 0 };
  const rows = await JournalEntry.aggregate([
    { $match: { status: "posted", "lines.accountId": { $in: accounts.map((account) => account._id) } } },
    { $unwind: "$lines" },
    { $match: { "lines.accountId": { $in: accounts.map((account) => account._id) } } },
    { $group: { _id: "$lines.accountId", balance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } } } },
  ]).session(session || null);
  const balanceOf = (key) => { const account = accounts.find((row) => row.systemKey === key); const row = account && rows.find((entry) => String(entry._id) === String(account._id)); return row ? row.balance : 0; };
  const payable = round2(-balanceOf("VAT_PAYABLE")); const input = round2(balanceOf("VAT_INPUT"));
  return { payable, input, due: Math.max(0, round2(payable - input)) };
};

/**
 * Every VAT write (an event, a filing, an unfiling) touches this one document, so a sale that is saved while a month is being
 * filed conflicts with the filing and retries: a late document can never slip into a month whose return was just filed.
 */
const touchVatLock = (session) => Meta.collection.updateOne({ _id: "vatLock" }, { $inc: { seq: 1 } }, { upsert: true, session });

const recordVatEvent = async ({ kind, direction, sourceType, sourceId, number, date, net, vat, session }) => {
  await touchVatLock(session);
  const when = businessDay(date);
  const period = await periodFor(when, session);
  await VatEvent.create([{ kind, direction, sourceType, sourceId, number, date: when, period, net: round2(net), vat: round2(vat) }], { session });
  return period;
};

/**
 * A NEW invoice (cash or credit). Mutates `persistedItems` (vatExempt, vatAmount per line) and returns the fields to store on
 * the invoice, or null when VAT does not apply (then nothing about the document changes).
 */
const priceNewInvoice = async ({ persistedItems, productsById, invoiceTotals, businessDate, session }) => {
  const context = vatContext(await loadVatSettings(session), businessDate);
  if (!context) return null;
  for (const item of persistedItems) item.vatExempt = Boolean(productsById.get(String(item.product))?.vatExempt);
  const computed = computeSaleVat({ items: persistedItems, discountAmount: invoiceTotals.discountAmount, shippingFees: invoiceTotals.shippingFees, rate: context.rate, included: context.included });
  persistedItems.forEach((item, index) => { item.vatAmount = computed.itemVat[index]; });
  return { computed, fields: invoiceVatFields(computed, await periodFor(businessDate, session)) };
};

const invoiceVatFields = (computed, vatPeriod) => ({
  vatRate: computed.vatRate, vatIncluded: computed.vatIncluded, vatAmount: computed.vatAmount, shippingVat: computed.shippingVat,
  netAmount: computed.netAmount, taxableAmount: computed.taxableAmount, exemptAmount: computed.exemptAmount,
  vatBreakdown: computed.breakdown, vatReturnedAmount: 0, ...(vatPeriod ? { vatPeriod } : {}),
});

/**
 * An EDITED invoice that already has VAT: it keeps the rate and mode it was saved with (a later rate change or turning VAT
 * off never touches it). Exemption flags of lines that were already on the invoice are kept. Returns null for a VAT-free invoice.
 */
const repriceEditedInvoice = ({ invoice, persistedItems, productsById, invoiceTotals }) => {
  if (invoice.vatRate === undefined || invoice.vatRate === null) return null;
  const oldFlags = new Map((invoice.items || []).map((item) => [String(item.product?._id || item.product), Boolean(item.vatExempt)]));
  for (const item of persistedItems) {
    const key = String(item.product);
    item.vatExempt = oldFlags.has(key) ? oldFlags.get(key) : Boolean(productsById.get(key)?.vatExempt);
  }
  const computed = computeSaleVat({ items: persistedItems, discountAmount: invoiceTotals.discountAmount, shippingFees: invoiceTotals.shippingFees, rate: invoice.vatRate, included: invoice.vatIncluded !== false });
  persistedItems.forEach((item, index) => { item.vatAmount = computed.itemVat[index]; });
  return { computed, fields: { ...invoiceVatFields(computed, null), vatReturnedAmount: invoice.vatReturnedAmount || 0 } };
};

module.exports = {
  loadVatSettings, vatContext, lastFiledPeriod, periodFor, today, touchVatLock, vatPosition, recordVatEvent, priceNewInvoice, repriceEditedInvoice, invoiceVatFields, monthOf,
};
