// Stage 21: the VAT parts of the cash and credit invoice prints (kept minimal; the full print redesign is Stage 23).
// An invoice with VAT is a "فاتورة ضريبية": the title says so, the shop's tax number is already in the header, the customer's tax
// number shows when present, exempt lines are marked "معفى", and the totals show net / VAT / total.

export interface InvoiceVatInfo {
  rate: number;
  included: boolean;
  vatAmount: number;
  netAmount: number;
}

export type PrintLanguage = 'ar' | 'en';

/** The VAT block of an invoice as the API returns it (vatRate, vatIncluded, vatAmount, netAmount), or undefined for a VAT-free invoice. */
export function toInvoiceVat(source: any): InvoiceVatInfo | undefined {
  if (!source || source.vatRate === undefined || source.vatRate === null) return undefined;
  const vatAmount = Number(source.vatAmount ?? 0);
  const total = Number(source.totalPrice ?? 0);
  const netAmount = source.netAmount !== undefined && source.netAmount !== null ? Number(source.netAmount) : total - vatAmount;
  return { rate: Number(source.vatRate), included: source.vatIncluded !== false, vatAmount, netAmount };
}

const LABELS = {
  ar: { taxInvoice: 'فاتورة ضريبية', net: 'الصافي', vat: 'ضريبة القيمة المضافة', exempt: 'معفى', customerTaxNumber: 'الرقم الضريبي للعميل' },
  en: { taxInvoice: 'Tax invoice', net: 'Net', vat: 'VAT', exempt: 'Exempt', customerTaxNumber: 'Customer tax number' },
} as const;

export const vatPrintLabels = (language: PrintLanguage) => LABELS[language];

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The document title: "فاتورة ضريبية INV-000012" for an invoice with VAT, the plain title otherwise. */
export function taxInvoiceTitle(plainTitle: string, vat: InvoiceVatInfo | undefined, language: PrintLanguage): string {
  return vat ? `${vatPrintLabels(language).taxInvoice} · ${plainTitle}` : plainTitle;
}

/** A visible "فاتورة ضريبية" line above the invoice details (empty without VAT). */
export function taxInvoiceBanner(vat: InvoiceVatInfo | undefined, language: PrintLanguage): string {
  return vat ? `<p class="tax-invoice-title" data-vat-title>${escape(vatPrintLabels(language).taxInvoice)}</p>` : '';
}

/** Net and VAT rows for the totals box (empty without VAT). `format` is the print's own number formatter. */
export function vatTotalsHtml(vat: InvoiceVatInfo | undefined, language: PrintLanguage, format: (value: number | null) => string): string {
  if (!vat) return '';
  const labels = vatPrintLabels(language);
  const rate = Number.isInteger(vat.rate) ? String(vat.rate) : vat.rate.toFixed(2);
  return `<div data-vat-net><span>${labels.net}</span><strong>${format(vat.netAmount)}</strong></div>
            <div data-vat-amount><span>${labels.vat} ${rate}${language === 'ar' ? '٪' : '%'}</span><strong>${format(vat.vatAmount)}</strong></div>`;
}

/** " (معفى)" after a product name for an exempt line (empty otherwise). */
export function exemptMark(isExempt: boolean | undefined, vat: InvoiceVatInfo | undefined, language: PrintLanguage): string {
  return vat && isExempt ? ` <small class="vat-exempt">(${vatPrintLabels(language).exempt})</small>` : '';
}

/** The customer card row with the customer's tax number, only when there is one. */
export function customerTaxRow(taxNumber: string | null | undefined, language: PrintLanguage): string {
  const value = String(taxNumber ?? '').trim();
  if (!value) return '';
  return `<div class="info-label">${vatPrintLabels(language).customerTaxNumber}</div><div class="info-value" dir="ltr">${escape(value)}</div>`;
}

/** Print CSS for the VAT bits (appended to a print's own styles). */
export const VAT_PRINT_CSS = `
      .tax-invoice-title { margin: 0 0 8px; font-size: 18px; font-weight: 800; text-align: center; letter-spacing: 0.02em; }
      .vat-exempt { font-weight: 600; opacity: 0.75; }
`;
