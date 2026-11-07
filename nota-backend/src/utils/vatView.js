// Stage 21: how the VAT fields stored on an invoice appear in API responses. Nothing is added for an invoice saved with VAT
// off, so those responses stay exactly as they were.
const { roundMoney } = require("./invoicePricing");

const INVOICE_KEYS = ["vatRate", "vatIncluded", "vatAmount", "shippingVat", "netAmount", "taxableAmount", "exemptAmount", "vatPeriod", "vatReturnedAmount", "cancelVatPeriod"];

const hasVat = (doc) => doc && doc.vatRate !== undefined && doc.vatRate !== null;

const vatInvoiceView = (doc) => {
  if (!hasVat(doc)) return {};
  const view = Object.fromEntries(INVOICE_KEYS.filter((key) => doc[key] !== undefined && doc[key] !== null).map((key) => [key, doc[key]]));
  if (doc.vatBreakdown) view.vatBreakdown = { salesNet: doc.vatBreakdown.salesNet, discountNet: doc.vatBreakdown.discountNet, shippingNet: doc.vatBreakdown.shippingNet };
  return view;
};

const vatItemView = (item) => (item && item.vatExempt !== undefined && item.vatExempt !== null ? { vatExempt: Boolean(item.vatExempt), vatAmount: item.vatAmount ?? 0 } : {});

/**
 * Profit of an invoice with VAT, net of VAT: net sales (before the discount) - net discount - cost. Shipping is not profit,
 * as before. null for an invoice without VAT (the caller keeps its gross formula).
 */
const netInvoiceProfit = (doc, items) => {
  if (!hasVat(doc) || !doc.vatBreakdown) return null;
  const cost = (items || []).reduce((sum, item) => sum + Number(item.purchasePrice || 0) * Number(item.productQuantity ?? item.quantity ?? 0), 0);
  return roundMoney(Number(doc.vatBreakdown.salesNet || 0) - Number(doc.vatBreakdown.discountNet || 0) - cost);
};

module.exports = { hasVat, vatInvoiceView, vatItemView, netInvoiceProfit };
