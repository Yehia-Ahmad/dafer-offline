// Stage 23: every printed document, from fixture data: the key text, VAT rows only with VAT, the "نسخة" mark, the "ملغي"
// watermark, cost columns hidden without products.viewCost, RTL/LTR direction, money and number formatting.

import { toInvoiceVat } from '../../modules/shared/vat/vat-print';
import { barcodeSvg, code128Bits } from './barcode';
import { cashInvoice, creditInvoice, purchaseInvoice, receiptVoucher, voucher } from './documents/invoices';
import { cashReceipt, paymentReceipt, returnReceipt, shiftClose } from './documents/receipts';
import { boxMovements, financials, journalEntry, partyBalances, profitReport, recoveryCodeSheet, trialBalance, vatReturn } from './documents/reports';
import { customerStatement, stockList, supplierStatement } from './documents/statements';
import { documentTestPage, receiptTestPage } from './documents/test-page';
import { InvoiceHistoryRow, sellingResponseToCashSaleData, toCashSaleData, toCreditInvoiceData } from './print-adapters';
import { measureRollHeightMm } from './print-render';
import { amountInWords, cssString, formatDate, formatDateTime, formatMoney, formatPercent, formatQty, formatTime, localizeDigits } from './print-format';
import { PrintContext, PrintDocument, buildPrintHtml, toShopInfo } from './print-kit';

const SHOP = { name: 'النور للأدوات الكهربائية', address: 'المنصورة', phones: ['01002223344'], logo: '', taxNumber: '123-456-789', commercialRegister: '45678', invoiceFooter: 'البضاعة المباعة لا ترد' };
const ctxOf = (lang: 'ar' | 'en' = 'ar', extra: Partial<PrintContext> = {}): PrintContext => ({ lang, shop: SHOP, printedBy: 'محمود', printedAt: new Date(2026, 10, 5, 12, 40), fontCss: '', copy: null, ...extra });
const html = (doc: PrintDocument, ctx: PrintContext = ctxOf()): string => buildPrintHtml(ctx, doc, 150);

const VAT = { rate: 14, included: true, vatAmount: 30.7, netAmount: 219.3 };
const sale = {
  number: 'INV-000125', date: new Date(2026, 10, 5, 12, 40), cashier: 'محمود', customerName: 'زبون نقدي',
  items: [{ code: 'LED-9', name: 'لمبة LED ٩ وات', quantity: 4, unitPrice: 35, total: 140 }, { code: 'CH', name: 'كابل', quantity: 2, unitPrice: 55, total: 110, vatExempt: true }],
  subtotal: 270, discount: 20, shipping: 0, total: 250,
};

describe('print formatting', () => {
  it('money has two decimals and thousands separators; Arabic uses Arabic-Indic digits and separators, English Latin ones', () => {
    expect(formatMoney(1234.5, 'ar')).toBe('١٬٢٣٤٫٥٠');
    expect(formatMoney(1234.5, 'en')).toBe('1,234.50');
    expect(formatMoney(0, 'ar')).toBe('٠٫٠٠');
    expect(formatMoney(1234567.891, 'en')).toBe('1,234,567.89');
    expect(formatMoney(-50, 'en')).toBe('-50.00');
    expect(formatMoney(-50, 'ar')).toBe('−٥٠٫٠٠');
    expect(formatMoney(null, 'en')).toBe('0.00');
  });

  it('quantities, percentages and digits', () => {
    expect(formatQty(4, 'ar')).toBe('٤');
    expect(formatQty(1.5, 'en')).toBe('1.5');
    expect(formatPercent(30.8, 'ar')).toBe('٣٠٫٨٪');
    expect(formatPercent(14, 'en')).toBe('14.0%');
    expect(localizeDigits('INV-000125', 'ar')).toBe('INV-٠٠٠١٢٥');
    expect(localizeDigits('INV-000125', 'en')).toBe('INV-000125');
  });

  it('dates are the LOCAL day: "٥ / ١١ / ٢٠٢٦", a date-only string is not shifted by the timezone, time uses a 12-hour clock', () => {
    expect(formatDate(new Date(2026, 10, 5, 23, 59), 'ar')).toBe('٥ / ١١ / ٢٠٢٦');
    expect(formatDate('2026-11-05', 'ar')).toBe('٥ / ١١ / ٢٠٢٦');
    expect(formatDate('2026-11-05', 'en')).toBe('5 / 11 / 2026');
    expect(formatTime(new Date(2026, 10, 5, 12, 40), 'ar')).toBe('١٢:٤٠ م');
    expect(formatTime(new Date(2026, 10, 5, 0, 5), 'en')).toBe('12:05 AM');
    expect(formatDateTime(new Date(2026, 10, 5, 9, 0), 'ar')).toBe('٥ / ١١ / ٢٠٢٦ · ٩:٠٠ ص');
    expect(formatDate(null, 'ar')).toBe('');
  });

  it('the amount in words (the design\'s own examples, piasters, English)', () => {
    expect(amountInWords(650, 'ar')).toBe('ستمائة وخمسون جنيهًا مصريًا فقط لا غير');
    expect(amountInWords(590, 'ar')).toBe('خمسمائة وتسعون جنيهًا مصريًا فقط لا غير');
    expect(amountInWords(300, 'ar')).toBe('ثلاثمائة جنيهًا مصريًا فقط لا غير');
    expect(amountInWords(2500, 'ar')).toBe('ألفان وخمسمائة جنيهًا مصريًا فقط لا غير');
    expect(amountInWords(1, 'ar')).toBe('جنيه مصري واحد فقط لا غير');
    expect(amountInWords(2, 'ar')).toBe('جنيهان مصريان فقط لا غير');
    expect(amountInWords(5, 'ar')).toBe('خمسة جنيهات مصرية فقط لا غير');
    expect(amountInWords(12.5, 'ar')).toBe('اثنا عشر جنيهًا مصريًا وخمسون قرشًا فقط لا غير');
    expect(amountInWords(0.75, 'ar')).toBe('خمسة وسبعون قرشًا فقط لا غير');
    expect(amountInWords(1250000, 'ar')).toBe('مليون ومائتان وخمسون ألفًا جنيهًا مصريًا فقط لا غير');
    expect(amountInWords(650, 'en')).toBe('Six hundred fifty Egyptian pounds only');
    expect(amountInWords(12.5, 'en')).toBe('Twelve Egyptian pounds and fifty piasters only');
  });
});

describe('barcode', () => {
  it('is a real Code 128 of the document number, as an SVG', () => {
    const bits = code128Bits('INV-000125');
    expect(bits.length).toBeGreaterThan(80);
    expect(bits.startsWith('11010010000') || bits.startsWith('11010000100') || bits.startsWith('11010011100')).toBeTrue(); // start code A/B/C
    expect(bits.endsWith('1100011101011')).toBeTrue(); // stop pattern
    const svg = barcodeSvg('INV-000125');
    expect(svg).toContain('<svg');
    expect(svg).toContain('data-barcode="INV-000125"');
    expect(svg).toContain('<path');
    expect(barcodeSvg('')).toBe('');
  });
});

describe('the page', () => {
  it('has the right paper, direction, light palette and no network', () => {
    const a4 = html(cashInvoice(ctxOf(), sale));
    expect(a4).toContain('@page { size: A4;');
    expect(a4).toContain('<html lang="ar" dir="rtl">');
    expect(a4).toContain('--p-brand: #0E4D45');
    expect(a4).toContain("Content-Security-Policy");
    expect(a4).not.toMatch(/fonts\.googleapis|https?:\/\//);
    expect(a4).toContain('color-scheme: light');
    const a5 = html(receiptVoucher(ctxOf(), { number: 'RC-000041', date: new Date(), customerName: 'س', invoiceNumbers: [], amount: 100 }));
    expect(a5).toContain('@page { size: A5;');
    expect(html(cashReceipt(ctxOf(), sale))).toContain('@page { size: 80mm 150mm; margin: 0; }');
    const en = html(cashInvoice(ctxOf('en'), sale), ctxOf('en'));
    expect(en).toContain('<html lang="en" dir="ltr">');
  });

  it('A4 pages carry the page-number box in the page margin (Arabic-Indic counters in Arabic) and repeat table headers', () => {
    const ar = html(customerStatement(ctxOf(), { customer: { name: 'س' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 }, aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 } }));
    expect(ar).toMatch(/@bottom-left \{ content: "صفحة " counter\(page, arabic-indic\) " من " counter\(pages, arabic-indic\)/);
    expect(ar).toContain('.t thead { display: table-header-group; }');
    expect(ar).toContain('.t tr { break-inside: avoid;');
    expect(ar).toContain('طُبع بواسطة محمود');
    const en = html(customerStatement(ctxOf('en'), { customer: { name: 'S' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 }, aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 } }), ctxOf('en'));
    expect(en).toMatch(/@bottom-right \{ content: "Page " counter\(page, decimal\) " of " counter\(pages, decimal\)/);
  });

  it('the shop profile is mapped to the header data (a nameless profile gives no shop)', () => {
    expect(toShopInfo(null)).toBeNull();
    expect(toShopInfo({ name: ' ', address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '' })).toBeNull();
    expect(toShopInfo({ name: 'م', address: 'ع', phones: ['1', ''], logo: 'AAAA', taxNumber: ' 5 ', commercialRegister: '', invoiceFooter: 'ش' })).toEqual({ name: 'م', address: 'ع', phones: ['1'], logo: 'data:image/png;base64,AAAA', taxNumber: '5', commercialRegister: '', invoiceFooter: 'ش' });
  });
});

describe('PrCashReceipt / PrCashInvoice', () => {
  it('80mm cash receipt: title, number, items, totals, barcode, the shop footer and "printed by"; no paid/change rows when not captured', () => {
    const out = html(cashReceipt(ctxOf(), sale));
    expect(out).toContain('فاتورة بيع نقدي');
    expect(out).toContain('INV-000125');
    expect(out).toContain('لمبة LED ٩ وات');
    expect(out).toContain('٢٧٠٫٠٠'); // subtotal
    expect(out).toContain('− ٢٠٫٠٠'); // discount
    expect(out).toContain('٢٥٠٫٠٠ ج.م'); // total
    expect(out).toContain('data-barcode="INV-000125"');
    expect(out).toContain('البضاعة المباعة لا ترد');
    expect(out).toContain('طُبع بواسطة محمود');
    expect(out).not.toContain('data-paid');
    expect(out).not.toContain('data-change');
    expect(out).not.toContain('data-vat-net');
    expect(out).not.toContain('data-copy-mark');
    expect(out).not.toContain('data-cancelled-watermark');
  });

  it('shows paid and change only when the sale captured them', () => {
    const out = html(cashReceipt(ctxOf(), { ...sale, paid: 300, change: 50 }));
    expect(out).toContain('data-paid');
    expect(out).toContain('٣٠٠٫٠٠');
    expect(out).toContain('data-change');
    expect(out).toContain('٥٠٫٠٠');
  });

  it('with VAT the title is "فاتورة ضريبية" with net / VAT rows, exempt marks and the customer tax number; with VAT off there are none', () => {
    const on = html(cashReceipt(ctxOf(), { ...sale, vat: VAT, customerTaxNumber: '987-654-321' }));
    expect(on).toContain('فاتورة ضريبية');
    expect(on).not.toContain('فاتورة بيع نقدي');
    expect(on).toContain('data-vat-net');
    expect(on).toContain('data-vat-amount');
    expect(on).toContain('٢١٩٫٣٠');
    expect(on).toContain('٣٠٫٧٠');
    expect(on).toContain('١٤٫٠٪');
    expect(on).toContain('(معفى)');
    expect(on).toContain('987-654-321');
    expect(on).toContain('123-456-789'); // the shop's tax number
    const off = html(cashReceipt(ctxOf(), sale));
    expect(off).not.toContain('فاتورة ضريبية');
    expect(off).not.toContain('(معفى)');
    const a4 = html(cashInvoice(ctxOf(), { ...sale, vat: VAT, customerTaxNumber: '987-654-321' }));
    expect(a4).toContain('فاتورة ضريبية');
    expect(a4).toContain('data-vat-net');
    expect(a4).toContain('الإجمالي شامل الضريبة');
    expect(html(cashInvoice(ctxOf(), sale))).not.toContain('data-vat-net');
  });

  it('a reprint carries "نسخة" with the reprint time, on the 80mm receipt and the A4 invoice; the first print does not', () => {
    const copy = { n: 1, at: new Date(2026, 10, 6, 9, 5) };
    const receipt = html(cashReceipt(ctxOf('ar', { copy }), sale), ctxOf('ar', { copy }));
    expect(receipt).toContain('data-copy-mark');
    expect(receipt).toContain('نسخة');
    expect(receipt).toContain('٦ / ١١ / ٢٠٢٦ ٩:٠٥ ص');
    const a4 = html(cashInvoice(ctxOf('ar', { copy: { n: 3, at: copy.at } }), sale), ctxOf('ar', { copy: { n: 3, at: copy.at } }));
    expect(a4).toContain('data-copy-mark');
    expect(a4).toContain('نسخة ٣');
    expect(html(cashInvoice(ctxOf(), sale))).not.toContain('data-copy-mark');
    expect(html(cashReceipt(ctxOf('en', { copy }), sale), ctxOf('en', { copy }))).toContain('COPY');
  });

  it('a cancelled invoice prints with the "ملغي" watermark and the cancel reason (80mm and A4)', () => {
    const cancelled = { ...sale, cancelled: { reason: 'خطأ في الكمية', by: 'سارة' } };
    for (const doc of [cashReceipt(ctxOf(), cancelled), cashInvoice(ctxOf(), cancelled)]) {
      const out = html(doc);
      expect(out).toContain('data-cancelled-watermark');
      expect(out).toContain('ملغي');
      expect(out).toContain('data-cancel-reason');
      expect(out).toContain('خطأ في الكمية');
    }
    expect(html(cashInvoice(ctxOf('en'), cancelled), ctxOf('en'))).toContain('CANCELLED');
  });

  it('A4 invoice: customer, items table, amount in words, totals, signatures and the shop footer', () => {
    const out = html(cashInvoice(ctxOf(), { ...sale, total: 650, subtotal: 620, shipping: 30, discount: 0 }));
    expect(out).toContain('فاتورة بيع نقدي');
    expect(out).toContain('زبون نقدي');
    expect(out).toContain('ستمائة وخمسون جنيهًا مصريًا فقط لا غير');
    expect(out).toContain('data-signatures');
    expect(out).toContain('البائع');
    expect(out).toContain('البضاعة المباعة لا ترد');
    expect(out).toContain('data-closing');
  });

  it('English: LTR, Latin digits, English labels', () => {
    const ctx = ctxOf('en');
    const english = { ...sale, customerName: 'Cash customer', cashier: 'Mahmoud', items: [{ code: 'LED-9', name: 'LED bulb 9W', quantity: 4, unitPrice: 35, total: 140 }] };
    const out = html(cashInvoice(ctx, english), ctx);
    expect(out).toContain('Cash sale invoice');
    expect(out).toContain('270.00');
    expect(out).toContain('Amount in words');
    expect(out).toContain('Two hundred fifty Egyptian pounds only');
    expect(out.split('</style>')[1]).not.toMatch(/[٠-٩]/);
  });
});

describe('the other 80mm receipts', () => {
  it('payment receipt: who, the invoices, amount in words, balance before and after', () => {
    const out = html(paymentReceipt(ctxOf(), { number: 'RC-000041', date: new Date(2026, 10, 5, 13, 15), cashier: 'محمود', customerName: 'م. سامي', customerPhone: '01001234567', invoiceNumbers: ['CR-000032'], amount: 300, paymentMethod: 'كاش', balanceBefore: 590, balanceAfter: 290, note: 'دفعة تانية' }));
    expect(out).toContain('سند قبض');
    expect(out).toContain('RC-000041');
    expect(out).toContain('CR-000032');
    expect(out).toContain('ثلاثمائة جنيهًا مصريًا فقط لا غير');
    expect(out).toContain('data-balance-before');
    expect(out).toContain('٥٩٠٫٠٠');
    expect(out).toContain('٢٩٠٫٠٠');
    expect(out).toContain('دفعة تانية');
    expect(html(paymentReceipt(ctxOf(), { number: 'RC-1', date: null, customerName: 'س', invoiceNumbers: [], amount: 1 }))).not.toContain('data-balance-before');
  });

  it('return receipt: items, reason, refund, settlement, customer balance for a credit return', () => {
    const out = html(returnReceipt(ctxOf(), { number: 'RT-000009', date: new Date(2026, 10, 5, 14, 5), invoiceNumber: 'CR-000032', invoiceKind: 'credit', customerName: 'س', items: [{ name: 'مشترك ٥ مخارج', quantity: 1, unitPrice: 150, total: 150, reason: 'عيب صناعة' }], total: 150, settlement: 'خصم من رصيد العميل', balanceBefore: 290, balanceAfter: 140, stockNote: 'رجع للمخزون' }));
    expect(out).toContain('إيصال مرتجع');
    expect(out).toContain('RT-000009');
    expect(out).toContain('(آجل)');
    expect(out).toContain('عيب صناعة');
    expect(out).toContain('١٥٠٫٠٠ ج.م');
    expect(out).toContain('خصم من رصيد العميل');
    expect(out).toContain('٢٩٠٫٠٠');
    expect(out).toContain('١٤٠٫٠٠');
  });

  it('shift close: movement lines, expected / counted / shortage, the deposit and what stays in the drawer', () => {
    const out = html(shiftClose(ctxOf(), { number: 'SH-000058', boxName: 'درج الكاشير ١', cashier: 'محمود', openedAt: new Date(2026, 10, 5, 9, 0), closedAt: new Date(2026, 10, 5, 17, 0), summary: [{ label: 'فواتير كاش', count: 31, amount: 6820 }], movement: [{ label: 'رصيد أول الوردية', amount: 500, sign: '' }, { label: 'مصروفات', amount: 250, sign: '−' }], expected: 7550, counted: 7500, difference: -50, differenceNote: 'فكّة ناقصة', deposit: { boxName: 'الخزنة الرئيسية', amount: 7000 }, remaining: 500 }));
    expect(out).toContain('تقرير إقفال وردية');
    expect(out).toContain('SH-000058');
    expect(out).toContain('٧٬٥٥٠٫٠٠');
    expect(out).toContain('٧٬٥٠٠٫٠٠');
    expect(out).toContain('عجز');
    expect(out).toContain('فكّة ناقصة');
    expect(out).toContain('data-deposit');
    expect(out).toContain('data-remaining');
    expect(out).toContain('توقيع الكاشير');
    expect(html(shiftClose(ctxOf(), { number: 'SH-1', boxName: 'ب', cashier: 'ك', openedAt: null, closedAt: null, summary: [], movement: [], expected: 10, counted: 10, difference: 0 }))).toContain('مطابق');
  });
});

describe('credit invoice, purchase invoice and vouchers', () => {
  const credit = { ...sale, number: 'CR-000032', customerName: 'م. سامي', dueDate: new Date(2026, 11, 5), paid: 200, remaining: 590, total: 790, subtotal: 790, discount: 0, payments: [{ label: 'مقدم مع الفاتورة', date: new Date(2026, 10, 5), amount: 200 }], balanceBefore: 0, balanceAfter: 590 };

  it('credit invoice: due date, balance before/after, payments, the debt acknowledgment and the customer signature with national ID', () => {
    const out = html(creditInvoice(ctxOf(), credit));
    expect(out).toContain('فاتورة بيع آجل');
    expect(out).toContain('ميعاد السداد');
    expect(out).toContain('٥ / ١٢ / ٢٠٢٦');
    expect(out).toContain('data-balance-after');
    expect(out).toContain('خمسمائة وتسعون جنيهًا مصريًا فقط لا غير');
    expect(out).toContain('data-acknowledgment');
    expect(out).toContain('أقر أنا الموقّع');
    expect(out).toContain('مقدم مع الفاتورة');
    expect(out).toContain('الرقم القومي');
    expect(out).toContain('data-remaining');
    expect(html(creditInvoice(ctxOf(), { ...credit, balanceBefore: null, balanceAfter: null }))).not.toContain('data-balance-after');
    expect(html(creditInvoice(ctxOf(), { ...credit, vat: VAT }))).toContain('فاتورة ضريبية');
    expect(html(creditInvoice(ctxOf(), { ...credit, cancelled: { reason: 'تكرار' } }))).toContain('data-cancelled-watermark');
  });

  it('purchase invoice: supplier, supplier balance before/after, the journal entry with its number, totals and three signatures', () => {
    const out = html(purchaseInvoice(ctxOf(), {
      number: 'PO-000012', date: new Date(2026, 10, 5), supplierInvoiceNo: 'EL-8841', supplier: { name: 'الشركة المصرية للإضاءة', phone: '01027784410' },
      items: [{ code: 'LED-12', name: 'لمبة LED ١٢ وات', quantity: 50, unitCost: 28, total: 1400 }], subtotal: 1400, discount: 0, otherCosts: 0, total: 1400, paid: 1000, paidBoxName: 'الخزنة الرئيسية', remaining: 400,
      balanceBefore: 4200, balanceAfter: 4600, journal: { number: 'JE-000410', lines: [{ name: 'المخزون', debit: 1400, credit: 0 }, { name: 'الخزنة الرئيسية', debit: 0, credit: 1000 }] },
    }));
    expect(out).toContain('فاتورة شراء');
    expect(out).toContain('EL-8841');
    expect(out).toContain('PO-000012');
    expect(out).toContain('data-balance-before');
    expect(out).toContain('٤٬٢٠٠٫٠٠');
    expect(out).toContain('data-journal-number');
    expect(out).toContain('JE-000410');
    expect(out).toContain('مندوب المورد');
    expect(out).toContain('data-remaining');
    expect(out).not.toContain('data-vat-net');
    const withVat = html(purchaseInvoice(ctxOf(), { number: 'PO-1', date: null, supplier: { name: 'م' }, items: [], subtotal: 100, discount: 0, otherCosts: 0, vat: { rate: 14, amount: 14, netAmount: 100 }, total: 114, paid: 0, remaining: 114 }));
    expect(withVat).toContain('data-vat-net');
    expect(withVat).toContain('data-vat-amount');
  });

  it('receipt voucher (A5): amount, who, words, reason, method, balance, signatures and the journal entry number', () => {
    const out = html(receiptVoucher(ctxOf(), { number: 'RC-000041', date: new Date(2026, 10, 5), cashier: 'محمود', customerName: 'م. سامي', invoiceNumbers: ['CR-000032'], amount: 300, paymentMethod: 'نقدي', balanceBefore: 590, balanceAfter: 290, journalNumber: 'JE-000415' }));
    expect(out).toContain('سند قبض');
    expect(out).toContain('data-amount');
    expect(out).toContain('٣٠٠٫٠٠ ج.م');
    expect(out).toContain('استلمنا من');
    expect(out).toContain('ثلاثمائة جنيهًا مصريًا فقط لا غير');
    expect(out).toContain('CR-000032');
    expect(out).toContain('data-balance');
    expect(out).toContain('الدافع');
    expect(out).toContain('JE-000415');
    expect(out).toContain('data-printed-by');
  });

  it('the payment voucher layout serves PV, EX, DR, CP, VP and SR with the title of each', () => {
    const titles: Array<[Parameters<typeof voucher>[1]['type'], string]> = [['PV', 'سند صرف'], ['EX', 'سند صرف مصروف'], ['DR', 'سند سحب مالك'], ['CP', 'سند صرف رصيد عميل'], ['VP', 'سند سداد ضريبة'], ['SR', 'سند قبض (استرداد من مورد)']];
    for (const [type, title] of titles) {
      const out = html(voucher(ctxOf(), { type, number: `${type}-000001`, date: new Date(), amount: 2500, party: 'طرف', reason: 'سبب', method: 'الخزنة' }));
      expect(out).toContain(title);
      expect(out).toContain(`data-voucher="${type}"`);
    }
    const pv = html(voucher(ctxOf(), { type: 'PV', number: 'PV-000017', date: new Date(), amount: 2500, party: 'الشركة', method: 'بنك مصر' }));
    expect(pv).toContain('صرفنا إلى');
    expect(pv).toContain('من خزنة');
    expect(pv).toContain('أمين الخزنة');
    expect(pv).toContain('ألفان وخمسمائة جنيهًا مصريًا فقط لا غير');
    expect(html(voucher(ctxOf(), { type: 'EX', number: 'EX-000001', date: new Date(), amount: 10, party: 'كهرباء', cancelled: { reason: 'غلط' } }))).toContain('data-cancelled-watermark');
    expect(html(voucher(ctxOf('en'), { type: 'PV', number: 'PV-000001', date: new Date(), amount: 10, party: 'S' }), ctxOf('en'))).toContain('Payment voucher');
  });
});

describe('statements, stock list and reports', () => {
  const lines = [
    { date: '2026-11-01', type: 'opening', description: 'رصيد أول الفترة', debit: 0, credit: 0, balance: 0 },
    { date: '2026-11-05', description: 'فاتورة بيع آجل', number: 'CR-000032', debit: 790, credit: 0, balance: 790 },
    { date: '2026-11-05', description: 'دفعة · نقدي', number: 'RC-000041', debit: 0, credit: 650, balance: 140 },
  ];
  const aging = { current: 140, days1to30: 0, days31to60: 0, over60: 0, total: 140 };

  it('customer statement: period, totals, aging, the acknowledgment text', () => {
    const out = html(customerStatement(ctxOf(), { customer: { name: 'م. سامي', phone: '01001234567', creditLimit: 10000 }, from: '2026-11-01', to: '2026-11-05', lines, totals: { openingBalance: 0, debit: 790, credit: 650, balance: 140 }, aging }));
    expect(out).toContain('كشف حساب عميل');
    expect(out).toContain('١ / ١١ / ٢٠٢٦ — ٥ / ١١ / ٢٠٢٦');
    expect(out).toContain('CR-000032');
    expect(out).toContain('data-aging');
    expect(out).toContain('لسه ما استحقش');
    expect(out).toContain('data-acknowledgment');
    expect(out).toContain('١٤٠٫٠٠ ج.م');
    expect(out).toContain('حد الآجل');
    expect(out).toContain('data-kpis');
  });

  it('supplier statement: totals and the legend', () => {
    const out = html(supplierStatement(ctxOf(), { supplier: { name: 'الشركة', contact: 'م. وائل', phone: '01027784410' }, lines, totals: { openingBalance: 0, debit: 650, credit: 790, balance: 140 } }));
    expect(out).toContain('كشف حساب مورد');
    expect(out).toContain('الرصيد المستحق له');
    expect(out).toContain('عن المورد');
    expect(out).toContain('م. وائل');
  });

  it('stock list: grouped by category, ★ for low stock, blank counted/difference columns, cost and value only with a cost', () => {
    const rows = [
      { code: 'A1', name: 'لمبة', categoryName: 'إضاءة', inventoryCount: 2, lowStock: true, purchasePrice: 30 },
      { code: 'A2', name: 'مصباح', categoryName: 'إضاءة', inventoryCount: 40, lowStock: false, purchasePrice: 35 },
      { code: 'C1', name: 'سلك', categoryName: 'أسلاك', inventoryCount: 7, lowStock: false, purchasePrice: 12 },
    ];
    const withCost = html(stockList(ctxOf(), { rows, categoryLabel: 'الكل' }));
    expect(withCost).toContain('كشف جرد المخزون');
    expect(withCost).toContain('data-low-stock');
    expect(withCost).toContain('سعر الشراء');
    expect(withCost).toContain('قيمة المخزون بسعر الشراء');
    expect(withCost).toContain('المعدود');
    expect(withCost).toContain('الفرق');
    expect(withCost).toContain('إجمالي إضاءة');
    expect(withCost).toContain('الإجمالي العام');
    expect(withCost).toContain('١٬٥٤٤٫٠٠'); // 2×30 + 40×35 + 7×12
  });

  it('stock list without products.viewCost shows no cost, value or stock value anywhere', () => {
    const rows = [{ code: 'A1', name: 'لمبة', categoryName: 'إضاءة', inventoryCount: 2, lowStock: true }];
    const out = html(stockList(ctxOf(), { rows, categoryLabel: 'إضاءة' }));
    expect(out).not.toContain('سعر الشراء');
    expect(out).not.toContain('القيمة');
    expect(out).not.toContain('قيمة المخزون');
    expect(out).toContain('المعدود');
    expect(out).toContain('إضاءة');
  });

  it('profit report, trial balance, financials, box movements, party balances, journal entry, VAT return and recovery code', () => {
    const profit = html(profitReport(ctxOf(), { periodLabel: 'آخر ٦ شهور', kpis: { sales: 1000, cost: 700, profit: 300, margin: 30 }, months: [{ label: 'يونيو', cashProfit: 100, creditProfit: 200, profit: 300 }], products: [{ name: 'لمبة', category: 'إضاءة', quantity: 5, sales: 1000, cost: 700, profit: 300, margin: 30 }] }));
    expect(profit).toContain('تقرير الأرباح');
    expect(profit).toContain('data-chart');
    expect(profit).toContain('٣٠٫٠٪');
    const trial = html(trialBalance(ctxOf(), { report: 'trial-balance', period: { from: '2026-10-01', to: '2026-10-31' }, shopName: '', currency: 'EGP', balanced: true, totals: { closingDebit: 100, closingCredit: 100 } as never, rows: [{ id: 'g', kind: 'group', code: '1', nameAr: 'الأصول', nameEn: 'Assets', isZero: false, children: [{ id: 'l', kind: 'line', code: '111', nameAr: 'الخزائن', nameEn: 'Cash', closingDebit: 100, closingCredit: 0, isZero: false }] }] as never }));
    expect(trial).toContain('ميزان المراجعة');
    expect(trial).toContain('الخزائن');
    expect(trial).toContain('data-total-debit');
    expect(trial).toContain('الميزان متوازن');
    const fin = html(financials(ctxOf(), { income: { report: 'income-statement', period: { from: '2026-10-01', to: '2026-10-31' }, rows: [{ id: 's', kind: 'line', nameAr: 'المبيعات', nameEn: 'Sales', sign: 1, amount: 100, isZero: false }, { id: 'n', kind: 'total', nameAr: 'صافي الربح', nameEn: 'Net profit', sign: 1, amount: 40, isZero: false }] } as never, balance: { report: 'balance-sheet', asOf: '2026-10-31', periodProfit: 0, sections: { assets: { id: 'a', kind: 'group', nameAr: 'الأصول', nameEn: 'Assets', children: [] }, liabilities: { id: 'l', kind: 'group', nameAr: 'الخصوم', nameEn: 'Liabilities', children: [] }, equity: { id: 'e', kind: 'group', nameAr: 'حقوق الملكية', nameEn: 'Equity', children: [] } }, totals: { assets: 10, liabilities: 4, equity: 6, liabilitiesAndEquity: 10 }, check: { assets: 10, liabilitiesAndEquity: 10, difference: 0 } } as never, trialBalanced: true }));
    expect(fin).toContain('القوائم المالية');
    expect(fin).toContain('data-statement="income"');
    expect(fin).toContain('data-statement="balance"');
    expect(fin).toContain('الميزانية متوازنة');
    expect(fin).toContain('المالك');
    expect(html(financials(ctxOf(), { income: null, balance: null }))).not.toContain('data-statement=');
    expect(html(boxMovements(ctxOf(), { report: 'box-movements', period: { from: '2026-10-01', to: '2026-10-31' }, boxes: [{ name: 'الخزنة الرئيسية', opening: 1, in: 2, out: 1, closing: 2 }] as never, totals: { opening: 1, in: 2, out: 1, closing: 2, byKind: [] } } as never))).toContain('الخزنة الرئيسية');
    expect(html(partyBalances(ctxOf(), { report: 'party-balances', asOf: '2026-11-05', customers: { rows: [{ name: 'س', balance: 5, isZero: false, aging: { current: 5, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 5 } }], totals: { count: 1, balance: 5, current: 5, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 } } } as never))).toContain('العملاء');
    const je = html(journalEntry(ctxOf(), { number: 'JE-000411', date: new Date(2026, 10, 5), typeLabel: 'تلقائي من فاتورة', sourceNumber: 'CR-000032', memo: 'بيع آجل', lines: [{ code: '1131', name: 'م. سامي', debit: 790, credit: 0 }, { code: '410', name: 'المبيعات', debit: 0, credit: 790 }], totalDebit: 790, totalCredit: 790, related: ['عكس للقيد JE-000300'], preparedBy: 'أحمد' }));
    expect(je).toContain('قيد يومية');
    expect(je).toContain('JE-000411');
    expect(je).toContain('القيد متوازن');
    expect(je).toContain('data-related');
    expect(je).toContain('إعداد أحمد');
    expect(je).toContain('اعتماد');
    const vat = html(vatReturn(ctxOf(), { period: '2026-10', status: 'filed', output: 5200, input: 3100, carriedIn: 0, net: 2100, offset: 3100, payable: 2100, credit: 0, paid: 1000, remaining: 1100, returnId: '1', number: 'VR-000007', filedAt: '2026-11-03', lines: { sales: [{ kind: 'sale', number: 'INV-1', date: '2026-10-05', net: 100, vat: 14, sourceType: 'sale', sourceId: '1' }], returns: [], purchases: [], purchaseReturns: [], expenses: [] }, payments: [], canFile: false, canUnfile: true, preview: null } as never));
    expect(vat).toContain('الإقرار الضريبي');
    expect(vat).toContain('data-summary');
    expect(vat).toContain('٥٬٢٠٠٫٠٠');
    const recovery = html(recoveryCodeSheet(ctxOf('ar', { shop: SHOP }), { code: 'K7QD-M2XP' }));
    expect(recovery).toContain('K7QD-M2XP');
    expect(recovery).not.toContain('النور للأدوات الكهربائية');
    expect(recovery).not.toContain('123-456-789');
  });

  it('test pages for the receipt and the A4 printer', () => {
    expect(html(receiptTestPage(ctxOf(), 'EPSON'))).toContain('EPSON');
    expect(html(documentTestPage(ctxOf(), 'HP'))).toContain('HP');
    expect(html(receiptTestPage(ctxOf(), ''))).toContain('data-barcode="TEST-000001"');
  });
});

describe('print adapters (stored values, never recomputed)', () => {
  const row: InvoiceHistoryRow = {
    id: 'i1', invoiceId: 'i1', invoiceNumber: 'INV-000012', createdByName: 'محمود', customerName: 'سامي', customerPhone: '010', sellingDate: '2026-11-05T10:00:00Z', itemCount: 2, totalQuantity: 3,
    subtotal: 270, discountAmount: 20, discountPercentage: 7.41, shippingFees: null, totalPrice: 250, netTotal: 250, vat: VAT, customerTaxNumber: '555', status: 'cancelled', cancellationReason: 'غلط',
    items: [{ id: 'a', invoiceId: 'i1', productId: 'p1', productCode: 'A35', productName: 'لمبة', categoryName: 'لمبات', customerName: '', customerPhone: '', sellingDate: null, quantity: 2, unitPrice: 35, totalPrice: 70, vatExempt: true }],
  };

  it('a cash invoice row keeps its stored totals, VAT, cashier and cancel reason', () => {
    const data = toCashSaleData(row);
    expect(data).toEqual(jasmine.objectContaining({ number: 'INV-000012', cashier: 'محمود', subtotal: 270, discount: 20, total: 250, customerTaxNumber: '555', shipping: 0 }));
    expect(data.vat).toEqual(VAT);
    expect(data.cancelled).toEqual({ reason: 'غلط' });
    expect(data.items[0]).toEqual({ code: 'A35', name: 'لمبة', quantity: 2, unitPrice: 35, total: 70, vatExempt: true });
    expect('paid' in data).toBeFalse();
  });

  it('the answer of a saved sale maps to a receipt', () => {
    const data = sellingResponseToCashSaleData({ _id: 'x', number: 'INV-000130', sellingDate: '2026-11-05', customerName: 'ع', discountAmount: 5, shippingFees: 0, totalPrice: 95, vatRate: 14, vatAmount: 11.67, items: [{ productName: 'لمبة', productQuantity: 2, productPricePerEach: 50, totalPrice: 100 }] }, { paymentMethod: 'كاش' });
    expect(data).toEqual(jasmine.objectContaining({ number: 'INV-000130', discount: 5, total: 95, subtotal: 100, paymentMethod: 'كاش' }));
    expect(data.vat?.rate).toBe(14);
    expect(data.items[0].unitPrice).toBe(50);
  });

  it('a credit invoice view keeps the stored paid/remaining, payments, due date and balances', () => {
    const data = toCreditInvoiceData({
      id: 'c1', invoiceId: 'c1', number: 'CR-000032', customerId: 'u1', customerName: 'م', customerPhone: '01', sellingDate: '2026-11-05', dueDate: '2026-12-05', status: 'partially_paid',
      subtotal: 790, discountAmount: null, discountPercentage: null, shippingFees: null, totalPrice: 790, netTotal: 790, paidAmount: 200, remainingAmount: 590, itemCount: 1, totalQuantity: 3, notes: 'ملاحظة', paymentsCount: 1,
      items: [{ id: 'i', productId: 'p', productName: 'بانل', productCode: 'P', categoryName: 'ك', quantity: 2, pricePerEach: 320, totalPrice: 640 }],
      payments: [{ id: 'p1', number: 'RC-000040', amount: 200, paymentDate: '2026-11-05', note: 'مقدم مع الفاتورة' }], writtenOff: false, refunds: [], refundedAmount: 0, cancellationReason: '',
    }, { customerTaxNumber: '777', balanceBefore: 0, balanceAfter: 590 });
    expect(data).toEqual(jasmine.objectContaining({ number: 'CR-000032', paid: 200, remaining: 590, total: 790, dueDate: '2026-12-05', note: 'ملاحظة', balanceBefore: 0, balanceAfter: 590, customerTaxNumber: '777' }));
    expect(data.payments).toEqual([{ label: 'مقدم مع الفاتورة', kind: 'payment', date: '2026-11-05', amount: 200 }]);
  });

  it('toInvoiceVat reads the stored fields and is undefined for an invoice saved with VAT off', () => {
    expect(toInvoiceVat({ vatRate: 14, vatIncluded: true, vatAmount: 30.7, netAmount: 219.3, totalPrice: 250 })).toEqual(VAT);
    expect(toInvoiceVat({ totalPrice: 100 })).toBeUndefined();
    expect(toInvoiceVat(null)).toBeUndefined();
  });
});

describe('escaping: every value inserted into print HTML is HTML-escaped', () => {
  const XSS = '<img src=x onerror=alert(1)>';
  const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';
  const hostileShop = { ...SHOP, name: XSS, address: XSS, phones: [XSS], taxNumber: XSS, commercialRegister: XSS, invoiceFooter: XSS };
  const hostile = (ctx: PrintContext = ctxOf('ar', { shop: hostileShop, printedBy: XSS })) => ctx;
  const expectSafe = (out: string): void => {
    expect(out).not.toContain('<img src=x');
    // the page margin boxes live in <style> (the "<" there is a CSS escape, so it cannot open a tag); the body holds the markup
    expect(out.split('</style>')[1]).not.toContain('onerror=alert(1)>');
    expect(out).toContain(ESCAPED);
    expect(out.match(/<script/gi)).toBeNull();
  };

  it('an invoice (customer, cashier, items, payment method, cancel reason, shop data and the signed-in user)', () => {
    const data = { ...sale, cashier: XSS, customerName: XSS, customerPhone: XSS, customerTaxNumber: XSS, paymentMethod: XSS, items: [{ code: XSS, name: XSS, quantity: 1, unitPrice: 5, total: 5 }], vat: VAT, cancelled: { reason: XSS, by: XSS } };
    for (const doc of [cashInvoice(hostile(), data), cashReceipt(hostile(), data), creditInvoice(hostile(), { ...data, paid: 0, remaining: 5, note: XSS, payments: [{ label: XSS, date: null, amount: 1 }] })]) expectSafe(html(doc, hostile()));
    expectSafe(html(purchaseInvoice(hostile(), { number: XSS, date: null, supplierInvoiceNo: XSS, supplier: { name: XSS, contact: XSS, phone: XSS, address: XSS, taxNumber: XSS }, items: [{ code: XSS, name: XSS, quantity: 1, unitCost: 1, total: 1 }], subtotal: 1, discount: 0, otherCosts: 0, total: 1, paid: 0, remaining: 1, notes: XSS, receivedBy: XSS, journal: { number: XSS, lines: [{ name: XSS, debit: 1, credit: 0 }] } }), hostile()));
  });

  it('a statement and the other lists (descriptions, memos, document numbers, names, categories)', () => {
    const lines = [{ date: '2026-11-05', description: XSS, memo: XSS, number: XSS, debit: 1, credit: 0, balance: 1 }];
    const aging = { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 };
    expectSafe(html(customerStatement(hostile(), { customer: { name: XSS, phone: XSS, taxNumber: XSS }, lines, totals: { openingBalance: 0, debit: 1, credit: 0, balance: 1 }, aging }), hostile()));
    expectSafe(html(supplierStatement(hostile(), { supplier: { name: XSS, contact: XSS, phone: XSS }, lines, totals: { openingBalance: 0, debit: 0, credit: 1, balance: 1 } }), hostile()));
    expectSafe(html(stockList(hostile(), { rows: [{ code: XSS, name: XSS, categoryName: XSS, inventoryCount: 1, lowStock: true, purchasePrice: 1 }], categoryLabel: XSS, preparedBy: XSS }), hostile()));
    expectSafe(html(journalEntry(hostile(), { number: XSS, date: null, typeLabel: XSS, sourceNumber: XSS, partyName: XSS, memo: XSS, lines: [{ code: XSS, name: XSS, memo: XSS, debit: 1, credit: 1 }], totalDebit: 1, totalCredit: 1, related: [XSS], preparedBy: XSS }), hostile()));
    expectSafe(html(paymentReceipt(hostile(), { number: XSS, date: null, cashier: XSS, customerName: XSS, customerPhone: XSS, invoiceNumbers: [XSS], amount: 1, paymentMethod: XSS, note: XSS }), hostile()));
    expectSafe(html(returnReceipt(hostile(), { number: XSS, date: null, invoiceNumber: XSS, invoiceKind: 'cash', customerName: XSS, cashier: XSS, items: [{ name: XSS, quantity: 1, unitPrice: 1, total: 1, reason: XSS }], total: 1, settlement: XSS, stockNote: XSS }), hostile()));
    expectSafe(html(shiftClose(hostile(), { number: XSS, boxName: XSS, cashier: XSS, openedAt: null, closedAt: null, summary: [{ label: XSS, amount: 1 }], movement: [{ label: XSS, amount: 1, sign: '' }], expected: 1, counted: 1, difference: 0, differenceNote: XSS, deposit: { boxName: XSS, amount: 1 } }), hostile()));
  });

  it('a voucher: the party, the reason (plain text is escaped), the method, the signer and the numbers; the receipt voucher\'s invoice numbers too', () => {
    for (const type of ['PV', 'EX', 'DR', 'CP', 'VP', 'SR', 'RC'] as const) {
      expectSafe(html(voucher(hostile(), { type, number: XSS, date: null, amount: 5, party: XSS, reason: XSS, method: XSS, balanceLabel: XSS, balanceBefore: 1, balanceAfter: 2, preparedBy: XSS, journalNumber: XSS, cancelled: { reason: XSS } }), hostile()));
    }
    expectSafe(html(receiptVoucher(hostile(), { number: XSS, date: null, cashier: XSS, customerName: XSS, invoiceNumbers: [XSS], amount: 5, paymentMethod: XSS, note: XSS, journalNumber: XSS }), hostile()));
    expect(html(voucher(ctxOf(), { type: 'PV', number: 'PV-000001', date: null, amount: 5, party: 'x', reason: '<b>bold</b> & more' }))).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more');
  });

  it('reports: account names, party names and labels', () => {
    const trial = { report: 'trial-balance', period: { from: '2026-10-01', to: '2026-10-31' }, balanced: true, totals: { closingDebit: 1, closingCredit: 1 }, rows: [{ id: 'g', kind: 'group', code: XSS, nameAr: XSS, nameEn: XSS, isZero: false, children: [{ id: 'l', kind: 'line', code: XSS, nameAr: XSS, nameEn: XSS, closingDebit: 1, closingCredit: 0, isZero: false }] }] };
    expectSafe(html(trialBalance(hostile(), trial as never), hostile()));
    expectSafe(html(boxMovements(hostile(), { period: { from: '2026-10-01', to: '2026-10-31' }, boxes: [{ name: XSS, opening: 0, in: 0, out: 0, closing: 0 }], totals: { opening: 0, in: 0, out: 0, closing: 0 } } as never), hostile()));
    expectSafe(html(partyBalances(hostile(), { asOf: '2026-11-05', customers: { rows: [{ name: XSS, balance: 1, isZero: false, aging: { current: 1, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 1 } }], totals: { count: 1, balance: 1, current: 1, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 } } } as never), hostile()));
    expectSafe(html(profitReport(hostile(), { periodLabel: XSS, kpis: { sales: 1, cost: 1, profit: 0, margin: 0 }, months: [{ label: XSS, cashProfit: 1, creditProfit: 1, profit: 2 }], products: [{ name: XSS, category: XSS, quantity: 1, sales: 1, cost: 1, profit: 0, margin: 0 }] }), hostile()));
  });

  it('the signed-in user or shop name can never close the <style> element through a page-margin box', () => {
    const evil = ctxOf('ar', { printedBy: '</style><script>alert(1)</script>', shop: { ...SHOP, name: '</style><img src=x onerror=alert(1)>' } });
    const out = html(cashInvoice(evil, sale), evil);
    expect(out.match(/<\/style>/g)?.length).toBe(1);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('\\3C /style>');
  });
});

// ---------------------------------------------------------------- Stage 23 review fixes

describe('Stage 23 review fixes', () => {
  const NAME = "O'Brien & Co";
  const SHIFT = { number: 'SH-000058', boxName: 'درج', cashier: 'ك', openedAt: null, closedAt: null, summary: [], movement: [], expected: 7550, counted: 7500, difference: -50 };
  const copyCtx = (extra: Partial<PrintContext> = {}) => ctxOf('ar', { copy: { n: 1, at: new Date(2026, 10, 6, 9, 5) }, ...extra });
  const STOCK_ROWS = [{ code: 'A1', name: 'لمبة', categoryName: 'إضاءة', inventoryCount: 2, lowStock: true, purchasePrice: 30 }];
  const STATEMENT = { customer: { name: 'م. سامي' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 }, aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 } };
  const JOURNAL = { number: 'JE-000415', date: '2026-11-05', typeLabel: 'يدوي', lines: [{ code: '110', name: 'الخزنة', debit: 5, credit: 0 }], totalDebit: 5, totalCredit: 5, related: [] as string[] };
  const VAT_RETURN = { period: '2026-10', status: 'filed', output: 5200, input: 3100, carriedIn: 0, net: 2100, offset: 3100, payable: 2100, credit: 0, paid: 1000, remaining: 1100, returnId: '1', number: 'VR-000007', filedAt: '2026-11-03', lines: { sales: [{ kind: 'sale', number: 'INV-1', date: '2026-10-05', net: 100, vat: 14, sourceType: 'sale', sourceId: '1' }], returns: [], purchases: [], purchaseReturns: [], expenses: [] }, payments: [], canFile: false, canUnfile: true, preview: null };

  describe('cash invoice and receipt with returns', () => {
    const returned: InvoiceHistoryRow = {
      id: 'i1', invoiceId: 'i1', invoiceNumber: 'INV-000012', createdByName: 'محمود', customerName: 'سامي', customerPhone: '010', sellingDate: '2026-11-05T10:00:00Z', itemCount: 2, totalQuantity: 3,
      subtotal: 270, discountAmount: 20, discountPercentage: null, shippingFees: null, totalPrice: 250, netTotal: 180, refundedAmount: 70, refundStatus: 'partial',
      items: [{ id: 'a', invoiceId: 'i1', productId: 'p1', productCode: 'A35', productName: 'لمبة', customerName: '', customerPhone: '', categoryName: '', sellingDate: null, quantity: 2, unitPrice: 35, totalPrice: 70 }],
    };

    it('the total is the STORED invoice total (250), the return and the net after it (180) are their own rows', () => {
      const data = toCashSaleData(returned);
      expect(data.total).toBe(250);
      expect(data.returned).toBe(70);
      expect(data.netAfterReturn).toBe(180);
      for (const out of [html(cashInvoice(ctxOf(), data)), html(cashReceipt(ctxOf(), data))]) {
        expect(out).toMatch(/data-total[^>]*>[\s\S]*?٢٥٠٫٠٠/);
        expect(out).toMatch(/data-returned[^>]*>[\s\S]*?٧٠٫٠٠/);
        expect(out).toContain('مرتجع');
        expect(out).toContain('الصافي بعد المرتجع');
        expect(out.split('١٨٠٫٠٠').length - 1).toBe(1, 'the net after the return appears only on its own row');
        expect(out).toMatch(/data-net-after-return[^>]*>[\s\S]*?١٨٠٫٠٠/);
      }
    });

    it('an invoice without returns has no return rows and the total is still the stored one', () => {
      const data = toCashSaleData({ ...returned, refundedAmount: 0, netTotal: 250, refundStatus: 'none' });
      expect(data.total).toBe(250);
      expect('returned' in data).toBeFalse();
      for (const out of [html(cashInvoice(ctxOf(), data)), html(cashReceipt(ctxOf(), data))]) {
        expect(out).not.toContain('data-returned');
        expect(out).not.toContain('data-net-after-return');
      }
    });

    it('English prints say "Returned" and "Net after returns"', () => {
      const out = html(cashInvoice(ctxOf('en'), toCashSaleData(returned)), ctxOf('en'));
      expect(out).toContain('Returned');
      expect(out).toContain('Net after returns');
    });
  });

  describe('shift close report', () => {
    it('shows the "نسخة" mark under its title on a reprint, and not on the first print', () => {
      const out = html(shiftClose(copyCtx(), SHIFT), copyCtx());
      expect(out).toContain('data-copy-mark');
      expect(out.indexOf('data-title')).toBeLessThan(out.indexOf('data-copy-mark'));
      expect(out.indexOf('data-copy-mark')).toBeLessThan(out.indexOf('data-no-row', 0) === -1 ? out.indexOf('الخزنة', out.indexOf('data-title')) : 0);
      expect(html(shiftClose(ctxOf(), SHIFT))).not.toContain('data-copy-mark');
    });

    it('boxes the shortage / overage row like the design (2px border, 18px); a matching count is a plain row', () => {
      const short = html(shiftClose(ctxOf(), SHIFT));
      expect(short).toMatch(/data-difference data-difference-box style="[^"]*font-size:18px[^"]*border:2px solid/);
      expect(short).toContain('عجز');
      expect(html(shiftClose(ctxOf(), { ...SHIFT, counted: 7600, difference: 50 }))).toMatch(/data-difference-box[\s\S]*?زيادة/);
      const matching = html(shiftClose(ctxOf(), { ...SHIFT, counted: 7550, difference: 0 }));
      expect(matching).not.toContain('data-difference-box');
      expect(matching).toContain('مطابق');
    });
  });

  describe('credit invoice: the debt acknowledgment and the signatures stay on one page', () => {
    const eightLines = Array.from({ length: 8 }, (_, index) => ({ code: `P${index}`, name: `صنف ${index + 1}`, quantity: 1, unitPrice: 100, total: 100 }));
    const credit8 = { number: 'CR-000050', date: new Date(2026, 10, 5), customerName: 'م. سامي', dueDate: new Date(2026, 11, 5), items: eightLines, subtotal: 800, discount: 0, shipping: 0, total: 800, paid: 200, remaining: 600, payments: [{ kind: 'down_payment' as const, date: new Date(2026, 10, 5), amount: 200 }] };

    it('the acknowledgment and both signature columns share ONE .keep block', () => {
      const doc = document.createElement('div');
      doc.innerHTML = creditInvoice(ctxOf(), credit8).body;
      const block = doc.querySelector('[data-debt-block]') as HTMLElement;
      expect(block.classList.contains('keep')).toBeTrue();
      expect(block.querySelector('[data-acknowledgment]')).not.toBeNull();
      expect(block.querySelectorAll('[data-signatures] > div').length).toBe(2);
    });

    it('fragmented into pages of every height near the end, the acknowledgment and both signatures are always on the same page (real Chromium layout)', async () => {
      const full = html(creditInvoice(ctxOf(), credit8));
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:700px;height:3000px;border:0;visibility:hidden';
      document.body.appendChild(frame);
      try {
        await new Promise<void>((resolve) => { frame.onload = () => resolve(); frame.srcdoc = full; });
        const doc = frame.contentDocument as Document;
        const body = doc.body;
        const style = doc.createElement('style');
        doc.head.appendChild(style);
        const pageOf = (element: Element, width: number): number => {
          const box = element.getBoundingClientRect();
          return Math.floor((body.getBoundingClientRect().right - (box.left + box.width / 2)) / width);
        };
        style.textContent = 'body{width:700px;height:auto}';
        const natural = body.getBoundingClientRect().height;
        const block = doc.querySelector('[data-debt-block]') as HTMLElement;
        const blockHeight = block.getBoundingClientRect().height;
        const checked: number[] = [];
        for (let page = Math.floor(natural - blockHeight - 40); page <= Math.ceil(natural); page += 6) {
          // The body is a multi-column box of fixed height: every column is a page, break-inside: avoid decides what moves.
          style.textContent = `html{direction:rtl} body{width:700px;height:${page}px;columns:700px;column-gap:0;column-fill:auto}`;
          const ack = doc.querySelector('[data-acknowledgment]') as Element;
          const sigs = Array.from(doc.querySelectorAll('[data-debt-block] [data-signatures] > div'));
          const pages = [pageOf(ack, 700), ...sigs.map((sig) => pageOf(sig, 700))];
          expect(new Set(pages).size).toBe(1, `page height ${page}px: acknowledgment and signatures on pages ${pages}`);
          checked.push(pages[0]);
        }
        expect(Math.max(...checked)).toBeGreaterThan(0, 'at least one of the heights really pushed the block to a second page');
      } finally {
        frame.remove();
      }
    });
  });

  describe('signatures get raw strings (no double escaping)', () => {
    const noDouble = (out: string) => {
      expect(out).toContain('O&#39;Brien &amp; Co');
      expect(out).not.toContain('&amp;amp;');
      expect(out).not.toContain('&amp;#39;');
      expect(out).not.toContain("O'Brien");
    };

    it('purchase invoice (received by), stock list (counted by) and journal entry (prepared by)', () => {
      const purchase = { number: 'PO-000001', date: null, supplier: { name: 'م' }, items: [], subtotal: 0, discount: 0, otherCosts: 0, total: 0, paid: 0, remaining: 0, receivedBy: NAME };
      noDouble(html(purchaseInvoice(ctxOf(), purchase)));
      noDouble(html(stockList(ctxOf(), { rows: STOCK_ROWS, categoryLabel: 'الكل', preparedBy: NAME })));
      noDouble(html(journalEntry(ctxOf(), { ...JOURNAL, preparedBy: NAME })));
    });
  });

  describe('smaller fixes', () => {
    it('cssString strips form feeds as well as CR and LF', () => {
      expect(cssString('a\fb\r\nc\nd')).toBe('a b c d');
      expect(cssString('x"y\\z')).toBe('x\\"y\\\\z');
    });

    it('the measuring iframe is sandboxed (allow-same-origin only: no scripts, forms or popups)', async () => {
      const measuring = measureRollHeightMm('<!doctype html><html><body><p>x</p></body></html>');
      const frame = document.querySelector('iframe[aria-hidden="true"]') as HTMLIFrameElement;
      expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
      expect(await measuring).toBeGreaterThan(0);
    });

    it('the shop footer ("لا ترد ولا تستبدل") is on sales documents only', () => {
      const FOOTER = 'البضاعة المباعة لا ترد';
      const sales = [
        cashReceipt(ctxOf(), sale),
        paymentReceipt(ctxOf(), { number: 'RC-000041', date: null, customerName: 'س', invoiceNumbers: [], amount: 1 }),
        returnReceipt(ctxOf(), { number: 'RT-000009', date: null, invoiceKind: 'cash', items: [], total: 0 }),
        cashInvoice(ctxOf(), sale),
        creditInvoice(ctxOf(), { ...sale, paid: 0, remaining: 250 }),
      ];
      for (const doc of sales) expect(html(doc)).toContain(FOOTER);
      const others = [
        shiftClose(ctxOf(), SHIFT),
        stockList(ctxOf(), { rows: STOCK_ROWS, categoryLabel: 'الكل' }),
        customerStatement(ctxOf(), STATEMENT),
        supplierStatement(ctxOf(), { supplier: { name: 'م' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 } }),
        profitReport(ctxOf(), { periodLabel: 'x', from: null, to: null, kpis: { sales: 0, cost: 0, profit: 0, margin: null }, months: [], products: [] } as never),
        journalEntry(ctxOf(), JOURNAL),
        vatReturn(ctxOf(), VAT_RETURN as never),
        purchaseInvoice(ctxOf(), { number: 'PO-000001', date: null, supplier: { name: 'م' }, items: [], subtotal: 0, discount: 0, otherCosts: 0, total: 0, paid: 0, remaining: 0 }),
      ];
      for (const doc of others) expect(html(doc)).not.toContain(FOOTER);
    });

    it('VAT return group rows show the stored group totals from the API (count, net, VAT), not a re-addition of the lines', () => {
      const out = html(vatReturn(ctxOf(), { ...VAT_RETURN, groupTotals: { sales: { count: 7, net: 1000, vat: 140 }, returns: { count: 0, net: 0, vat: 0 }, purchases: { count: 0, net: 0, vat: 0 }, purchaseReturns: { count: 0, net: 0, vat: 0 }, expenses: { count: 0, net: 0, vat: 0 } } } as never));
      expect(out).toContain('١٬٠٠٠٫٠٠');
      expect(out).toContain('١٤٠٫٠٠');
      expect(out).toContain('>٧<');
    });

    it('statement headers print the customer / supplier name in its own labelled row, not in the number slot', () => {
      const customer = html(customerStatement(ctxOf(), STATEMENT));
      expect(customer).toMatch(/<span class="muted">العميل<\/span><span style="font-weight:700">م\. سامي<\/span>/);
      expect(customer).not.toMatch(/<span class="muted">رقم<\/span>/);
      const supplier = html(supplierStatement(ctxOf(), { supplier: { name: 'الشركة' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 } }));
      expect(supplier).toMatch(/<span class="muted">المورد<\/span><span style="font-weight:700">الشركة<\/span>/);
      expect(supplier).not.toMatch(/<span class="muted">رقم<\/span>/);
    });

    it('credit invoice payment labels follow the print language (own note wins)', () => {
      const base = { ...sale, paid: 200, remaining: 50, total: 250 };
      const en = html(creditInvoice(ctxOf('en'), { ...base, payments: [{ kind: 'down_payment', date: null, amount: 100 }, { kind: 'payment', date: null, amount: 100 }] }), ctxOf('en'));
      expect(en).toContain('Down payment with the invoice');
      expect(en).toContain('>Payment<');
      expect(en).not.toMatch(/دفعة|مقدم/);
      const ar = html(creditInvoice(ctxOf(), { ...base, payments: [{ kind: 'down_payment', date: null, amount: 100 }, { kind: 'payment', label: 'دفعة تانية', date: null, amount: 100 }] }));
      expect(ar).toContain('مقدم مع الفاتورة');
      expect(ar).toContain('دفعة تانية');
    });
  });
});
