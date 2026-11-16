// Online Stage 4: the delivery note (إذن تسليم), 80mm and A4: shop header, order number, customer, zone, lines, delivery fee,
// the amount to collect, notes.
import { deliveryNote80, deliveryNoteA4, DeliveryNoteData } from './documents/delivery-note';
import { buildPrintHtml, PrintContext, PrintDocument } from './print-kit';

const SHOP = { name: 'النور للأدوات الكهربائية', address: 'المنصورة', phones: ['01002223344'], logo: '', taxNumber: '', commercialRegister: '', invoiceFooter: '' };
const ctxOf = (lang: 'ar' | 'en' = 'ar'): PrintContext => ({ lang, shop: SHOP, printedBy: 'محمود', printedAt: new Date(2026, 10, 5, 12, 40), fontCss: '', copy: null });
const html = (doc: PrintDocument, ctx = ctxOf()): string => buildPrintHtml(ctx, doc, 150);

const data: DeliveryNoteData = {
  number: 'W-000012', date: new Date(2026, 10, 5, 12, 40), customerName: 'منى السيد', customerPhone: '01012345678', address: 'شارع النصر 5، الدور 3', zone: 'المنصورة',
  notes: 'التليفون قبل الوصول', courierName: 'أحمد المندوب',
  items: [{ name: 'لمبة LED ٩ وات', qty: 4, unitPrice: 35, total: 140 }, { name: 'كابل 3 متر', qty: 1, unitPrice: 60, total: 60 }],
  subtotal: 200, vat: 0, deliveryFee: 30, amountToCollect: 230,
};

describe('delivery note (Online Stage 4)', () => {
  for (const [name, build, paper] of [['80mm', deliveryNote80, '80mm'], ['A4', deliveryNoteA4, 'A4']] as const) {
    it(`${name}: shop header, number, customer, zone, lines, delivery fee, amount to collect and notes`, () => {
      const doc = build(ctxOf(), data);
      expect(doc.paper).toBe(paper);
      const out = html(doc);
      expect(out).toContain('النور للأدوات الكهربائية');
      expect(out).toContain('إذن تسليم');
      expect(out).toContain('W-000012');
      expect(out).toContain('منى السيد');
      expect(out).toContain('01012345678');
      expect(out).toContain('شارع النصر 5، الدور 3');
      expect(out).toContain('المنصورة');
      expect(out).toContain('لمبة LED ٩ وات');
      expect(out).toContain('كابل 3 متر');
      expect(out).toContain('data-delivery-fee');
      expect(out).toContain('data-amount-to-collect');
      expect(out).toContain('٢٣٠٫٠٠'); // 230.00 in Arabic digits
      expect(out).toContain('التليفون قبل الوصول');
      expect(out).toContain('أحمد المندوب');
    });

    it(`${name}: English is left-to-right with Latin digits; VAT shows only when there is some; no notes row without notes`, () => {
      const out = html(build(ctxOf('en'), { ...data, notes: '', vat: 0 }), ctxOf('en'));
      expect(out).toContain('Delivery note');
      expect(out).toContain('Amount to collect');
      expect(out).toContain('230.00');
      expect(out).not.toContain('data-vat');
      expect(out).not.toContain('data-notes');
      expect(html(build(ctxOf('en'), { ...data, vat: 24.5 }), ctxOf('en'))).toContain('data-vat');
    });
  }
});
