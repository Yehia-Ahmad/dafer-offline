// Stage 23: the "اطبع صفحة تجربة" pages: one for the 80mm receipt printer, one for the A4/A5 printer.

import { barcodeSvg } from '../barcode';
import { escapeHtml, formatDateTime, formatMoney } from '../print-format';
import { PrintContext, PrintDocument, a4Header, a4Page, pick, receiptHeader, receiptPage, receiptRow } from '../print-kit';

export function receiptTestPage(ctx: PrintContext, printerName: string): PrintDocument {
  const body = `${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${pick(ctx, 'صفحة تجربة الطباعة', 'Printer test page')}</div>
  ${receiptRow(pick(ctx, 'الطابعة', 'Printer'), escapeHtml(printerName || pick(ctx, 'الافتراضية', 'Default')))}
  ${receiptRow(pick(ctx, 'الورق', 'Paper'), '80mm')}
  ${receiptRow(pick(ctx, 'التاريخ', 'Date'), escapeHtml(formatDateTime(ctx.printedAt, ctx.lang)))}
  <div class="dash"></div>
  ${receiptRow(pick(ctx, 'مثال لصنف', 'Sample item'), formatMoney(1234.5, ctx.lang))}
  ${receiptRow(pick(ctx, 'أرقام', 'Digits'), ctx.lang === 'ar' ? '٠١٢٣٤٥٦٧٨٩' : '0123456789')}
  <div class="barcode">${barcodeSvg('TEST-000001')}</div>
  <div class="fine code n" style="align-self:center">TEST-000001</div>
  <div class="dash"></div>
  <div class="center" style="font-size:12px">${pick(ctx, 'لو قرأت هذه الصفحة كاملة وبوضوح فالطابعة جاهزة', 'If you can read this whole page clearly, the printer is ready')}</div>`;
  return { paper: '80mm', title: 'Nota test page', body: receiptPage(body) };
}

export function documentTestPage(ctx: PrintContext, printerName: string): PrintDocument {
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'صفحة تجربة الطباعة', 'Printer test page'), date: formatDateTime(ctx.printedAt, ctx.lang).split(' · ')[0], extraLabel: pick(ctx, 'الطابعة', 'Printer'), extra: printerName || pick(ctx, 'الافتراضية', 'Default') })}
  <div class="box" style="font-size:14px;line-height:2">${pick(ctx, 'لو قرأت هذه الصفحة كاملة وبوضوح، وكانت الحدود والجدول داخل الورقة، فالطابعة جاهزة للفواتير والكشوف.', 'If you can read this whole page clearly, and the borders and the table fit inside the paper, the printer is ready for invoices and statements.')}</div>
  <table class="t"><thead><tr><th>#</th><th>${pick(ctx, 'البند', 'Item')}</th><th class="n">${pick(ctx, 'المبلغ', 'Amount')}</th></tr></thead>
  <tbody><tr><td class="n">${ctx.lang === 'ar' ? '١' : '1'}</td><td>${pick(ctx, 'صنف تجريبي', 'Sample item')}</td><td class="n">${formatMoney(1234.5, ctx.lang)}</td></tr></tbody></table>`);
  return { paper: 'A4', title: 'Nota test page', body };
}
