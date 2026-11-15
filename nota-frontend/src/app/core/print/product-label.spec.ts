// Stage 26: PrProductLabel. Each content option on/off, the symbology (EAN-13 vs Code 128), the label-roll page size per
// preset and custom, the A4 grid per preset and custom, "start at label N", the 2,000 limit, long names, RTL/LTR,
// no cost ever, and every setting clamped (numbers only, no CSS injection).

import { barcodeBits, barcodeSvgMm, chooseSymbology } from './barcode';
import { LabelLimitError, LabelItem, batchLabelEntries, planLabelJob, productLabelRoll, productLabelSheet, toLabelItem, labelPriceText } from './documents/product-label';
import {
  DEFAULT_LABEL_OPTIONS, LabelOptions, MAX_LABELS_PER_JOB, ROLL_PRESETS, SHEET_PRESETS, barcodeSizing, clampStartAt, labelsPerSheet,
  normalizeLabelOptions, normalizeRoll, normalizeSheet, sheetCell, sheetPages,
} from './label-layout';
import { PrintContext, PrintDocument, buildPrintHtml } from './print-kit';

const SHOP = { name: 'النور للأدوات الكهربائية', address: '', phones: [], logo: '', taxNumber: '', commercialRegister: '', invoiceFooter: '' };
const ctxOf = (lang: 'ar' | 'en' = 'ar', shop: PrintContext['shop'] = SHOP): PrintContext => ({ lang, shop, printedBy: 'محمود', printedAt: new Date(2026, 10, 5, 12, 40), fontCss: '', copy: null });
const item = (extra: Partial<LabelItem> = {}): LabelItem => ({ name: 'لمبة LED ٩ وات', code: 'LED-9', barcode: '4006381333931', retailPrice: 45, wholesalePrice: 35, priceAfterDiscount: 40.5, vatExempt: false, ...extra });
const options = (extra: Partial<LabelOptions> = {}): LabelOptions => ({ ...DEFAULT_LABEL_OPTIONS, ...extra });
const html = (doc: PrintDocument, ctx = ctxOf()): string => buildPrintHtml(ctx, doc);
const roll = (entries: Array<{ item: LabelItem; copies: number }>, rollSettings: unknown = {}, opts: Partial<LabelOptions> = {}, ctx = ctxOf(), vat = null as { enabled: boolean; rate: number; pricesIncludeVat: boolean } | null) =>
  productLabelRoll(ctx, entries, { roll: normalizeRoll(rollSettings), options: options(opts), vat });
const cells = (page: string): Array<{ x: number; y: number }> =>
  [...page.matchAll(/class="cell[^"]*" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm;height:([\d.]+)mm"/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('label barcodes', () => {
  it('EAN-13 / EAN-8 / UPC-A when valid, otherwise Code 128', () => {
    expect(chooseSymbology('4006381333931')).toBe('EAN-13');
    expect(chooseSymbology('96385074')).toBe('EAN-8');
    expect(chooseSymbology('036000291452')).toBe('UPC-A');
    expect(chooseSymbology('4006381333932')).toBe('Code 128'); // wrong check digit
    expect(chooseSymbology('ABC-123')).toBe('Code 128');
    expect(chooseSymbology('INV-000125')).toBe('Code 128');
  });

  it('the bars have the standard widths: EAN-13 95 modules, EAN-8 67, UPC-A 95, guard bars at both ends', () => {
    const ean13 = barcodeBits('4006381333931');
    expect(ean13?.symbology).toBe('EAN-13');
    expect(ean13?.bits.length).toBe(95);
    expect(ean13?.bits.startsWith('101')).toBeTrue();
    expect(ean13?.bits.endsWith('101')).toBeTrue();
    expect(ean13?.bits.slice(45, 50)).toBe('01010'); // the centre guard
    expect(barcodeBits('96385074')?.bits.length).toBe(67);
    expect(barcodeBits('036000291452')?.bits.length).toBe(95);
    const code128 = barcodeBits('INV-000125');
    expect(code128?.symbology).toBe('Code 128');
    expect(code128?.bits.endsWith('1100011101011')).toBeTrue(); // the stop pattern
    expect(barcodeBits('')).toBeNull();
  });

  it('the SVG is in real millimetres: width = (modules + quiet zones) × module, and says its symbology', () => {
    const svg = barcodeSvgMm('4006381333931', { moduleMm: 0.25, heightMm: 9 });
    expect(svg).toContain('data-symbology="EAN-13"');
    expect(svg).toContain('width="28.250mm"'); // (95 + 11 + 7) × 0.25
    expect(svg).toContain('height="9mm"');
    expect(svg).toContain('data-barcode="4006381333931"');
    expect(barcodeSvgMm('INV-000125', { moduleMm: 0.25, heightMm: 9 })).toContain('data-symbology="Code 128"');
    expect(barcodeSvgMm('', { moduleMm: 0.25, heightMm: 9 })).toBe('');
  });

  it('bar sizes: thermal labels use whole 203-dpi dots (2 or 3), sheets 0.33 mm down to 0.26 mm; EAN-13 on 38 mm uses 0.25 mm', () => {
    const small = barcodeSizing('4006381333931', 36, 'roll');
    expect(small?.moduleMm).toBe(0.25);
    expect(small?.widthMm).toBe(28.25);
    expect(small?.tooSmall).toBeFalse();
    expect(barcodeSizing('4006381333931', 56, 'roll')?.moduleMm).toBe(0.375); // 58 mm label: 3 dots
    expect(barcodeSizing('4006381333931', 68, 'sheet')?.moduleMm).toBe(0.33); // 70 mm sheet label
    expect(barcodeSizing('4006381333931', 36.1, 'sheet')?.moduleMm).toBe(0.319); // between 0.33 and 0.26: shrinks continuously
    // A long Code 128 on a small label shrinks below 2 dots and is flagged when even 0.19 mm does not fit.
    const long = barcodeSizing('SKU-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789', 36, 'roll');
    expect(long?.tooSmall).toBeTrue();
    expect(barcodeSizing('', 36, 'roll')).toBeNull();
  });
});

describe('label content options', () => {
  it('product name and barcode digits are always there; the barcode is drawn', () => {
    const page = html(roll([{ item: item(), copies: 1 }], {}, { shopName: false, internalCode: false, price: 'none' }));
    expect(page).toContain('data-name');
    expect(page).toContain('لمبة LED ٩ وات');
    expect(page).toContain('data-digits');
    expect(page).toContain('>4006381333931<');
    expect(page).toContain('data-bars');
    expect(page).toContain('<svg');
  });

  it('shop name on / off', () => {
    expect(html(roll([{ item: item(), copies: 1 }], {}, { shopName: true }))).toContain('النور للأدوات الكهربائية');
    expect(html(roll([{ item: item(), copies: 1 }], {}, { shopName: false }))).not.toContain('النور للأدوات الكهربائية');
    // A shop without a name has no shop line even when it is on.
    expect(html(roll([{ item: item(), copies: 1 }], {}, { shopName: true }, ctxOf('ar', null)))).not.toContain('lb-shop"');
  });

  it('internal code on / off', () => {
    expect(html(roll([{ item: item(), copies: 1 }], {}, { internalCode: true }))).toContain('data-code>LED-9<');
    expect(html(roll([{ item: item(), copies: 1 }], {}, { internalCode: false }))).not.toContain('data-code');
  });

  it('price: retail (default), wholesale, after discount, or none: always a stored selling price', () => {
    const only = (price: LabelOptions['price']): string => html(roll([{ item: item(), copies: 1 }], {}, { price }, ctxOf('en')));
    expect(only('retail')).toContain('45.00 EGP');
    expect(only('wholesale')).toContain('35.00 EGP');
    expect(only('discounted')).toContain('40.50 EGP');
    expect(only('none')).not.toContain('data-price');
    expect(DEFAULT_LABEL_OPTIONS.price).toBe('retail');
    // A product with no such price prints no price instead of 0.
    expect(html(roll([{ item: item({ wholesalePrice: null }), copies: 1 }], {}, { price: 'wholesale' }))).not.toContain('data-price');
  });

  it('prices follow the VAT display rule: "شامل الضريبة", "+ ض.ق.م 14%", nothing for an exempt product or VAT off', () => {
    const en = ctxOf('en');
    expect(labelPriceText(en, item(), { price: 'retail' }, { enabled: true, rate: 14, pricesIncludeVat: true }).note).toBe('incl. VAT');
    expect(labelPriceText(en, item(), { price: 'retail' }, { enabled: true, rate: 14, pricesIncludeVat: false }).note).toBe('+ VAT 14%');
    expect(labelPriceText(ctxOf('ar'), item(), { price: 'retail' }, { enabled: true, rate: 14, pricesIncludeVat: true }).note).toBe('شامل الضريبة');
    expect(labelPriceText(en, item({ vatExempt: true }), { price: 'retail' }, { enabled: true, rate: 14, pricesIncludeVat: true }).note).toBe('');
    expect(labelPriceText(en, item(), { price: 'retail' }, { enabled: false, rate: 14, pricesIncludeVat: true }).note).toBe('');
    expect(labelPriceText(en, item(), { price: 'retail' }, null).note).toBe('');
    expect(labelPriceText(en, item(), { price: 'none' }, { enabled: true, rate: 14, pricesIncludeVat: true })).toEqual({ price: '', note: '' });
    expect(html(roll([{ item: item(), copies: 1 }], {}, {}, ctxOf('en'), { enabled: true, rate: 14, pricesIncludeVat: true }))).toContain('incl. VAT');
  });

  it('the symbology follows the barcode: EAN-13 for a valid one, Code 128 otherwise', () => {
    expect(html(roll([{ item: item({ barcode: '4006381333931' }), copies: 1 }]))).toContain('data-symbology="EAN-13"');
    expect(html(roll([{ item: item({ barcode: 'SKU-77' }), copies: 1 }]))).toContain('data-symbology="Code 128"');
    expect(html(roll([{ item: item({ barcode: '4006381333932' }), copies: 1 }]))).toContain('data-symbology="Code 128"');
  });

  it('a long name wraps to two lines and then an ellipsis (CSS), the full text stays real text', () => {
    const name = 'كابل كهرباء نحاس خالص مقاس ٣ في ٢٫٥ ملم عزل مزدوج مقاوم للحرارة والرطوبة لفة ١٠٠ متر';
    const page = html(roll([{ item: item({ name }), copies: 1 }]));
    expect(page).toContain(name);
    expect(page).toContain('-webkit-line-clamp: 2');
    expect(page).toContain('text-overflow: ellipsis');
  });

  it('names are escaped (no HTML from a product name)', () => {
    const page = html(roll([{ item: item({ name: '<img src=x onerror=alert(1)>"&' }), copies: 1 }]));
    expect(page).not.toContain('<img');
    expect(page).toContain('&lt;img');
  });

  it('RTL for Arabic, LTR for English', () => {
    expect(html(roll([{ item: item(), copies: 1 }]), ctxOf('ar'))).toContain('dir="rtl"');
    expect(html(roll([{ item: item(), copies: 1 }]), ctxOf('en'))).toContain('dir="ltr"');
  });

  it('light palette, offline: no external URL, no network font', () => {
    const page = html(roll([{ item: item(), copies: 1 }]));
    expect(page.replace(/xmlns="[^"]*"/g, '')).not.toMatch(/https?:\/\//); // the SVG namespace is not a request
    expect(page).toContain('Content-Security-Policy');
    expect(page).toContain('color-scheme: light');
  });
});

describe('no cost, ever', () => {
  const product = { name: 'منتج', code: 'P1', barcodes: ['4006381333931', 'X-2'], retailPrice: 50, wholesalePrice: 40, purchasePrice: 31.37, discountPercentage: 10, profit: 18.63, totalProfit: 99, inventoryCount: 12 };

  it('toLabelItem keeps only what a label shows', () => {
    const label = toLabelItem(product);
    expect(Object.keys(label).sort()).toEqual(['barcode', 'code', 'name', 'priceAfterDiscount', 'retailPrice', 'vatExempt', 'wholesalePrice']);
    expect(label.barcode).toBe('4006381333931'); // the first barcode
    expect(label.priceAfterDiscount).toBe(45); // computed from the retail price when the API did not send it
    expect(JSON.stringify(label)).not.toContain('31.37');
  });

  it('no printed label contains the purchase price, profit or stock, on any price option', () => {
    for (const price of ['retail', 'wholesale', 'discounted', 'none'] as const) {
      const page = html(roll([{ item: toLabelItem(product), copies: 2 }], {}, { price, internalCode: true }));
      expect(page).not.toContain('31.37');
      expect(page).not.toContain('18.63');
      expect(page).not.toContain('99.00');
      expect(page).not.toContain('purchasePrice');
    }
  });

  it('a product without a barcode gives an empty barcode (the dialog skips it)', () => {
    expect(toLabelItem({ name: 'x', code: 'y', retailPrice: 1 }).barcode).toBe('');
    expect(toLabelItem({ name: 'x', code: 'y', barcodes: [] }).barcode).toBe('');
  });
});

describe('label roll (a label printer)', () => {
  it('one label per page; @page = the label size for every preset', () => {
    for (const [key, size] of Object.entries(ROLL_PRESETS)) {
      const doc = roll([{ item: item(), copies: 3 }], { preset: key });
      expect(doc.paper).toBe('label');
      expect(doc.labelPage).toEqual({ widthMm: size.widthMm, heightMm: size.heightMm });
      const page = html(doc);
      expect(page).toContain(`@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`);
      expect(count(page, 'data-label')).toBe(3);
      expect(count(page, 'class="lb-page"')).toBe(3);
    }
  });

  it('a custom size, clamped; the gap is extra feed under each label; offsets shift the print', () => {
    const doc = roll([{ item: item(), copies: 1 }], { preset: 'custom', widthMm: 45, heightMm: 32.5, gapMm: 3, offsetXmm: 1.5, offsetYmm: -2 });
    expect(doc.labelPage).toEqual({ widthMm: 45, heightMm: 35.5 });
    const page = html(doc);
    expect(page).toContain('@page { size: 45mm 35.5mm; margin: 0; }');
    expect(page).toContain('transform: translate(1.5mm, -2mm);');
  });

  it('every setting is clamped: sizes, offsets, gap; text and objects fall back; nothing reaches the CSS as text', () => {
    const wild = normalizeRoll({ preset: 'custom', widthMm: 99999, heightMm: -4, offsetXmm: 500, offsetYmm: '-500', gapMm: 80 });
    expect(wild).toEqual({ preset: 'custom', widthMm: 110, heightMm: 15, offsetXmm: 5, offsetYmm: -5, gapMm: 10 });
    const junk = normalizeRoll({ preset: 'custom', widthMm: 'abc', heightMm: {}, offsetXmm: null, offsetYmm: NaN, gapMm: [] });
    expect(junk).toEqual({ preset: 'custom', widthMm: 38, heightMm: 25, offsetXmm: 0, offsetYmm: 0, gapMm: 0 });
    const injected = normalizeRoll({ preset: 'x;} body{display:none}', widthMm: '10;}*{x:y', offsetXmm: '1mm;color:red' });
    expect(injected.preset).toBe('38x25');
    expect(injected.offsetXmm).toBe(0);
    const page = html(roll([{ item: item(), copies: 1 }], { preset: 'custom', widthMm: '10;}*{x:y', heightMm: 'url(javascript:1)', offsetXmm: '1mm;color:red' }));
    expect(page).not.toContain('display:none');
    expect(page).not.toContain('javascript');
    expect(page).not.toContain('color:red');
    expect(normalizeRoll(null)).toEqual(normalizeRoll({}));
    expect(normalizeRoll({ offsetXmm: 0.7 }).offsetXmm).toBe(0.5); // half-millimetre steps
  });
});

describe('A4 sticker sheets', () => {
  it('the presets: 3×7 (21, 70×42.3), 3×8 (24, 70×37), 4×10 (40, 52.5×29.7), 5×13 (65, 38.1×21.2)', () => {
    expect([labelsPerSheet(normalizeSheet({ preset: '3x7' })), labelsPerSheet(normalizeSheet({ preset: '3x8' })), labelsPerSheet(normalizeSheet({ preset: '4x10' })), labelsPerSheet(normalizeSheet({ preset: '5x13' }))]).toEqual([21, 24, 40, 65]);
    expect(SHEET_PRESETS['3x7']).toEqual(jasmine.objectContaining({ labelWidthMm: 70, labelHeightMm: 42.3 }));
    expect(SHEET_PRESETS['3x8']).toEqual(jasmine.objectContaining({ labelWidthMm: 70, labelHeightMm: 37 }));
    expect(SHEET_PRESETS['4x10']).toEqual(jasmine.objectContaining({ labelWidthMm: 52.5, labelHeightMm: 29.7 }));
    expect(SHEET_PRESETS['5x13']).toEqual(jasmine.objectContaining({ labelWidthMm: 38.1, labelHeightMm: 21.2 }));
  });

  it('the grid of every preset: label count per page, positions of the first and last cells, all inside the A4 page', () => {
    for (const key of Object.keys(SHEET_PRESETS)) {
      const sheet = normalizeSheet({ preset: key });
      const perSheet = labelsPerSheet(sheet);
      const doc = productLabelSheet(ctxOf(), [{ item: item(), copies: perSheet }], { sheet, options: options({ target: 'sheet' }) });
      expect(doc.paper).toBe('A4');
      expect(doc.fullBleed).toBeTrue();
      const page = html(doc);
      expect(page).toContain('@page { size: A4; margin: 0; }');
      const grid = cells(page);
      expect(grid.length).toBe(perSheet);
      expect(grid[0]).toEqual({ x: sheet.marginSideMm, y: sheet.marginTopMm });
      const last = grid[grid.length - 1];
      expect(last.x + sheet.labelWidthMm).toBeLessThanOrEqual(210.001);
      expect(last.y + sheet.labelHeightMm).toBeLessThanOrEqual(297.001);
      expect(count(page, 'data-sheet')).toBe(1);
    }
    const g38 = cells(html(productLabelSheet(ctxOf(), [{ item: item(), copies: 3 }], { sheet: normalizeSheet({ preset: '3x8' }), options: options({ target: 'sheet' }) })));
    expect(g38).toEqual([{ x: 0, y: 0.5 }, { x: 70, y: 0.5 }, { x: 140, y: 0.5 }]);
    const g513 = cells(html(productLabelSheet(ctxOf(), [{ item: item(), copies: 2 }], { sheet: normalizeSheet({ preset: '5x13' }), options: options({ target: 'sheet' }) })));
    expect(g513[0]).toEqual({ x: 4.75, y: 10.7 });
    expect(g513[1].x).toBeCloseTo(4.75 + 38.1 + 2.5, 3);
  });

  it('a custom grid: columns, rows, label size, margins and gaps', () => {
    const sheet = normalizeSheet({ preset: 'custom', columns: 2, rows: 3, labelWidthMm: 90, labelHeightMm: 60, marginTopMm: 12, marginSideMm: 10, gapXmm: 5, gapYmm: 4 });
    expect(sheet).toEqual({ preset: 'custom', columns: 2, rows: 3, labelWidthMm: 90, labelHeightMm: 60, marginTopMm: 12, marginSideMm: 10, gapXmm: 5, gapYmm: 4 });
    expect(sheetCell(sheet, 0)).toEqual({ xMm: 10, yMm: 12 });
    expect(sheetCell(sheet, 1)).toEqual({ xMm: 105, yMm: 12 });
    expect(sheetCell(sheet, 2)).toEqual({ xMm: 10, yMm: 76 });
    expect(sheetCell(sheet, 5)).toEqual({ xMm: 105, yMm: 140 });
    const grid = cells(html(productLabelSheet(ctxOf(), [{ item: item(), copies: 6 }], { sheet, options: options({ target: 'sheet' }) })));
    expect(grid.length).toBe(6);
    expect(grid[3]).toEqual({ x: 105, y: 76 });
  });

  it('a custom grid is clamped so it fits the page; junk and CSS text fall back', () => {
    const big = normalizeSheet({ preset: 'custom', columns: 99, rows: 99, labelWidthMm: 9999, labelHeightMm: 9999, marginTopMm: 999, marginSideMm: 999, gapXmm: 999, gapYmm: 999 });
    expect(big.columns).toBe(10);
    expect(big.rows).toBe(30);
    expect(big.marginTopMm).toBeLessThanOrEqual(50);
    expect(big.marginSideMm).toBeLessThanOrEqual(50);
    expect(big.gapXmm).toBeLessThanOrEqual(20);
    expect(big.gapYmm).toBeLessThanOrEqual(20);
    expect(big.marginSideMm * 2 + big.columns * big.labelWidthMm + (big.columns - 1) * big.gapXmm).toBeLessThanOrEqual(210.5);
    expect(big.marginTopMm * 2 + big.rows * big.labelHeightMm + (big.rows - 1) * big.gapYmm).toBeLessThanOrEqual(297.5);
    expect(normalizeSheet({ preset: 'custom', columns: 'x', rows: {}, labelWidthMm: 'url(x)' }).columns).toBe(3);
    expect(normalizeSheet({ preset: 'a;}b{c' }).preset).toBe('3x8');
    expect(normalizeSheet(undefined)).toEqual(normalizeSheet({ preset: '3x8' }));
  });

  it('"start at label N": the first N-1 cells of the first sheet stay empty; the rest follow and spill to the next sheet', () => {
    const sheet = normalizeSheet({ preset: '3x8' });
    const two = cells(html(productLabelSheet(ctxOf(), [{ item: item(), copies: 2 }], { sheet, options: options({ target: 'sheet' }), startAt: 5 })));
    expect(two).toEqual([{ x: 70, y: 37.5 }, { x: 140, y: 37.5 }]); // labels 5 and 6: row 2, columns 2 and 3
    // 24 labels from label 5: 20 fit on the first sheet, 4 go to a second one.
    const doc = productLabelSheet(ctxOf(), [{ item: item(), copies: 24 }], { sheet, options: options({ target: 'sheet' }), startAt: 5 });
    const page = html(doc);
    expect(count(page, 'data-sheet')).toBe(2);
    expect(count(page, 'data-label')).toBe(24);
    expect(sheetPages(sheet, 24, 5)).toBe(2);
    expect(sheetPages(sheet, 20, 5)).toBe(1);
    expect(sheetPages(sheet, 21, 5)).toBe(2);
    expect(sheetPages(sheet, 0, 5)).toBe(0);
    // The second sheet starts at its first cell.
    expect(cells(page).slice(20)).toEqual([{ x: 0, y: 0.5 }, { x: 70, y: 0.5 }, { x: 140, y: 0.5 }, { x: 0, y: 37.5 }]);
    // Start-at is clamped into the sheet.
    expect(clampStartAt(0, sheet)).toBe(1);
    expect(clampStartAt(99, sheet)).toBe(24);
    expect(clampStartAt('7', sheet)).toBe(7);
    expect(clampStartAt('abc', sheet)).toBe(1);
    expect(clampStartAt(3.7, sheet)).toBe(4);
  });

  it('the outline test sheet draws only the label borders and their numbers, no barcodes, for the whole grid', () => {
    const sheet = normalizeSheet({ preset: '3x8' });
    const doc = productLabelSheet(ctxOf(), [], { sheet, options: options({ target: 'sheet' }), outline: true });
    const page = html(doc);
    expect(doc.fullBleed).toBeTrue();
    expect(cells(page).length).toBe(24);
    expect(count(page, 'cell outline')).toBe(24);
    expect(page).not.toContain('<svg');
    expect(page).not.toContain('data-barcode');
    expect(page).toContain('border: 0.2mm solid');
  });
});

describe('the 2,000-labels limit', () => {
  it('exactly 2,000 is allowed; 2,001 is refused with the total; a roll and a sheet both refuse', () => {
    expect(MAX_LABELS_PER_JOB).toBe(2000);
    expect(planLabelJob([{ item: item(), copies: 2000 }]).tooMany).toBeFalse();
    const over = planLabelJob([{ item: item(), copies: 1500 }, { item: item({ code: 'B', barcode: 'B-1234' }), copies: 501 }]);
    expect(over.tooMany).toBeTrue();
    expect(over.total).toBe(2001);
    expect(() => roll([{ item: item(), copies: 2001 }])).toThrowError(LabelLimitError);
    expect(() => productLabelSheet(ctxOf(), [{ item: item(), copies: 2001 }], { sheet: normalizeSheet({}), options: options({ target: 'sheet' }) })).toThrowError(LabelLimitError);
    expect(() => roll([{ item: item(), copies: 2000 }])).not.toThrow();
  });

  it('a huge or junk quantity cannot slip through: copies are whole numbers, never negative', () => {
    expect(planLabelJob([{ item: item(), copies: 1e9 }]).tooMany).toBeTrue();
    expect(planLabelJob([{ item: item(), copies: -5 }]).total).toBe(0);
    expect(planLabelJob([{ item: item(), copies: NaN }]).total).toBe(0);
    expect(planLabelJob([{ item: item(), copies: 2.9 }]).total).toBe(2);
  });

  it('products without a barcode are skipped and reported, not printed', () => {
    const job = planLabelJob([{ item: item(), copies: 2 }, { item: item({ name: 'بدون', code: 'NB', barcode: '' }), copies: 3 }, { item: item({ code: 'Z', barcode: 'Z-1234' }), copies: 0 }]);
    expect(job.total).toBe(2);
    expect(job.entries.length).toBe(1);
    expect(job.skipped).toEqual([{ name: 'بدون', code: 'NB' }]);
  });

  it('roll jobs split into batches of at most 200 without losing product boundaries or copies', () => {
    const batches = batchLabelEntries([{ item: item({ code: 'A' }), copies: 250 }, { item: item({ code: 'B' }), copies: 175 }]);
    expect(batches.map((batch) => batch.reduce((sum, entry) => sum + entry.copies, 0))).toEqual([200, 200, 25]);
    expect(batches.flat().filter((entry) => entry.item.code === 'A').reduce((sum, entry) => sum + entry.copies, 0)).toBe(250);
    expect(batches.flat().filter((entry) => entry.item.code === 'B').reduce((sum, entry) => sum + entry.copies, 0)).toBe(175);
  });

  it('a 2,000-label roll job renders as 2,000 pages in well under a few seconds', () => {
    const started = performance.now();
    const doc = roll([{ item: item(), copies: 2000 }]);
    const page = html(doc);
    expect(count(page, 'data-label')).toBe(2000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('remembered content options', () => {
  it('are normalised: unknown values fall back to the defaults', () => {
    expect(normalizeLabelOptions(undefined)).toEqual(DEFAULT_LABEL_OPTIONS);
    expect(normalizeLabelOptions({ target: 'sheet', shopName: false, price: 'discounted', internalCode: true })).toEqual({ target: 'sheet', shopName: false, price: 'discounted', internalCode: true });
    expect(normalizeLabelOptions({ target: 'x', shopName: 'yes', price: 'cost', internalCode: 1 })).toEqual({ target: 'roll', shopName: true, price: 'retail', internalCode: false });
  });
});
