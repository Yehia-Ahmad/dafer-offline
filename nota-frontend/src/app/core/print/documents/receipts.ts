// Stage 23: the four 80mm receipts (PrCashReceipt, PrPaymentReceipt, PrReturnReceipt, PrShiftClose).

import { InvoiceVatInfo, vatPrintLabels } from '../../../modules/shared/vat/vat-print';
import { barcodeSvg } from '../barcode';
import { amountInWords, escapeHtml, formatDateTime, formatMoney, formatPercent, formatQty } from '../print-format';
import { PrintContext, PrintDocument, cancelBox, copyMark, pick, receiptFooter, receiptHeader, receiptPage, receiptRow } from '../print-kit';

const money = (ctx: PrintContext, value: number | null | undefined): string => formatMoney(value ?? 0, ctx.lang);
const currency = (ctx: PrintContext): string => pick(ctx, 'ج.م', 'EGP');
const ltrText = (value: string): string => `<span class="ltr n">${escapeHtml(value)}</span>`;
const dash = '<div class="dash"></div>';

export interface SaleLine {
  code?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  /** "معفى" mark (only shown when the document has VAT). */
  vatExempt?: boolean;
}

export interface CashSaleData {
  number: string;
  date: string | Date | null;
  cashier?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerTaxNumber?: string | null;
  items: SaleLine[];
  subtotal: number;
  discount: number;
  discountPercent?: number | null;
  shipping: number;
  /** The stored invoice total (never recomputed by the print, and never the net after returns). */
  total: number;
  /** An invoice with returns: the stored refunded amount and the stored net after it, each printed on its own row under the total. */
  returned?: number | null;
  netAfterReturn?: number | null;
  /** VAT as stored on the invoice (absent with VAT off). */
  vat?: InvoiceVatInfo;
  paymentMethod?: string | null;
  /** Only when the sale captured them (not captured today: the rows are omitted). */
  paid?: number | null;
  change?: number | null;
  cancelled?: { reason?: string | null; at?: string | Date | null; by?: string | null } | null;
}

function exemptTag(ctx: PrintContext, line: SaleLine, vat: InvoiceVatInfo | undefined): string {
  return vat && line.vatExempt ? ` <small>(${vatPrintLabels(ctx.lang).exempt})</small>` : '';
}

/** PrCashReceipt: cash sale, 80mm. */
export function cashReceipt(ctx: PrintContext, data: CashSaleData): PrintDocument {
  const labels = vatPrintLabels(ctx.lang);
  const pieces = data.items.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const itemsHtml = data.items
    .map(
      (line) => `<div class="col" style="margin-bottom:6px">
      <span style="font-weight:500">${escapeHtml(line.name)}${exemptTag(ctx, line, data.vat)}</span>
      <div class="r n" style="font-size:12px"><span style="flex:1 1 auto">${money(ctx, line.unitPrice)} ${pick(ctx, 'للقطعة', 'each')}</span><span style="width:40px;text-align:center">${formatQty(line.quantity, ctx.lang)}</span><span style="width:56px;text-align:end;font-weight:700">${money(ctx, line.total)}</span></div>
    </div>`
    )
    .join('');
  const discountLabel = `${pick(ctx, 'الخصم', 'Discount')}${data.discountPercent ? ` (${formatPercent(data.discountPercent, ctx.lang)})` : ''}`;
  const vatRows = data.vat
    ? `${receiptRow(pick(ctx, 'الصافي قبل الضريبة', 'Net before VAT'), money(ctx, data.vat.netAmount), 'data-vat-net')}
       ${receiptRow(`${labels.vat} ${formatPercent(data.vat.rate, ctx.lang)}`, money(ctx, data.vat.vatAmount), 'data-vat-amount')}`
    : '';
  const body = `${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${data.vat ? labels.taxInvoice : pick(ctx, 'فاتورة بيع نقدي', 'Cash sale')}</div>
  ${copyMark(ctx)}
  ${data.cancelled ? cancelBox(ctx, data.cancelled) : ''}
  ${receiptRow(pick(ctx, 'رقم', 'No.'), ltrText(data.number), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'التاريخ', 'Date'), escapeHtml(formatDateTime(data.date, ctx.lang)), 'style="font-size:12px"')}
  ${data.cashier ? receiptRow(pick(ctx, 'الكاشير', 'Cashier'), escapeHtml(data.cashier), 'style="font-size:12px"') : ''}
  ${data.customerName ? receiptRow(pick(ctx, 'العميل', 'Customer'), escapeHtml(data.customerName), 'style="font-size:12px"') : ''}
  ${data.vat && data.customerTaxNumber ? receiptRow(labels.customerTaxNumber, ltrText(data.customerTaxNumber), 'style="font-size:12px"') : ''}
  ${dash}
  <div class="r" style="font-size:12px;font-weight:700"><span style="flex:1 1 auto">${pick(ctx, 'الصنف', 'Item')}</span><span style="width:40px;text-align:center">${pick(ctx, 'كمية', 'Qty')}</span><span style="width:56px;text-align:end">${pick(ctx, 'الإجمالي', 'Total')}</span></div>
  <div class="solid"></div>
  <div class="col">${itemsHtml}</div>
  ${dash}
  ${receiptRow(pick(ctx, 'عدد الأصناف', 'Items'), `${formatQty(data.items.length, ctx.lang)} (${formatQty(pieces, ctx.lang)} ${pick(ctx, 'قطع', 'pcs')})`)}
  ${receiptRow(pick(ctx, 'الإجمالي', 'Subtotal'), money(ctx, data.subtotal))}
  ${data.discount ? receiptRow(discountLabel, `− ${money(ctx, data.discount)}`) : ''}
  ${data.shipping ? receiptRow(pick(ctx, 'التوصيل', 'Delivery'), money(ctx, data.shipping)) : ''}
  ${vatRows}
  <div class="solid2"></div>
  <div class="r n big" data-total><span>${pick(ctx, 'المطلوب', 'Total')}</span><span>${money(ctx, data.total)} ${currency(ctx)}</span></div>
  <div class="solid2"></div>
  ${data.returned ? `${receiptRow(pick(ctx, 'مرتجع', 'Returned'), money(ctx, data.returned), 'data-returned')}
  ${receiptRow(pick(ctx, 'الصافي بعد المرتجع', 'Net after returns'), `<b>${money(ctx, data.netAfterReturn ?? data.total - data.returned)}</b>`, 'data-net-after-return style="font-size:15px"')}
  <div class="solid2"></div>` : ''}
  ${data.paymentMethod ? receiptRow(pick(ctx, 'طريقة الدفع', 'Payment'), escapeHtml(data.paymentMethod)) : ''}
  ${data.paid !== null && data.paid !== undefined ? receiptRow(pick(ctx, 'المدفوع', 'Paid'), money(ctx, data.paid), 'data-paid') : ''}
  ${data.change !== null && data.change !== undefined && data.change > 0 ? receiptRow(pick(ctx, 'الباقي للزبون', 'Change'), money(ctx, data.change), 'data-change style="font-weight:700"') : ''}
  <div class="barcode" data-barcode-box>${barcodeSvg(data.number)}</div>
  <div class="fine code n" style="align-self:center">${escapeHtml(data.number)}</div>
  ${receiptFooter(ctx, 'document', true)}
  <div class="center" style="font-size:13px;font-weight:700;margin-top:4px">${pick(ctx, 'شكرًا لزيارتكم', 'Thank you for your visit')}</div>`;
  return { paper: '80mm', title: data.number, body: receiptPage(body), cancelled: data.cancelled || null };
}

// ---------------------------------------------------------------- PrPaymentReceipt

export interface PaymentReceiptData {
  number: string;
  date: string | Date | null;
  cashier?: string | null;
  customerName: string;
  customerPhone?: string | null;
  /** The invoices this payment was applied to (CR-000032 ...). */
  invoiceNumbers: string[];
  amount: number;
  /** Cash box / bank the money went into ("كاش · درج الكاشير ١"). */
  paymentMethod?: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  note?: string | null;
  /** Journal entry number (A5 voucher). */
  journalNumber?: string | null;
  /** Down payment taken with a credit invoice. */
  downPayment?: boolean;
}

export function paymentReceipt(ctx: PrintContext, data: PaymentReceiptData): PrintDocument {
  const body = `${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${data.downPayment ? pick(ctx, 'سند قبض · مقدم', 'Receipt · down payment') : pick(ctx, 'سند قبض', 'Payment receipt')}</div>
  ${copyMark(ctx)}
  ${receiptRow(pick(ctx, 'رقم', 'No.'), ltrText(data.number), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'التاريخ', 'Date'), escapeHtml(formatDateTime(data.date, ctx.lang)), 'style="font-size:12px"')}
  ${data.cashier ? receiptRow(pick(ctx, 'الكاشير', 'Cashier'), escapeHtml(data.cashier), 'style="font-size:12px"') : ''}
  ${dash}
  ${receiptRow(pick(ctx, 'استلمنا من', 'Received from'), `<b>${escapeHtml(data.customerName)}</b>`)}
  ${data.customerPhone ? receiptRow(pick(ctx, 'التليفون', 'Phone'), ltrText(data.customerPhone)) : ''}
  ${data.invoiceNumbers.length ? receiptRow(pick(ctx, 'عن فاتورة', 'For invoice'), `<span class="ltr n">${escapeHtml(data.invoiceNumbers.join(' · '))}</span>`) : ''}
  <div class="solid2"></div>
  <div class="r n big" data-total><span>${pick(ctx, 'المبلغ', 'Amount')}</span><span>${money(ctx, data.amount)} ${currency(ctx)}</span></div>
  <div class="center" style="font-size:12px;margin-top:2px" data-words>${escapeHtml(amountInWords(data.amount, ctx.lang))}</div>
  <div class="solid2"></div>
  ${data.paymentMethod ? receiptRow(pick(ctx, 'طريقة الدفع', 'Payment'), escapeHtml(data.paymentMethod)) : ''}
  ${data.balanceBefore !== null && data.balanceBefore !== undefined ? receiptRow(pick(ctx, 'الباقي قبل الدفعة', 'Balance before'), money(ctx, data.balanceBefore), 'data-balance-before') : ''}
  ${data.balanceAfter !== null && data.balanceAfter !== undefined ? receiptRow(pick(ctx, 'الباقي بعد الدفعة', 'Balance after'), `<b>${money(ctx, data.balanceAfter)}</b>`, 'data-balance-after') : ''}
  ${data.note ? receiptRow(pick(ctx, 'ملاحظة', 'Note'), escapeHtml(data.note)) : ''}
  <div class="sigline"><span>${pick(ctx, 'توقيع المستلم', 'Receiver signature')}</span><span>.................</span></div>
  <div class="barcode" data-barcode-box>${barcodeSvg(data.number)}</div>
  ${receiptFooter(ctx, 'receipt', true)}`;
  return { paper: '80mm', title: data.number, body: receiptPage(body) };
}

// ---------------------------------------------------------------- PrReturnReceipt

export interface ReturnReceiptData {
  number: string;
  date: string | Date | null;
  invoiceNumber?: string | null;
  invoiceKind: 'cash' | 'credit';
  customerName?: string | null;
  cashier?: string | null;
  items: Array<{ name: string; quantity: number; unitPrice: number; total: number; reason?: string | null }>;
  total: number;
  /** "خصم من رصيد العميل" / "رد نقدي" (what settled the refund). */
  settlement?: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  stockNote?: string | null;
}

export function returnReceipt(ctx: PrintContext, data: ReturnReceiptData): PrintDocument {
  const kind = data.invoiceKind === 'credit' ? pick(ctx, 'آجل', 'credit') : pick(ctx, 'نقدي', 'cash');
  const items = data.items
    .map(
      (line) => `<div class="col" style="margin-bottom:6px">
      <span style="font-weight:500">${escapeHtml(line.name)}</span>
      <div class="r n" style="font-size:12px"><span style="flex:1 1 auto">${money(ctx, line.unitPrice)} ${pick(ctx, 'للقطعة', 'each')}</span><span style="width:40px;text-align:center">${formatQty(line.quantity, ctx.lang)}</span><span style="width:56px;text-align:end;font-weight:700">${money(ctx, line.total)}</span></div>
      ${line.reason ? `<span class="muted" style="font-size:11px">${pick(ctx, 'السبب', 'Reason')}: ${escapeHtml(line.reason)}</span>` : ''}
    </div>`
    )
    .join('');
  const body = `${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${pick(ctx, 'إيصال مرتجع', 'Return receipt')}</div>
  ${copyMark(ctx)}
  ${receiptRow(pick(ctx, 'رقم', 'No.'), ltrText(data.number), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'التاريخ', 'Date'), escapeHtml(formatDateTime(data.date, ctx.lang)), 'style="font-size:12px"')}
  ${data.invoiceNumber ? receiptRow(pick(ctx, 'من فاتورة', 'From invoice'), `<span class="ltr n">${escapeHtml(data.invoiceNumber)}</span> (${kind})`, 'style="font-size:12px"') : ''}
  ${data.customerName ? receiptRow(pick(ctx, 'العميل', 'Customer'), escapeHtml(data.customerName), 'style="font-size:12px"') : ''}
  ${data.cashier ? receiptRow(pick(ctx, 'الكاشير', 'Cashier'), escapeHtml(data.cashier), 'style="font-size:12px"') : ''}
  ${dash}
  <div class="r" style="font-size:12px;font-weight:700"><span style="flex:1 1 auto">${pick(ctx, 'الصنف المرتجع', 'Returned item')}</span><span style="width:40px;text-align:center">${pick(ctx, 'كمية', 'Qty')}</span><span style="width:56px;text-align:end">${pick(ctx, 'القيمة', 'Value')}</span></div>
  <div class="solid"></div>
  <div class="col">${items}</div>
  <div class="solid2"></div>
  <div class="r n big" data-total><span>${pick(ctx, 'قيمة المرتجع', 'Refund')}</span><span>${money(ctx, data.total)} ${currency(ctx)}</span></div>
  <div class="solid2"></div>
  ${data.settlement ? receiptRow(pick(ctx, 'التسوية', 'Settlement'), escapeHtml(data.settlement)) : ''}
  ${data.balanceBefore !== null && data.balanceBefore !== undefined ? receiptRow(pick(ctx, 'رصيد العميل قبل', 'Customer balance before'), money(ctx, data.balanceBefore), 'data-balance-before') : ''}
  ${data.balanceAfter !== null && data.balanceAfter !== undefined ? receiptRow(pick(ctx, 'رصيد العميل بعد', 'Customer balance after'), `<b>${money(ctx, data.balanceAfter)}</b>`, 'data-balance-after') : ''}
  ${data.stockNote ? receiptRow(pick(ctx, 'المخزون', 'Stock'), escapeHtml(data.stockNote)) : ''}
  <div class="sigline"><span>${pick(ctx, 'توقيع العميل', 'Customer signature')}</span><span>.................</span></div>
  <div class="barcode" data-barcode-box>${barcodeSvg(data.number)}</div>
  ${receiptFooter(ctx, 'receipt', true)}`;
  return { paper: '80mm', title: data.number, body: receiptPage(body) };
}

// ---------------------------------------------------------------- PrShiftClose

export interface ShiftCloseData {
  number: string;
  boxName: string;
  cashier: string;
  openedAt: string | Date | null;
  closedAt: string | Date | null;
  /** "ملخص المبلغ": label + optional count + amount. */
  summary: Array<{ label: string; count?: number | null; amount: number }>;
  /** "حركة الدرج": sign + label + amount (opening float first). */
  movement: Array<{ label: string; amount: number; sign: '+' | '−' | '' }>;
  expected: number;
  counted: number;
  difference: number;
  differenceNote?: string | null;
  deposit?: { boxName: string; amount: number } | null;
  remaining?: number | null;
}

export function shiftClose(ctx: PrintContext, data: ShiftCloseData): PrintDocument {
  const diffLabel = data.difference === 0 ? pick(ctx, 'مطابق', 'Matches') : data.difference < 0 ? pick(ctx, 'عجز', 'Shortage') : pick(ctx, 'زيادة', 'Overage');
  const summary = data.summary
    .map((line) => receiptRow(escapeHtml(line.label), `${line.count !== null && line.count !== undefined ? `${formatQty(line.count, ctx.lang)} · ` : ''}${money(ctx, line.amount)}`))
    .join('');
  const movement = data.movement
    .map((line) => receiptRow(`${line.sign ? `${line.sign} ` : ''}${escapeHtml(line.label)}`, money(ctx, line.amount)))
    .join('');
  const body = `${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${pick(ctx, 'تقرير إقفال وردية', 'Shift close report')}</div>
  ${copyMark(ctx)}
  ${receiptRow(pick(ctx, 'رقم', 'No.'), ltrText(data.number), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'الخزنة', 'Box'), escapeHtml(data.boxName), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'الكاشير', 'Cashier'), escapeHtml(data.cashier), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'من', 'From'), escapeHtml(formatDateTime(data.openedAt, ctx.lang)), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'إلى', 'To'), escapeHtml(formatDateTime(data.closedAt, ctx.lang)), 'style="font-size:12px"')}
  ${dash}
  ${summary ? `<div style="font-weight:800;font-size:13px;margin-bottom:2px">${pick(ctx, 'ملخص المبيعات', 'Sales summary')}</div>${summary}${dash}` : ''}
  <div style="font-weight:800;font-size:13px;margin-bottom:2px">${pick(ctx, 'حركة الدرج', 'Drawer movement')}</div>
  ${movement}
  <div class="solid2"></div>
  ${receiptRow(pick(ctx, 'المفروض في الدرج', 'Expected in drawer'), `<b>${money(ctx, data.expected)}</b>`, 'data-expected')}
  ${receiptRow(pick(ctx, 'المعدود فعلًا', 'Counted'), `<b>${money(ctx, data.counted)}</b>`, 'data-counted')}
  ${data.difference === 0
    ? receiptRow(diffLabel, `<b>${money(ctx, 0)}</b>`, 'data-difference')
    : `<div class="r n" data-difference data-difference-box style="font-size:18px;font-weight:800;border:2px solid var(--p-text);padding:4px 8px;margin-top:6px"><span>${diffLabel}</span><span>${money(ctx, Math.abs(data.difference))}</span></div>`}
  ${data.differenceNote ? receiptRow(pick(ctx, 'ملاحظة', 'Note'), escapeHtml(data.differenceNote), 'style="font-size:12px;margin-top:4px"') : ''}
  ${data.deposit ? `${dash}<div style="font-weight:800;font-size:13px;margin-bottom:2px">${pick(ctx, 'التسليم', 'Handover')}</div>
    ${receiptRow(`${pick(ctx, 'توريد ل', 'Deposit to')} ${escapeHtml(data.deposit.boxName)}`, money(ctx, data.deposit.amount), 'data-deposit')}
    ${data.remaining !== null && data.remaining !== undefined ? receiptRow(pick(ctx, 'يفضل في الدرج', 'Stays in drawer'), money(ctx, data.remaining), 'data-remaining') : ''}` : ''}
  <div class="sigline"><span>${pick(ctx, 'توقيع الكاشير', 'Cashier signature')}</span><span>.................</span></div>
  <div class="sigline"><span>${pick(ctx, 'توقيع المدير', 'Manager signature')}</span><span>.................</span></div>
  <div class="barcode" data-barcode-box>${barcodeSvg(data.number)}</div>
  ${receiptFooter(ctx)}`;
  return { paper: '80mm', title: data.number, body: receiptPage(body) };
}

