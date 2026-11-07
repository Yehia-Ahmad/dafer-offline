import { buildCreditInvoiceDocument, CreditInvoicePrintData } from '../../customer/components/customer-details/credit-invoice-print.util';
import { buildInvoiceDocument, InvoiceHistoryRow } from '../../products/components/invoice-history/invoice-history-print.util';
import { toCreditInvoicePrintData, toCreditSaleView } from '../../customer/utils/credit-sale-view.util';
import { InvoiceVatInfo, taxInvoiceTitle, toInvoiceVat, vatTotalsHtml } from './vat-print';

const BRANDING = {
  shop: { name: 'النور', address: '', phones: [], logo: null, taxNumber: '123-456-789', commercialRegister: '', invoiceFooter: '' },
  texts: { neutralTitle: 'فاتورة', systemNote: 'Nota', taxNumberLabel: 'الرقم الضريبي', commercialRegisterLabel: 'السجل التجاري' },
} as never;
const FONTS = { arabic: 'a.woff2', latin: 'l.woff2' };
const VAT: InvoiceVatInfo = { rate: 14, included: true, vatAmount: 30.7, netAmount: 219.3 };

const cashRow = (extra: Partial<InvoiceHistoryRow> = {}): InvoiceHistoryRow => ({
  id: 'i1', invoiceId: 'i1', invoiceNumber: 'INV-000012', customerName: 'سامي', customerPhone: '010', sellingDate: '2026-11-05T10:00:00Z', itemCount: 2, totalQuantity: 6,
  subtotal: 270, discountAmount: 20, discountPercentage: 7.41, shippingFees: null, totalPrice: 250,
  items: [
    { id: 'a', invoiceId: 'i1', productId: 'p1', productCode: 'A35', productName: 'لمبة', categoryName: 'لمبات', customerName: '', customerPhone: '', sellingDate: null, quantity: 4, unitPrice: 35, totalPrice: 140 },
    { id: 'b', invoiceId: 'i1', productId: 'p2', productCode: 'EXM', productName: 'كتاب', categoryName: 'كتب', customerName: '', customerPhone: '', sellingDate: null, quantity: 2, unitPrice: 65, totalPrice: 130, vatExempt: true },
  ],
  ...extra,
});

/** Stage 21: the cash and credit invoice PDFs carry the VAT parts only when the invoice has VAT. */
describe('invoice prints with VAT (Stage 21)', () => {
  it('toInvoiceVat reads the stored fields, and is undefined for an invoice saved with VAT off', () => {
    expect(toInvoiceVat({ vatRate: 14, vatIncluded: true, vatAmount: 30.7, netAmount: 219.3, totalPrice: 250 })).toEqual(VAT);
    expect(toInvoiceVat({ vatRate: 14, vatIncluded: false, vatAmount: 35, totalPrice: 285 })).toEqual({ rate: 14, included: false, vatAmount: 35, netAmount: 250 });
    expect(toInvoiceVat({ totalPrice: 100 })).toBeUndefined();
    expect(toInvoiceVat(null)).toBeUndefined();
  });

  it('cash invoice with VAT: "فاتورة ضريبية" in the title and on the page, the shop tax number, net / VAT / total rows, the exempt line marked', () => {
    const html = buildInvoiceDocument({ selling: cashRow({ vat: VAT }), language: 'ar', branding: BRANDING, fontUrls: FONTS });
    expect(html).toContain('<title>فاتورة ضريبية · فاتورة INV-000012</title>');
    expect(html).toContain('data-vat-title');
    expect(html).toContain('123-456-789');
    expect(html).toContain('data-vat-net');
    expect(html).toContain('data-vat-amount');
    expect(html).toContain('ضريبة القيمة المضافة 14٪');
    expect(html).toContain('(معفى)');
    // the exempt mark is only on the exempt line
    expect(html.match(/\(معفى\)/g)?.length).toBe(1);
  });

  it('cash invoice without VAT: exactly the old document (no tax title, no rows, no exempt mark)', () => {
    const html = buildInvoiceDocument({ selling: cashRow(), language: 'ar', branding: BRANDING, fontUrls: FONTS });
    expect(html).toContain('<title>فاتورة INV-000012</title>');
    expect(html).not.toContain('data-vat-title');
    expect(html).not.toContain('data-vat-net');
    expect(html).not.toContain('(معفى)');
  });

  it('english cash invoice with VAT', () => {
    const html = buildInvoiceDocument({ selling: cashRow({ vat: { ...VAT, rate: 14.5 } }), language: 'en', branding: BRANDING, fontUrls: FONTS });
    expect(html).toContain('Tax invoice');
    expect(html).toContain('VAT 14.50%');
    expect(html).toContain('(Exempt)');
  });

  it('credit invoice with VAT: the title, the customer tax number, the rows and the exempt mark', () => {
    const view = toCreditSaleView({
      _id: 'c1', number: 'CR-000003', customerId: 'cu1', customerName: 'شركة النيل', customerPhone: '011', sellingDate: '2026-11-05T00:00:00Z', status: 'pending',
      totalPrice: 250, paidAmount: 0, remainingAmount: 250, discountAmount: 20, shippingFees: 0, totalQuantity: 6, itemCount: 2,
      vatRate: 14, vatIncluded: true, vatAmount: 30.7, netAmount: 219.3,
      items: [
        { _id: 'x', productId: 'p1', productName: 'لمبة', productCode: 'A35', categoryName: 'لمبات', productQuantity: 4, productPricePerEach: 35, totalPrice: 140 },
        { _id: 'y', productId: 'p2', productName: 'كتاب', productCode: 'EXM', categoryName: 'كتب', productQuantity: 2, productPricePerEach: 65, totalPrice: 130, vatExempt: true },
      ],
    })!;
    expect(view.vat).toEqual(VAT);
    const data: CreditInvoicePrintData = toCreditInvoicePrintData(view, 'شركة النيل', '011', 'غير مسدد', '555-111');
    const html = buildCreditInvoiceDocument({ invoice: data, language: 'ar', branding: BRANDING, fontUrls: FONTS });
    expect(html).toContain('فاتورة ضريبية');
    expect(html).toContain('الرقم الضريبي للعميل');
    expect(html).toContain('555-111');
    expect(html).toContain('data-vat-net');
    expect(html).toContain('(معفى)');
  });

  it('credit invoice without VAT or a customer tax number: nothing extra', () => {
    const view = toCreditSaleView({ _id: 'c2', number: 'CR-000004', customerName: 'عميل', status: 'pending', totalPrice: 100, paidAmount: 0, remainingAmount: 100, totalQuantity: 1, itemCount: 1,
      items: [{ _id: 'x', productName: 'لمبة', productCode: 'A', categoryName: 'ل', productQuantity: 1, productPricePerEach: 100, totalPrice: 100 }] })!;
    expect(view.vat).toBeUndefined();
    const html = buildCreditInvoiceDocument({ invoice: toCreditInvoicePrintData(view, 'عميل', '010', 'x'), language: 'ar', branding: BRANDING, fontUrls: FONTS });
    expect(html).not.toContain('data-vat-title');
    expect(html).not.toContain('الرقم الضريبي للعميل');
  });

  it('helpers: the title and the rows are empty without VAT; the rate prints without trailing zeros', () => {
    expect(taxInvoiceTitle('فاتورة 1', undefined, 'ar')).toBe('فاتورة 1');
    expect(vatTotalsHtml(undefined, 'ar', (value) => String(value))).toBe('');
    expect(vatTotalsHtml(VAT, 'en', (value) => String(value))).toContain('VAT 14%');
  });
});
