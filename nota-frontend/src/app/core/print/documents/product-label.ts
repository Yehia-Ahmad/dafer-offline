// Stage 26: PrProductLabel, the product barcode sticker. A pure render in the Stage 23 pipeline: real text, offline
// fonts, light palette, RTL/LTR by the UI language. Two layouts:
//   * roll  : a label printer, one label per page (@page = the label size, plus the gap as extra feed);
//   * sheet : A4 sticker sheets, an absolute grid with "start at label N", plus an outline test sheet.
// Labels are not numbered documents: no copy counter, no audit. The input type is a NARROW LabelItem built by
// toLabelItem() (explicit field picking), so purchase price / profit can never reach a label.

import { barcodeBits, barcodeSvgMm } from '../barcode';
import {
  LABEL_PADDING_MM,
  LabelOptions,
  LabelRollSettings,
  LabelSheetSettings,
  MAX_LABELS_PER_JOB,
  barcodeSizing,
  clampStartAt,
  labelsPerSheet,
  normalizeLabelOptions,
  normalizeRoll,
  normalizeSheet,
  sheetCell,
} from '../label-layout';
import { escapeHtml, formatMoney } from '../print-format';
import { PrintContext, PrintDocument, pick } from '../print-kit';

/** Exactly what a label may show of a product. No cost, no profit, no stock. */
export interface LabelItem {
  name: string;
  /** The shop's internal code. */
  code: string;
  /** The product's first barcode (what the label encodes). */
  barcode: string;
  retailPrice: number | null;
  wholesalePrice: number | null;
  priceAfterDiscount: number | null;
  vatExempt: boolean;
}

/** The shop's VAT display rule (Stage 21): inclusive prices say so, exclusive ones say VAT is added on top. */
export interface LabelVat {
  enabled: boolean;
  rate: number;
  pricesIncludeVat: boolean;
}

export interface LabelEntry {
  item: LabelItem;
  copies: number;
}

/** Picks the label fields of a product (or any product-like object); everything else is dropped on purpose. */
export function toLabelItem(product: {
  name?: unknown; code?: unknown; barcodes?: unknown; retailPrice?: unknown; wholesalePrice?: unknown; priceAfterDiscount?: unknown; discountPercentage?: unknown; vatExempt?: unknown;
}): LabelItem {
  const money = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const retail = money(product.retailPrice);
  const discount = money(product.discountPercentage) ?? 0;
  const discounted = money(product.priceAfterDiscount) ?? (retail === null ? null : Math.round(retail * (1 - discount / 100) * 100) / 100);
  return {
    name: String(product.name ?? ''),
    code: String(product.code ?? ''),
    barcode: Array.isArray(product.barcodes) && typeof product.barcodes[0] === 'string' ? product.barcodes[0] : '',
    retailPrice: retail,
    wholesalePrice: money(product.wholesalePrice),
    priceAfterDiscount: discounted,
    vatExempt: product.vatExempt === true,
  };
}

/** Whole copies, 0 .. MAX_LABELS_PER_JOB (a bad value counts as 0). */
const wholeCopies = (value: unknown): number => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(MAX_LABELS_PER_JOB + 1, Math.max(0, number)) : 0;
};

export interface LabelJob {
  /** Entries with a barcode and at least one copy; each with its clamped copies. */
  entries: LabelEntry[];
  /** Total labels. */
  total: number;
  /** More than MAX_LABELS_PER_JOB: the dialog refuses to print and says so. */
  tooMany: boolean;
  /** Products skipped because they have no barcode (name + code). */
  skipped: Array<{ name: string; code: string }>;
}

/** The labels of a job: products with no barcode are skipped (and reported), the total is checked against the 2,000 limit. */
export function planLabelJob(entries: LabelEntry[]): LabelJob {
  const kept: LabelEntry[] = [];
  const skipped: Array<{ name: string; code: string }> = [];
  let total = 0;
  for (const entry of entries) {
    const copies = wholeCopies(entry.copies);
    if (copies < 1) continue;
    if (!entry.item.barcode) {
      skipped.push({ name: entry.item.name, code: entry.item.code });
      continue;
    }
    kept.push({ item: entry.item, copies });
    total += copies;
  }
  return { entries: kept, total, tooMany: total > MAX_LABELS_PER_JOB, skipped };
}

/** Splits an already planned roll job without expanding thousands of duplicate item objects. */
export function batchLabelEntries(entries: LabelEntry[], size = 200): LabelEntry[][] {
  const batches: LabelEntry[][] = [];
  let current: LabelEntry[] = [];
  let remaining = Math.max(1, Math.floor(size));
  for (const entry of entries) {
    let copies = entry.copies;
    while (copies > 0) {
      const take = Math.min(copies, remaining);
      current.push({ item: entry.item, copies: take });
      copies -= take;
      remaining -= take;
      if (remaining === 0) {
        batches.push(current);
        current = [];
        remaining = Math.max(1, Math.floor(size));
      }
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/** The 2,000-label limit as an error, for callers that build the document directly. */
export class LabelLimitError extends Error {
  constructor(readonly total: number) {
    super(`LABEL_LIMIT:${total}`);
  }
}

const flatten = (entries: LabelEntry[]): LabelItem[] => entries.flatMap((entry) => Array.from({ length: entry.copies }, () => entry.item));

// ---------------------------------------------------------------- one label

/** The price shown on the label (the stored selling price, never a cost), '' for "none" or a missing price. */
export function labelPriceText(ctx: Pick<PrintContext, 'lang'>, item: LabelItem, options: Pick<LabelOptions, 'price'>, vat: LabelVat | null | undefined): { price: string; note: string } {
  const value = options.price === 'retail' ? item.retailPrice : options.price === 'wholesale' ? item.wholesalePrice : options.price === 'discounted' ? item.priceAfterDiscount : null;
  if (options.price === 'none' || value === null) return { price: '', note: '' };
  const price = `${formatMoney(value, ctx.lang)} ${pick(ctx, 'ج.م', 'EGP')}`;
  let note = '';
  if (vat && vat.enabled && !item.vatExempt) {
    const rate = Number.isFinite(vat.rate) ? vat.rate : 0;
    note = vat.pricesIncludeVat ? pick(ctx, 'شامل الضريبة', 'incl. VAT') : `${pick(ctx, '+ ض.ق.م', '+ VAT')} ${formatMoney(rate, ctx.lang).replace(/[.,٫]00$/, '')}%`;
  }
  return { price, note };
}

interface LabelBox {
  widthMm: number;
  heightMm: number;
}

/** Text heights (mm) used to give the barcode the rest of the label. */
const SHOP_MM = 2.5;
const NAME_MM = 5.9;
const PRICE_MM = 3.3;
const DIGITS_MM = 2.7;

function labelHtml(ctx: PrintContext, item: LabelItem, box: LabelBox, options: LabelOptions, vat: LabelVat | null): string {
  const innerWidth = box.widthMm - 2 * LABEL_PADDING_MM;
  const sizing = barcodeSizing(item.barcode, innerWidth, options.target);
  const shop = options.shopName && ctx.shop?.name ? ctx.shop.name : '';
  const { price, note } = labelPriceText(ctx, item, options, vat);
  const showCode = options.internalCode && item.code;
  const used = (shop ? SHOP_MM : 0) + NAME_MM + (price || showCode ? PRICE_MM : 0) + DIGITS_MM;
  const barHeight = Math.round(Math.min(14, Math.max(5, box.heightMm - 2 * LABEL_PADDING_MM - used)) * 100) / 100;
  const svg = sizing ? barcodeSvgMm(item.barcode, { moduleMm: sizing.moduleMm, heightMm: barHeight }) : '';
  const warn = sizing?.tooSmall ? ' data-too-small="1"' : '';
  return `<div class="lb" style="width:${box.widthMm}mm;height:${box.heightMm}mm" data-label${warn}>
  ${shop ? `<div class="lb-shop">${escapeHtml(shop)}</div>` : ''}
  <div class="lb-name" data-name>${escapeHtml(item.name)}</div>
  ${price || showCode ? `<div class="lb-row">${price ? `<span class="lb-price" data-price>${price}${note ? ` <small>${escapeHtml(note)}</small>` : ''}</span>` : '<span></span>'}${showCode ? `<span class="lb-code code" data-code>${escapeHtml(item.code)}</span>` : ''}</div>` : ''}
  <div class="lb-bars" data-bars>${svg}</div>
  <div class="lb-digits code" data-digits>${escapeHtml(item.barcode)}</div>
</div>`;
}

const LABEL_CSS = `
.lb { position: relative; overflow: hidden; padding: ${LABEL_PADDING_MM}mm; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; gap: 0.2mm; font-size: 6.5pt; line-height: 1.15; background: #FFFFFF; color: #000000; }
.lb-shop { font-size: 5.5pt; color: #000000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; font-weight: 600; }
.lb-name { font-size: 7pt; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; overflow-wrap: anywhere; text-align: center; max-height: 5.4mm; }
.lb-row { display: flex; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 1mm; }
.lb-price { font-size: 8pt; font-weight: 800; white-space: nowrap; }
.lb-price small { font-size: 5pt; font-weight: 600; }
.lb-code { font-size: 5.5pt; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-bars { display: flex; justify-content: center; align-items: flex-start; line-height: 0; }
.lb-bars svg { display: block; }
.lb-digits { align-self: center; font-size: 6pt; letter-spacing: 0.3pt; line-height: 1; font-variant-numeric: tabular-nums; }
body[data-paper="label"] .lb { page-break-after: always; break-after: page; }
body[data-paper="label"] .lb:last-child { page-break-after: auto; break-after: auto; }
.sheet { position: relative; width: 210mm; height: 297mm; overflow: hidden; page-break-after: always; break-after: page; }
.sheet:last-child { page-break-after: auto; break-after: auto; }
.cell { position: absolute; overflow: hidden; }
.cell.outline { border: 0.2mm solid #000000; font-size: 6pt; color: #4A5856; display: flex; align-items: center; justify-content: center; }
`;

// ---------------------------------------------------------------- roll

/** One sticker per page. Page = label width × (label height + gap); calibration offsets shift the print. */
export function productLabelRoll(
  ctx: PrintContext,
  entries: LabelEntry[],
  settings: { roll: LabelRollSettings; options: LabelOptions; vat?: LabelVat | null }
): PrintDocument {
  const roll = normalizeRoll(settings.roll);
  const options = { ...normalizeLabelOptions(settings.options), target: 'roll' as const };
  const job = planLabelJob(entries);
  if (job.tooMany) throw new LabelLimitError(job.total);
  const box = { widthMm: roll.widthMm, heightMm: roll.heightMm };
  // The offset shifts the content inside its page; the gap is extra feed under the label (the page is taller).
  const shift = `transform: translate(${roll.offsetXmm}mm, ${roll.offsetYmm}mm);`;
  const body = flatten(job.entries).map((item) => `<div class="lb-page" style="width:${roll.widthMm}mm;height:${roll.heightMm + roll.gapMm}mm;overflow:hidden;page-break-after:always;break-after:page"><div style="${shift}">${labelHtml(ctx, item, box, options, settings.vat ?? null)}</div></div>`).join('\n');
  return {
    paper: 'label',
    title: pick(ctx, 'ملصقات المنتجات', 'Product labels'),
    body,
    labelPage: { widthMm: roll.widthMm, heightMm: roll.heightMm + roll.gapMm },
    css: `${LABEL_CSS}\n.lb-page:last-child { page-break-after: auto !important; break-after: auto !important; }`,
  };
}

// ---------------------------------------------------------------- A4 sheet

/**
 * A4 sticker sheet(s): an absolute grid. "Start at label N" leaves the first N-1 cells of the FIRST sheet empty
 * (a partly used sheet). `outline` draws only the label borders (the alignment test on plain paper).
 */
export function productLabelSheet(
  ctx: PrintContext,
  entries: LabelEntry[],
  settings: { sheet: LabelSheetSettings; options: LabelOptions; startAt?: number; vat?: LabelVat | null; outline?: boolean }
): PrintDocument {
  const sheet = normalizeSheet(settings.sheet);
  const options = { ...normalizeLabelOptions(settings.options), target: 'sheet' as const };
  const perSheet = labelsPerSheet(sheet);
  const startAt = clampStartAt(settings.startAt ?? 1, sheet);
  const box = { widthMm: sheet.labelWidthMm, heightMm: sheet.labelHeightMm };
  let cells: Array<{ index: number; html: string }>; // index = position on the sheet sequence
  if (settings.outline) {
    cells = Array.from({ length: perSheet }, (_, index) => ({ index, html: String(index + 1) }));
  } else {
    const job = planLabelJob(entries);
    if (job.tooMany) throw new LabelLimitError(job.total);
    cells = flatten(job.entries).map((item, offset) => ({ index: startAt - 1 + offset, html: labelHtml(ctx, item, box, options, settings.vat ?? null) }));
  }
  const pages = Math.max(1, Math.ceil(((cells.length ? cells[cells.length - 1].index : 0) + 1) / perSheet));
  const out: string[] = [];
  for (let page = 0; page < pages; page += 1) {
    const inPage = cells.filter((cell) => Math.floor(cell.index / perSheet) === page);
    const html = inPage.map((cell) => {
      const { xMm, yMm } = sheetCell(sheet, cell.index % perSheet);
      return `<div class="cell${settings.outline ? ' outline' : ''}" style="left:${xMm}mm;top:${yMm}mm;width:${sheet.labelWidthMm}mm;height:${sheet.labelHeightMm}mm">${cell.html}</div>`;
    }).join('');
    out.push(`<div class="sheet" data-sheet>${html}</div>`);
  }
  return {
    paper: 'A4',
    title: settings.outline ? pick(ctx, 'ورقة اختبار حدود الملصقات', 'Label outline test sheet') : pick(ctx, 'ملصقات المنتجات', 'Product labels'),
    body: out.join('\n'),
    fullBleed: true,
    css: LABEL_CSS,
  };
}

/** A label that cannot be encoded (never happens for validated barcodes) is reported by the dialog before printing. */
export const canEncode = (barcode: string): boolean => barcodeBits(barcode) !== null;
