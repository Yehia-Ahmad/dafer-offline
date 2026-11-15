'use strict';

// Stage 26: the per-PC label printing settings (roll size, calibration offsets, gap, A4 sheet grid, label content
// options, scan-sound mute). Every value is validated and clamped (numbers only, whitelisted names), the same way
// as the receipt width/offset, so a damaged file or a hostile value can never reach the page CSS.
// Mirrors nota-frontend/src/app/core/print/label-layout.ts (the page builds the HTML with the same rules).

const ROLL_PRESETS = Object.freeze({
  '38x25': { widthMm: 38, heightMm: 25 },
  '40x30': { widthMm: 40, heightMm: 30 },
  '50x25': { widthMm: 50, heightMm: 25 },
  '50x30': { widthMm: 50, heightMm: 30 },
  '58x40': { widthMm: 58, heightMm: 40 },
});
const SHEET_PRESETS = Object.freeze({
  '3x7': { columns: 3, rows: 7, labelWidthMm: 70, labelHeightMm: 42.3, marginTopMm: 0.45, marginSideMm: 0, gapXmm: 0, gapYmm: 0 },
  '3x8': { columns: 3, rows: 8, labelWidthMm: 70, labelHeightMm: 37, marginTopMm: 0.5, marginSideMm: 0, gapXmm: 0, gapYmm: 0 },
  '4x10': { columns: 4, rows: 10, labelWidthMm: 52.5, labelHeightMm: 29.7, marginTopMm: 0, marginSideMm: 0, gapXmm: 0, gapYmm: 0 },
  '5x13': { columns: 5, rows: 13, labelWidthMm: 38.1, labelHeightMm: 21.2, marginTopMm: 10.7, marginSideMm: 4.75, gapXmm: 2.5, gapYmm: 0 },
});
const LABEL_PAGE_LIMITS = Object.freeze({ widthMm: [20, 110], heightMm: [15, 160] });
const PRICE_CHOICES = Object.freeze(['retail', 'wholesale', 'discounted', 'none']);
const A4 = Object.freeze({ widthMm: 210, heightMm: 297 });

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** A finite number (or numeric string) clamped to [min, max] and rounded to `step`; anything else → fallback. */
function clampNumber(value, min, max, fallback, step = 0.01) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  const stepped = Number((Math.round(clamped / step) * step).toFixed(4));
  return Math.min(max, Math.max(min, stepped)) || 0;
}

const DEFAULT_ROLL = Object.freeze({ preset: '38x25', widthMm: 38, heightMm: 25, offsetXmm: 0, offsetYmm: 0, gapMm: 0 });

function normalizeRoll(raw) {
  const source = isRecord(raw) ? raw : {};
  const preset = typeof source.preset === 'string' && (hasOwn(ROLL_PRESETS, source.preset) || source.preset === 'custom') ? source.preset : DEFAULT_ROLL.preset;
  const size = preset === 'custom'
    ? { widthMm: clampNumber(source.widthMm, 20, 110, DEFAULT_ROLL.widthMm, 0.5), heightMm: clampNumber(source.heightMm, 15, 150, DEFAULT_ROLL.heightMm, 0.5) }
    : { ...ROLL_PRESETS[preset] };
  return {
    preset,
    ...size,
    offsetXmm: clampNumber(source.offsetXmm, -5, 5, 0, 0.5),
    offsetYmm: clampNumber(source.offsetYmm, -5, 5, 0, 0.5),
    gapMm: clampNumber(source.gapMm, 0, 10, 0, 0.5),
  };
}

const DEFAULT_SHEET = Object.freeze({ preset: '3x8', ...SHEET_PRESETS['3x8'] });

function normalizeSheet(raw) {
  const source = isRecord(raw) ? raw : {};
  const preset = typeof source.preset === 'string' && (hasOwn(SHEET_PRESETS, source.preset) || source.preset === 'custom') ? source.preset : DEFAULT_SHEET.preset;
  if (preset !== 'custom') return { preset, ...SHEET_PRESETS[preset] };
  const base = SHEET_PRESETS['3x8'];
  const columns = clampNumber(source.columns, 1, 10, base.columns, 1);
  const rows = clampNumber(source.rows, 1, 30, base.rows, 1);
  // Margins and gaps are clamped to their ranges, then reduced until the smallest label (10 x 8 mm) still fits the page.
  const down = (value) => Math.floor(value * 20) / 20;
  const marginSideMm = Math.min(clampNumber(source.marginSideMm, 0, 50, 0, 0.05), down(Math.max(0, (A4.widthMm - columns * 10) / 2)));
  const marginTopMm = Math.min(clampNumber(source.marginTopMm, 0, 50, 0, 0.05), down(Math.max(0, (A4.heightMm - rows * 8) / 2)));
  const gapXmm = columns > 1 ? Math.min(clampNumber(source.gapXmm, 0, 20, 0, 0.05), down(Math.max(0, (A4.widthMm - 2 * marginSideMm - columns * 10) / (columns - 1)))) : 0;
  const gapYmm = rows > 1 ? Math.min(clampNumber(source.gapYmm, 0, 20, 0, 0.05), down(Math.max(0, (A4.heightMm - 2 * marginTopMm - rows * 8) / (rows - 1)))) : 0;
  const maxWidth = Math.max(10, (A4.widthMm - 2 * marginSideMm - (columns - 1) * gapXmm) / columns);
  const maxHeight = Math.max(8, (A4.heightMm - 2 * marginTopMm - (rows - 1) * gapYmm) / rows);
  return {
    preset,
    columns,
    rows,
    labelWidthMm: clampNumber(source.labelWidthMm, 10, Math.floor(maxWidth * 100) / 100, Math.min(base.labelWidthMm, maxWidth), 0.05),
    labelHeightMm: clampNumber(source.labelHeightMm, 8, Math.floor(maxHeight * 100) / 100, Math.min(base.labelHeightMm, maxHeight), 0.05),
    marginTopMm,
    marginSideMm,
    gapXmm,
    gapYmm,
  };
}

function normalizeLabelOptions(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    target: source.target === 'sheet' ? 'sheet' : 'roll',
    shopName: typeof source.shopName === 'boolean' ? source.shopName : true,
    price: PRICE_CHOICES.includes(source.price) ? source.price : 'retail',
    internalCode: source.internalCode === true,
  };
}

/** A label page size for a print job (mm, clamped). */
function normalizeLabelPage(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    widthMm: clampNumber(source.widthMm, LABEL_PAGE_LIMITS.widthMm[0], LABEL_PAGE_LIMITS.widthMm[1], 38, 0.01),
    heightMm: clampNumber(source.heightMm, LABEL_PAGE_LIMITS.heightMm[0], LABEL_PAGE_LIMITS.heightMm[1], 25, 0.01),
  };
}

module.exports = {
  DEFAULT_ROLL,
  DEFAULT_SHEET,
  LABEL_PAGE_LIMITS,
  PRICE_CHOICES,
  ROLL_PRESETS,
  SHEET_PRESETS,
  clampNumber,
  normalizeLabelOptions,
  normalizeLabelPage,
  normalizeRoll,
  normalizeSheet,
};
