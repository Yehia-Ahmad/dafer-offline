// Stage 21: the VAT fields stored on documents. None has a default, so a document saved with VAT off has none of them
// (API responses stay exactly as before). Every amount is computed once at save time and read back from here.
const mongoose = require("mongoose");

const breakdown = { type: new mongoose.Schema({ salesNet: Number, discountNet: Number, shippingNet: Number }, { _id: false }), default: undefined };

/** Invoice level (Selling and CreditSale). */
const vatInvoiceFields = () => ({
  vatRate: { type: Number, min: 0, max: 100 },
  vatIncluded: { type: Boolean },
  vatAmount: { type: Number, min: 0 },
  shippingVat: { type: Number, min: 0 },
  netAmount: { type: Number },
  taxableAmount: { type: Number },
  exemptAmount: { type: Number },
  vatPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
  // The per-account net split posted on the sale entry (Cr SALES is the remainder).
  vatBreakdown: breakdown,
  // Σ VAT already returned by return logs (the final return takes vatAmount - this).
  vatReturnedAmount: { type: Number, min: 0 },
  // The vatPeriod a cancel landed in (its own period, never the original month).
  cancelVatPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
});

/** Invoice line level: the exemption snapshot and the VAT share allocated to the line (profit report). */
const vatItemFields = () => ({
  vatExempt: { type: Boolean },
  vatAmount: { type: Number, min: 0 },
});

/** ReturnLog level. */
const vatReturnLogFields = () => ({
  vatAmount: { type: Number, min: 0 },
  vatPeriod: { type: String, match: /^\d{4}-\d{2}$/ },
  vatBreakdown: { type: new mongoose.Schema({ discountNet: Number, shippingNet: Number }, { _id: false }), default: undefined },
});

module.exports = { vatInvoiceFields, vatItemFields, vatReturnLogFields };
