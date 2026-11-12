// Stage 21: the VAT of an invoice as the API returns it, and the VAT words. Stage 23: the printed documents (core/print) use these:
// an invoice with VAT is a "فاتورة ضريبية" with the shop's and the customer's tax numbers, net / VAT / total rows and "معفى" marks.

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

