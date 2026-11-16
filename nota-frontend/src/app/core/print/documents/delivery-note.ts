// Online Stage 4: the delivery note (إذن تسليم) of a website order, 80mm and A4, through the one print pipeline.
// It is NOT a tax document: it tells the courier what to hand over and how much to collect.

import { escapeHtml, formatDateTime, formatQty } from '../print-format';
import { PrintContext, PrintDocument, a4Header, a4Page, closing, moneyHtml, pick, receiptFooter, receiptHeader, receiptPage, receiptRow, row, table } from '../print-kit';

const money = moneyHtml;
const currency = (ctx: PrintContext): string => pick(ctx, 'ج.م', 'EGP');
const dash = '<div class="dash"></div>';

export interface DeliveryNoteLine {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
}

export interface DeliveryNoteData {
  number: string;
  date: string | Date | null;
  customerName: string;
  customerPhone: string;
  address: string;
  zone: string;
  notes?: string | null;
  courierName?: string | null;
  items: DeliveryNoteLine[];
  subtotal: number;
  vat: number;
  deliveryFee: number;
  /** The amount the courier collects: the order total (the invoice total, delivery fee included). */
  amountToCollect: number;
}

const ltr = (value: string): string => `<span class="ltr n">${escapeHtml(value)}</span>`;

/** PrDeliveryNote: 80mm roll. */
export function deliveryNote80(ctx: PrintContext, data: DeliveryNoteData): PrintDocument {
  const items = data.items
    .map((line) => `<div class="col" style="margin-bottom:6px">
      <span style="font-weight:500">${escapeHtml(line.name)}</span>
      <div class="r n" style="font-size:12px"><span style="flex:1 1 auto">${money(ctx, line.unitPrice)}</span><span style="width:40px;text-align:center">${formatQty(line.qty, ctx.lang)}</span><span style="width:56px;text-align:end;font-weight:700">${money(ctx, line.total)}</span></div>
    </div>`)
    .join('');
  const body = receiptPage(`${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${pick(ctx, 'إذن تسليم', 'Delivery note')}</div>
  ${receiptRow(pick(ctx, 'رقم الطلب', 'Order no.'), ltr(data.number), 'style="font-size:12px"')}
  ${receiptRow(pick(ctx, 'التاريخ', 'Date'), escapeHtml(formatDateTime(data.date, ctx.lang)), 'style="font-size:12px"')}
  ${data.courierName ? receiptRow(pick(ctx, 'المندوب', 'Courier'), escapeHtml(data.courierName), 'style="font-size:12px"') : ''}
  ${dash}
  <div class="col" style="gap:2px;font-size:13px" data-customer>
    <span style="font-weight:700">${escapeHtml(data.customerName)}</span>
    <span class="n" style="direction:ltr">${escapeHtml(data.customerPhone)}</span>
    <span>${escapeHtml(data.address)}</span>
    <span>${pick(ctx, 'المنطقة', 'Zone')}: ${escapeHtml(data.zone)}</span>
  </div>
  ${dash}
  <div class="r" style="font-size:12px;font-weight:700"><span style="flex:1 1 auto">${pick(ctx, 'الصنف', 'Item')}</span><span style="width:40px;text-align:center">${pick(ctx, 'كمية', 'Qty')}</span><span style="width:56px;text-align:end">${pick(ctx, 'الإجمالي', 'Total')}</span></div>
  ${items}
  ${dash}
  ${receiptRow(pick(ctx, 'الإجمالي', 'Subtotal'), money(ctx, data.subtotal))}
  ${data.vat ? receiptRow(pick(ctx, 'الضريبة', 'VAT'), money(ctx, data.vat), 'data-vat') : ''}
  ${receiptRow(pick(ctx, 'التوصيل', 'Delivery'), money(ctx, data.deliveryFee), 'data-delivery-fee')}
  ${dash}
  <div class="r n" style="font-size:16px;font-weight:800" data-amount-to-collect><span>${pick(ctx, 'المطلوب تحصيله', 'Amount to collect')}</span><span>${money(ctx, data.amountToCollect)} ${currency(ctx)}</span></div>
  ${data.notes ? `<div style="font-size:12px;margin-top:6px" data-notes>${pick(ctx, 'ملاحظات', 'Notes')}: ${escapeHtml(data.notes)}</div>` : ''}
  ${receiptFooter(ctx, 'document')}`);
  return { paper: '80mm', title: data.number, body };
}

/** PrDeliveryNote: A4. */
export function deliveryNoteA4(ctx: PrintContext, data: DeliveryNoteData): PrintDocument {
  const rows = data.items
    .map((line, index) => row([{ html: String(index + 1), numeric: true }, escapeHtml(line.name), { html: formatQty(line.qty, ctx.lang), numeric: true }, { html: money(ctx, line.unitPrice), numeric: true }, { html: money(ctx, line.total), numeric: true }]))
    .join('');
  const head = [{ label: '#', numeric: true, width: 36 }, { label: pick(ctx, 'الصنف', 'Item') }, { label: pick(ctx, 'الكمية', 'Qty'), numeric: true }, { label: pick(ctx, 'السعر', 'Price'), numeric: true }, { label: pick(ctx, 'الإجمالي', 'Total'), numeric: true }];
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'إذن تسليم', 'Delivery note'), no: data.number, date: formatDateTime(data.date, ctx.lang), extraLabel: data.courierName ? pick(ctx, 'المندوب', 'Courier') : '', extra: data.courierName || '' })}
  <div class="box col" style="gap:4px" data-customer>
    <span class="lbl">${pick(ctx, 'العميل', 'Customer')}</span>
    <span style="font-size:15px;font-weight:700">${escapeHtml(data.customerName)}</span>
    <span class="n" style="direction:ltr;text-align:${ctx.lang === 'ar' ? 'right' : 'left'}">${escapeHtml(data.customerPhone)}</span>
    <span style="font-size:13px">${escapeHtml(data.address)}</span>
    <span style="font-size:13px">${pick(ctx, 'المنطقة', 'Zone')}: ${escapeHtml(data.zone)}</span>
  </div>
  ${table(head, rows)}
  <div class="row keep" style="justify-content:space-between;align-items:flex-start;gap:20px">
    <div class="col grow" style="gap:10px">
      ${data.notes ? `<div class="box col" style="gap:4px" data-notes><span class="lbl">${pick(ctx, 'ملاحظات', 'Notes')}</span><span style="font-size:13px">${escapeHtml(data.notes)}</span></div>` : ''}
    </div>
    <table class="t" style="width:300px"><tbody>
      <tr><td>${pick(ctx, 'الإجمالي', 'Subtotal')}</td><td class="n">${money(ctx, data.subtotal)}</td></tr>
      ${data.vat ? `<tr data-vat><td>${pick(ctx, 'الضريبة', 'VAT')}</td><td class="n">${money(ctx, data.vat)}</td></tr>` : ''}
      <tr data-delivery-fee><td>${pick(ctx, 'التوصيل', 'Delivery')}</td><td class="n">${money(ctx, data.deliveryFee)}</td></tr>
      <tr data-amount-to-collect><td style="font-weight:800">${pick(ctx, 'المطلوب تحصيله', 'Amount to collect')}</td><td class="n" style="font-weight:800">${money(ctx, data.amountToCollect)} ${currency(ctx)}</td></tr>
    </tbody></table>
  </div>
  <div class="grow"></div>
  ${closing(ctx, [
    { who: pick(ctx, 'المندوب', 'Courier'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'العميل', 'Customer'), line: pick(ctx, 'التوقيع بالاستلام', 'Signature on receipt') },
  ])}`, 16);
  return { paper: 'A4', title: data.number, body, marginFooter: true };
}
