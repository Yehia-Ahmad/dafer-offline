// Stage 23: the "اطبع صفحة تجربة" pages: one for the 80mm receipt printer, one for the A4/A5 printer.

import { barcodeSvg } from '../barcode';
import { escapeHtml, formatDateTime, formatMoney } from '../print-format';
import { PrintContext, PrintDocument, a4Header, a4Page, pick, receiptHeader, receiptOffset, receiptPage, receiptRow, receiptWidth } from '../print-kit';

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

// Stage 25: the receipt printer calibration sheet. Print it, hold it up against a ruler: the printed ruler must read 0 to 80 mm exactly (a printer
// that scales the page shows it shorter/longer), the dashed boxes show which of 72 / 76 / 80 mm the printer really prints without clipping the
// edges, and the box of the CURRENT setting must have equal margins left and right (if not, set the offset). Then the text, the barcode, a long
// item line and the cut line show what a real receipt will look like on this printer.

/** A ruler 80mm wide (1 unit of the viewBox = 1 mm): a tick every millimetre, longer every 5 and 10, labelled every 10, with the 72/76/80 width boxes. */
export function rulerSvg(): string {
  const ticks: string[] = [];
  for (let mm = 0; mm <= 80; mm += 1) {
    const length = mm % 10 === 0 ? 8 : mm % 5 === 0 ? 5.5 : 3;
    ticks.push(`<line x1="${mm}" y1="9" x2="${mm}" y2="${9 + length}" stroke="#000" stroke-width="${mm % 10 === 0 ? 0.3 : 0.15}"/>`);
    if (mm % 10 === 0) ticks.push(`<text x="${mm === 0 ? 0.4 : mm === 80 ? 79.6 : mm}" y="22" font-size="3" text-anchor="${mm === 0 ? 'start' : mm === 80 ? 'end' : 'middle'}" font-family="Arial, sans-serif">${mm}</text>`);
  }
  const boxes = [72, 76, 80].map((width, index) => {
    const x = (80 - width) / 2;
    return `<rect x="${x + 0.1}" y="${0.2 + index * 2.6}" width="${width - 0.2}" height="2.4" fill="none" stroke="#000" stroke-width="0.2" stroke-dasharray="1 0.6"/><text x="${x + 0.9}" y="${2.1 + index * 2.6}" font-size="1.9" font-family="Arial, sans-serif">${width}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 24" width="80mm" height="24mm" style="display:block" data-ruler>${boxes.join('')}${ticks.join('')}</svg>`;
}

export function receiptCalibrationPage(ctx: PrintContext, printerName: string): PrintDocument {
  const width = receiptWidth(ctx);
  const offset = receiptOffset(ctx);
  // The ruler is the PAPER (0 to 80 mm from its left edge), so it is placed from the page's left edge whatever width/offset are set.
  const ruler = `<div style="position:relative;height:26mm"><div style="position:absolute;top:0;left:calc((80mm - var(--receipt-w)) / -2 - var(--receipt-offset));width:80mm">${rulerSvg()}</div></div>`;
  const current = `<div style="margin-inline:-15px;border:0.3mm solid #000;padding:1mm 2mm;font-size:11px;text-align:center" data-current-width>${pick(ctx, 'العرض الحالي', 'Current width')}: <span class="n">${width}</span> mm · ${pick(ctx, 'الإزاحة', 'Offset')}: <span class="n" dir="ltr">${offset > 0 ? '+' : ''}${offset}</span> mm</div>`;
  const body = `${receiptHeader(ctx)}
  <div class="center" style="font-size:15px;font-weight:800" data-title>${pick(ctx, 'ورقة معايرة طابعة الإيصالات', 'Receipt printer calibration')}</div>
  ${receiptRow(pick(ctx, 'الطابعة', 'Printer'), escapeHtml(printerName || pick(ctx, 'الافتراضية', 'Default')))}
  ${receiptRow(pick(ctx, 'التاريخ', 'Date'), escapeHtml(formatDateTime(ctx.printedAt, ctx.lang)))}
  <div class="dash"></div>
  <div class="fine" style="text-align:start">${pick(ctx, 'المسطرة بالمليمتر: يجب أن تقرأ من 0 إلى 80 بالضبط. المربعات المنقطة 72 و 76 و 80: اختر أكبر مربع تظهر حدوده كاملة.', 'Ruler in millimetres: it must read 0 to 80 exactly. The dashed boxes 72, 76 and 80: pick the widest one whose edges print in full.')}</div>
  ${ruler}
  ${current}
  <div class="fine" style="text-align:start;margin-top:3px">${pick(ctx, 'إن كان هامش الصندوق الأيمن والأيسر غير متساويين فاضبط الإزاحة في الإعدادات.', 'If the left and right margins of that box differ, set the offset in Settings.')}</div>
  <div class="dash"></div>
  <div data-sample-ar style="text-align:start">مرحباً بكم في المحل — إيصال تجريبي: ٠١٢٣٤٥٦٧٨٩ جنيه</div>
  <div data-sample-en dir="ltr" style="text-align:start">Welcome — sample receipt: 0123456789 EGP</div>
  <div class="barcode" data-barcode>${barcodeSvg('CAL-000001')}</div>
  <div class="fine code n" style="align-self:center">CAL-000001</div>
  <div class="solid"></div>
  ${receiptRow(pick(ctx, 'صنف باسم طويل جداً جداً لاختبار التفاف السطر على أكثر من سطر في الإيصال', 'An item with a very long name to test how a line wraps over several lines on the receipt'), formatMoney(1234.5, ctx.lang), 'data-long-item')}
  ${receiptRow(pick(ctx, 'الإجمالي', 'Total'), formatMoney(1234.5, ctx.lang))}
  <div class="dash"></div>
  <div class="center" style="font-size:12px;letter-spacing:1px" data-cut-line>✂ - - - - - ${pick(ctx, 'قص هنا', 'CUT HERE')} - - - - - ✂</div>
  <div style="height:8mm"></div>`;
  return { paper: '80mm', title: 'Nota receipt calibration', body: receiptPage(body) };
}
