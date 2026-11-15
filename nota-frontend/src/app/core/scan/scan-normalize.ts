// Stage 26: barcode scanners are HID keyboards: they "type" the code and press Enter. When Windows is on
// the Arabic (101) layout, the same key presses arrive as Arabic characters ("INV-000125" arrives as
// "÷آ{-000125"). Before any lookup, a scanned or typed code is normalised:
//   1. invisible characters (RLM/LRM/ALM, zero-width, bidi embeddings/isolates, BOM, soft hyphen) removed;
//   2. Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII;
//   3. Arabic (101) characters → the Latin character of the same key (Shift kept: a shifted key gives the
//      uppercase letter). Two-character keys (لا لأ لإ لآ) are matched first. The ASCII punctuation that the
//      Arabic layout puts on other keys (< > [ ] / ~ { } , .) is remapped ONLY when the text also holds
//      Arabic-layout characters, so a real "/" or "." typed on the Latin layout stays as it is.
// "لا" is both the B key and G followed by H (ل + ا); the primary reading is the single key, and up to
// 8 alternate readings are returned for a lookup to try when the primary one finds nothing.

const INVISIBLE = /[​-‏‪-‮⁦-⁩؜﻿­]/g;

/** Unshifted Arabic (101) characters → the Latin key. */
const ARABIC_UNSHIFTED: Record<string, string> = {
  'ض': 'q', 'ص': 'w', 'ث': 'e', 'ق': 'r', 'ف': 't', 'غ': 'y', 'ع': 'u', 'ه': 'i', 'خ': 'o', 'ح': 'p', 'ج': '[', 'د': ']',
  'ش': 'a', 'س': 's', 'ي': 'd', 'ب': 'f', 'ل': 'g', 'ا': 'h', 'ت': 'j', 'ن': 'k', 'م': 'l', 'ك': ';', 'ط': "'",
  'ئ': 'z', 'ء': 'x', 'ؤ': 'c', 'ر': 'v', 'ى': 'n', 'ة': 'm', 'و': ',', 'ز': '.', 'ظ': '/', 'ذ': '`',
};

/** Shifted Arabic (101) characters that exist only on the Arabic layout → the shifted Latin key. */
const ARABIC_SHIFTED: Record<string, string> = {
  'َ': 'Q', 'ً': 'W', 'ُ': 'E', 'ٌ': 'R', 'إ': 'Y', '‘': 'U', '÷': 'I', '×': 'O', '؛': 'P',
  'ِ': 'A', 'ٍ': 'S', 'أ': 'H', 'ـ': 'J', '،': 'K',
  'ْ': 'X', 'آ': 'N', '’': 'M', '؟': '?', 'ّ': '~',
};

/** ASCII punctuation the Arabic layout produces on OTHER keys (shifted) → the Latin key. Applied only to Arabic-layout text. */
const ARABIC_PUNCTUATION: Record<string, string> = {
  '<': '{', '>': '}', ']': 'D', '[': 'F', '/': 'L', '~': 'Z', '}': 'C', '{': 'V', ',': '<', '.': '>',
};

/** Two-character keys (and their presentation-form ligatures): [text, primary key, alternate reading]. */
const PAIRS: Array<[string, string, string]> = [
  ['لا', 'b', 'gh'], ['لأ', 'G', 'gH'], ['لإ', 'T', 'gY'], ['لآ', 'B', 'gN'],
  ['ﻻ', 'b', 'gh'], ['ﻼ', 'b', 'gh'], ['ﻷ', 'G', 'gH'], ['ﻸ', 'G', 'gH'],
  ['ﻹ', 'T', 'gY'], ['ﻺ', 'T', 'gY'], ['ﻵ', 'B', 'gN'], ['ﻶ', 'B', 'gN'],
];

const MAX_ALTERNATES = 8;

const hasArabicLayout = (text: string): boolean =>
  [...text].some((char) => char in ARABIC_UNSHIFTED || char in ARABIC_SHIFTED) || PAIRS.some(([pair]) => text.includes(pair));

/** Steps 1-2: invisible characters out, Arabic-Indic / Persian digits → ASCII, trimmed. */
export function cleanCode(raw: unknown): string {
  return String(raw ?? '')
    .replace(INVISIBLE, '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
}

type Token = { fixed: string } | { primary: string; alternate: string };

function tokenize(text: string): Token[] {
  const arabic = hasArabicLayout(text);
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const pair = PAIRS.find(([value]) => text.startsWith(value, index));
    if (pair) {
      tokens.push({ primary: pair[1], alternate: pair[2] });
      index += pair[0].length;
      continue;
    }
    const char = text[index];
    const mapped = ARABIC_UNSHIFTED[char] ?? ARABIC_SHIFTED[char] ?? (arabic ? ARABIC_PUNCTUATION[char] : undefined);
    tokens.push({ fixed: mapped ?? char });
    index += 1;
  }
  return tokens;
}

export interface NormalizedScan {
  /** The most likely Latin text (single-key reading of لا etc.). '' for empty input. */
  primary: string;
  /** Other readings (only when the text holds لا / لأ / لإ / لآ), at most 8, never equal to `primary`. */
  alternates: string[];
}

/** A scanned or typed code → its Latin text (+ alternate readings). Latin input only loses invisible characters and gets ASCII digits. */
export function normalizeScan(raw: unknown): NormalizedScan {
  const text = cleanCode(raw);
  if (!text) return { primary: '', alternates: [] };
  const tokens = tokenize(text);
  const primary = tokens.map((token) => ('fixed' in token ? token.fixed : token.primary)).join('');
  const choices = tokens.map((token, position) => ('fixed' in token ? null : position)).filter((position): position is number => position !== null);
  const alternates: string[] = [];
  // Every combination of primary/alternate readings except "all primary", fewest swaps first.
  const total = Math.min(1 << Math.min(choices.length, 10), 1024);
  const masks = Array.from({ length: total - 1 }, (_, value) => value + 1).sort((a, b) => bitCount(a) - bitCount(b) || a - b);
  for (const mask of masks) {
    if (alternates.length >= MAX_ALTERNATES) break;
    const swapped = new Set(choices.filter((_, bit) => mask & (1 << bit)));
    const reading = tokens.map((token, position) => ('fixed' in token ? token.fixed : swapped.has(position) ? token.alternate : token.primary)).join('');
    if (reading !== primary && !alternates.includes(reading)) alternates.push(reading);
  }
  return { primary, alternates };
}

const bitCount = (value: number): number => {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count += 1;
  return count;
};

/** The primary reading only (for a field that keeps one value: the product form's barcode box, the invoice-number scan). */
export function normalizeCode(raw: unknown): string {
  return normalizeScan(raw).primary;
}

// ---------- barcode rules (mirror nota-backend/src/utils/barcode.js) ----------

export type BarcodeType = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'Code 128';
export const MAX_BARCODES = 5;
const ALLOWED = /^[0-9A-Za-z\-./+]+$/;
const NUMERIC_TYPES: Record<number, BarcodeType> = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13' };

/** GS1 mod-10 check digit of `body` (the digits without the check digit). */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) sum += Number(body[index]) * ((body.length - index) % 2 === 1 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function barcodeType(code: string): BarcodeType {
  const numericType = /^\d+$/.test(code) ? NUMERIC_TYPES[code.length] : undefined;
  if (numericType && gs1CheckDigit(code.slice(0, -1)) === Number(code.slice(-1))) return numericType;
  return 'Code 128';
}

/** null when valid, else a translation key + params (the backend sends the same rules in Arabic). */
export function barcodeProblem(code: string): { key: string; params?: Record<string, unknown> } | null {
  if (!code) return { key: 'barcodes.errors.empty' };
  if (code.length < 4 || code.length > 48) return { key: 'barcodes.errors.length' };
  if (!ALLOWED.test(code)) return { key: 'barcodes.errors.chars' };
  const numericType = /^\d+$/.test(code) ? NUMERIC_TYPES[code.length] : undefined;
  if (numericType && gs1CheckDigit(code.slice(0, -1)) !== Number(code.slice(-1))) return { key: 'barcodes.errors.checkDigit', params: { type: numericType } };
  return null;
}
