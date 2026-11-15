// Stage 26: product label geometry. Pure functions shared by the label document, the print dialog, the
// settings card and the tests. Every number is validated and clamped (numbers only, sane ranges), the same
// way the receipt width/offset is, and only numbers ever reach the CSS, so no setting can inject CSS.
// The desktop app normalises the stored settings with the same rules (electron-offline/lib/print-service.js).

import { barcodeModules, chooseSymbology, Symbology } from './barcode';

export type LabelRollPreset = '38x25' | '40x30' | '50x25' | '50x30' | '58x40' | 'custom';
export type LabelSheetPreset = '3x7' | '3x8' | '4x10' | '5x13' | 'custom';
export type LabelTarget = 'roll' | 'sheet';
export type LabelPrice = 'retail' | 'wholesale' | 'discounted' | 'none';

/** A roll of stickers on a label printer: one label per page. */
export interface LabelRollSettings {
  preset: LabelRollPreset;
  widthMm: number;
  heightMm: number;
  /** Calibration: + moves the print right / down. */
  offsetXmm: number;
  offsetYmm: number;
  /** Extra feed added to the page length (the space between two stickers on the roll). */
  gapMm: number;
}

/** An A4 sticker sheet on the A4/A5 printer. */
export interface LabelSheetSettings {
  preset: LabelSheetPreset;
  columns: number;
  rows: number;
  labelWidthMm: number;
  labelHeightMm: number;
  marginTopMm: number;
  marginSideMm: number;
  gapXmm: number;
  gapYmm: number;
}

/** What is printed on each label (chosen in the print dialog, remembered per device). */
export interface LabelOptions {
  target: LabelTarget;
  shopName: boolean;
  price: LabelPrice;
  internalCode: boolean;
}

export const ROLL_PRESETS: Record<Exclude<LabelRollPreset, 'custom'>, { widthMm: number; heightMm: number }> = {
  '38x25': { widthMm: 38, heightMm: 25 },
  '40x30': { widthMm: 40, heightMm: 30 },
  '50x25': { widthMm: 50, heightMm: 25 },
  '50x30': { widthMm: 50, heightMm: 30 },
  '58x40': { widthMm: 58, heightMm: 40 },
};

/** The common A4 sheets: 3×7 (21, 70×42.3), 3×8 (24, 70×37), 4×10 (40, 52.5×29.7), 5×13 (65, 38.1×21.2, the L7651 layout). */
export const SHEET_PRESETS: Record<Exclude<LabelSheetPreset, 'custom'>, Omit<LabelSheetSettings, 'preset'>> = {
  '3x7': { columns: 3, rows: 7, labelWidthMm: 70, labelHeightMm: 42.3, marginTopMm: 0.45, marginSideMm: 0, gapXmm: 0, gapYmm: 0 },
  '3x8': { columns: 3, rows: 8, labelWidthMm: 70, labelHeightMm: 37, marginTopMm: 0.5, marginSideMm: 0, gapXmm: 0, gapYmm: 0 },
  '4x10': { columns: 4, rows: 10, labelWidthMm: 52.5, labelHeightMm: 29.7, marginTopMm: 0, marginSideMm: 0, gapXmm: 0, gapYmm: 0 },
  '5x13': { columns: 5, rows: 13, labelWidthMm: 38.1, labelHeightMm: 21.2, marginTopMm: 10.7, marginSideMm: 4.75, gapXmm: 2.5, gapYmm: 0 },
};

export const A4 = { widthMm: 210, heightMm: 297 };
export const MAX_LABELS_PER_JOB = 2000;
export const ROLL_LIMITS = { widthMm: [20, 110], heightMm: [15, 150], offsetMm: [-5, 5], gapMm: [0, 10] } as const;
export const SHEET_LIMITS = { columns: [1, 10], rows: [1, 30], labelWidthMm: [10, 210], labelHeightMm: [8, 297], marginMm: [0, 50], gapMm: [0, 20] } as const;

export const DEFAULT_ROLL: LabelRollSettings = { preset: '38x25', widthMm: 38, heightMm: 25, offsetXmm: 0, offsetYmm: 0, gapMm: 0 };
export const DEFAULT_SHEET: LabelSheetSettings = { preset: '3x8', ...SHEET_PRESETS['3x8'] };
export const DEFAULT_LABEL_OPTIONS: LabelOptions = { target: 'roll', shopName: true, price: 'retail', internalCode: false };

/** A finite number clamped to [min, max] and rounded to `step`; anything else (text, NaN, objects) → `fallback`. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number, step = 0.01): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  const stepped = Number((Math.round(clamped / step) * step).toFixed(4));
  // Rounding to the step must not leave the range; never -0.
  return Math.min(max, Math.max(min, stepped)) || 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function normalizeRoll(raw: unknown): LabelRollSettings {
  const source = isRecord(raw) ? raw : {};
  const preset = (typeof source['preset'] === 'string' && (source['preset'] in ROLL_PRESETS || source['preset'] === 'custom') ? source['preset'] : DEFAULT_ROLL.preset) as LabelRollPreset;
  const size = preset === 'custom'
    ? { widthMm: clampNumber(source['widthMm'], ROLL_LIMITS.widthMm[0], ROLL_LIMITS.widthMm[1], DEFAULT_ROLL.widthMm, 0.5), heightMm: clampNumber(source['heightMm'], ROLL_LIMITS.heightMm[0], ROLL_LIMITS.heightMm[1], DEFAULT_ROLL.heightMm, 0.5) }
    : ROLL_PRESETS[preset];
  return {
    preset,
    ...size,
    offsetXmm: clampNumber(source['offsetXmm'], ROLL_LIMITS.offsetMm[0], ROLL_LIMITS.offsetMm[1], 0, 0.5),
    offsetYmm: clampNumber(source['offsetYmm'], ROLL_LIMITS.offsetMm[0], ROLL_LIMITS.offsetMm[1], 0, 0.5),
    gapMm: clampNumber(source['gapMm'], ROLL_LIMITS.gapMm[0], ROLL_LIMITS.gapMm[1], 0, 0.5),
  };
}

export function normalizeSheet(raw: unknown): LabelSheetSettings {
  const source = isRecord(raw) ? raw : {};
  const preset = (typeof source['preset'] === 'string' && (source['preset'] in SHEET_PRESETS || source['preset'] === 'custom') ? source['preset'] : DEFAULT_SHEET.preset) as LabelSheetPreset;
  if (preset !== 'custom') return { preset, ...SHEET_PRESETS[preset] };
  const base = SHEET_PRESETS['3x8'];
  const columns = clampNumber(source['columns'], SHEET_LIMITS.columns[0], SHEET_LIMITS.columns[1], base.columns, 1);
  const rows = clampNumber(source['rows'], SHEET_LIMITS.rows[0], SHEET_LIMITS.rows[1], base.rows, 1);
  // Margins and gaps are clamped to their ranges, then reduced until the smallest label (10 × 8 mm) still fits the page.
  const down = (value: number): number => Math.floor(value * 20) / 20;
  const minW = SHEET_LIMITS.labelWidthMm[0];
  const minH = 8;
  const marginSideMm = Math.min(clampNumber(source['marginSideMm'], SHEET_LIMITS.marginMm[0], SHEET_LIMITS.marginMm[1], 0, 0.05), down(Math.max(0, (A4.widthMm - columns * minW) / 2)));
  const marginTopMm = Math.min(clampNumber(source['marginTopMm'], SHEET_LIMITS.marginMm[0], SHEET_LIMITS.marginMm[1], 0, 0.05), down(Math.max(0, (A4.heightMm - rows * minH) / 2)));
  const gapXmm = columns > 1 ? Math.min(clampNumber(source['gapXmm'], SHEET_LIMITS.gapMm[0], SHEET_LIMITS.gapMm[1], 0, 0.05), down(Math.max(0, (A4.widthMm - 2 * marginSideMm - columns * minW) / (columns - 1)))) : 0;
  const gapYmm = rows > 1 ? Math.min(clampNumber(source['gapYmm'], SHEET_LIMITS.gapMm[0], SHEET_LIMITS.gapMm[1], 0, 0.05), down(Math.max(0, (A4.heightMm - 2 * marginTopMm - rows * minH) / (rows - 1)))) : 0;
  // The grid must fit the page: a label is never wider/taller than the space left for it.
  const maxWidth = Math.max(SHEET_LIMITS.labelWidthMm[0], (A4.widthMm - 2 * marginSideMm - (columns - 1) * gapXmm) / columns);
  const maxHeight = Math.max(SHEET_LIMITS.labelHeightMm[0], (A4.heightMm - 2 * marginTopMm - (rows - 1) * gapYmm) / rows);
  const labelWidthMm = clampNumber(source['labelWidthMm'], SHEET_LIMITS.labelWidthMm[0], Math.floor(maxWidth * 100) / 100, Math.min(base.labelWidthMm, maxWidth), 0.05);
  const labelHeightMm = clampNumber(source['labelHeightMm'], SHEET_LIMITS.labelHeightMm[0], Math.floor(maxHeight * 100) / 100, Math.min(base.labelHeightMm, maxHeight), 0.05);
  return { preset, columns, rows, labelWidthMm, labelHeightMm, marginTopMm, marginSideMm, gapXmm, gapYmm };
}

export function normalizeLabelOptions(raw: unknown): LabelOptions {
  const source = isRecord(raw) ? raw : {};
  const price = (['retail', 'wholesale', 'discounted', 'none'] as const).find((value) => value === source['price']) ?? DEFAULT_LABEL_OPTIONS.price;
  return {
    target: source['target'] === 'sheet' ? 'sheet' : 'roll',
    shopName: typeof source['shopName'] === 'boolean' ? source['shopName'] : DEFAULT_LABEL_OPTIONS.shopName,
    price,
    internalCode: source['internalCode'] === true,
  };
}

export const labelsPerSheet = (sheet: LabelSheetSettings): number => sheet.columns * sheet.rows;

/** "Start at label N": 1 .. labels per sheet (a partly used sheet is reused). */
export const clampStartAt = (value: unknown, sheet: LabelSheetSettings): number => clampNumber(value, 1, labelsPerSheet(sheet), 1, 1);

/** Top-left corner (mm) of cell `index` (0-based, row by row; RTL sheets are still filled from the physical top-left). */
export function sheetCell(sheet: LabelSheetSettings, index: number): { xMm: number; yMm: number } {
  const column = index % sheet.columns;
  const row = Math.floor(index / sheet.columns) % sheet.rows;
  return {
    xMm: Number((sheet.marginSideMm + column * (sheet.labelWidthMm + sheet.gapXmm)).toFixed(3)),
    yMm: Number((sheet.marginTopMm + row * (sheet.labelHeightMm + sheet.gapYmm)).toFixed(3)),
  };
}

/** How many A4 pages `count` labels need when the first sheet starts at label `startAt`. */
export const sheetPages = (sheet: LabelSheetSettings, count: number, startAt: number): number =>
  count <= 0 ? 0 : Math.ceil((count + startAt - 1) / labelsPerSheet(sheet));

// ---------- bar sizes ----------

/** 203 dpi thermal label printers: one dot = 0.125 mm. Bars are whole dots so every bar prints the same width. */
export const THERMAL_DOT_MM = 0.125;
export const MIN_MODULE_MM = 0.19;

export interface BarcodeSizing {
  symbology: Symbology;
  modules: number;
  moduleMm: number;
  widthMm: number;
  /** The code does not fit at MIN_MODULE_MM (a long Code 128 on a small label): printed smaller, may not scan. */
  tooSmall: boolean;
}

/**
 * The bar module for a label:
 *   roll (thermal, 203 dpi): the largest whole number of dots between 2 (0.25 mm) and 3 (0.375 mm) that fits;
 *     below 2 dots the module shrinks continuously down to 0.19 mm;
 *   sheet (laser/inkjet): 0.33 mm (EAN nominal) down to 0.26 mm (80 %), then continuously down to 0.19 mm.
 * `usableWidthMm` = the label width minus its side padding. Quiet zones are part of `modules`.
 */
export function barcodeSizing(code: string, usableWidthMm: number, target: LabelTarget): BarcodeSizing | null {
  const modules = barcodeModules(code);
  if (!modules) return null;
  const symbology = chooseSymbology(code);
  const fit = usableWidthMm / modules;
  let moduleMm: number;
  if (target === 'roll') {
    const dots = Math.min(3, Math.floor(fit / THERMAL_DOT_MM + 1e-9));
    moduleMm = dots >= 2 ? dots * THERMAL_DOT_MM : Math.max(MIN_MODULE_MM, Math.floor(fit * 1000) / 1000);
  } else {
    moduleMm = fit >= 0.33 ? 0.33 : Math.max(MIN_MODULE_MM, Math.floor(fit * 1000) / 1000);
  }
  return { symbology, modules, moduleMm, widthMm: Number((modules * moduleMm).toFixed(3)), tooSmall: fit < MIN_MODULE_MM };
}

/** Label padding (mm) on each side; the barcode quiet zones sit inside it. */
export const LABEL_PADDING_MM = 1;
