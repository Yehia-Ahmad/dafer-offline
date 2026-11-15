// Stage 23: a real Code 128 barcode of the document number (INV-000125) as an inline SVG.
// Stage 26: plus EAN-13 / EAN-8 / UPC-A for product labels, sized in real millimetres.
// The encoders are jsbarcode's (pinned 3.12.3); only CODE128_AUTO, EAN13, EAN8 and UPC are imported, not the
// other formats. The bars are drawn here, so the barcode is vector, works offline and prints sharp.

// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as Code128Module from 'jsbarcode/bin/barcodes/CODE128/CODE128_AUTO.js';
import * as Ean13Module from 'jsbarcode/bin/barcodes/EAN_UPC/EAN13.js';
import * as Ean8Module from 'jsbarcode/bin/barcodes/EAN_UPC/EAN8.js';
import * as UpcModule from 'jsbarcode/bin/barcodes/EAN_UPC/UPC.js';

interface Encoder {
  valid?(): boolean;
  encode(): { text: string; data: string };
}
type EncoderConstructor = new (text: string, options: Record<string, unknown>) => Encoder;

const load = (module: unknown): EncoderConstructor =>
  ((module as { default?: EncoderConstructor }).default ?? (module as unknown)) as EncoderConstructor;

const Code128 = load(Code128Module);
const Ean13 = load(Ean13Module);
const Ean8 = load(Ean8Module);
const Upc = load(UpcModule);

/** The Code 128 bit pattern of `text` ("1" = bar, "0" = space), quiet zones not included. Throws for characters Code 128 cannot hold. */
export function code128Bits(text: string): string {
  return new Code128(text, {}).encode().data;
}

export type Symbology = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'Code 128';

// The EAN/UPC encoders read these options even in flat mode; the values do not change the bars.
const EAN_OPTIONS = { flat: true, width: 1, height: 1, fontSize: 1, textMargin: 0 };

const numericEncoder = (code: string): { symbology: Symbology; encoder: Encoder } | null => {
  if (!/^\d+$/.test(code)) return null;
  const candidate =
    code.length === 13 ? { symbology: 'EAN-13' as const, encoder: new Ean13(code, { ...EAN_OPTIONS }) }
      : code.length === 8 ? { symbology: 'EAN-8' as const, encoder: new Ean8(code, { ...EAN_OPTIONS }) }
        : code.length === 12 ? { symbology: 'UPC-A' as const, encoder: new Upc(code, { ...EAN_OPTIONS }) }
          : null;
  return candidate && candidate.encoder.valid?.() ? candidate : null;
};

/** EAN-13 / EAN-8 / UPC-A when `code` is a valid one of those (check digit included), otherwise Code 128. */
export function chooseSymbology(code: string): Symbology {
  return numericEncoder(String(code ?? '').trim())?.symbology ?? 'Code 128';
}

/** Quiet zones in modules (left, right): EAN-13 11/7, EAN-8 7/7, UPC-A 9/9, Code 128 10/10. */
export const QUIET_ZONES: Record<Symbology, [number, number]> = {
  'EAN-13': [11, 7],
  'EAN-8': [7, 7],
  'UPC-A': [9, 9],
  'Code 128': [10, 10],
};

/** The bars of `code` in its symbology ("1" = bar), quiet zones not included; null when it cannot be encoded. */
export function barcodeBits(code: string): { symbology: Symbology; bits: string } | null {
  const clean = String(code ?? '').trim();
  if (!clean) return null;
  const numeric = numericEncoder(clean);
  if (numeric) return { symbology: numeric.symbology, bits: numeric.encoder.encode().data };
  try {
    return { symbology: 'Code 128', bits: code128Bits(clean) };
  } catch {
    return null;
  }
}

/** Total width of `code` in modules, quiet zones included (0 when it cannot be encoded). */
export function barcodeModules(code: string): number {
  const encoded = barcodeBits(code);
  if (!encoded) return 0;
  const [left, right] = QUIET_ZONES[encoded.symbology];
  return encoded.bits.length + left + right;
}

const safeLabel = (text: string): string => text.replace(/[^A-Za-z0-9 \-./+]/g, '');

const barsPath = (bits: string, x0: number, module: number, height: number, decimals: number): string => {
  const parts: string[] = [];
  let index = 0;
  while (index < bits.length) {
    if (bits[index] === '1') {
      let end = index;
      while (end < bits.length && bits[end] === '1') end += 1;
      const width = (end - index) * module;
      parts.push(`M${(x0 + index * module).toFixed(decimals)} 0h${width.toFixed(decimals)}v${height}h-${width.toFixed(decimals)}z`);
      index = end;
    } else index += 1;
  }
  return parts.join('');
};

/**
 * An SVG of the barcode. `moduleWidth` is the width of the thinnest bar in CSS px (1.5 = about 0.4mm,
 * scannable on a thermal printer at 203 dpi); the viewBox scales it to the receipt width.
 */
export function barcodeSvg(text: string, options: { height?: number; moduleWidth?: number; quiet?: number } = {}): string {
  const clean = String(text ?? '').trim();
  if (!clean) return '';
  let bits: string;
  try {
    bits = code128Bits(clean);
  } catch {
    return '';
  }
  const moduleWidth = options.moduleWidth ?? 1.5;
  const height = options.height ?? 46;
  const quiet = (options.quiet ?? 10) * moduleWidth;
  const width = bits.length * moduleWidth + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height}" width="${width.toFixed(2)}" height="${height}" role="img" aria-label="${safeLabel(clean)}" data-barcode="${safeLabel(clean)}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"><path d="${barsPath(bits, quiet, moduleWidth, height, 2)}" fill="#000"/></svg>`;
}

/**
 * Stage 26: a product barcode in real millimetres (quiet zones included in the width): EAN-13 / EAN-8 / UPC-A when
 * valid, otherwise Code 128. The SVG's width/height are in mm, so the printed module is exactly `moduleMm`.
 * '' when the code cannot be encoded.
 */
export function barcodeSvgMm(code: string, options: { moduleMm: number; heightMm: number }): string {
  const clean = String(code ?? '').trim();
  const encoded = barcodeBits(clean);
  if (!encoded) return '';
  const [left, right] = QUIET_ZONES[encoded.symbology];
  const module = options.moduleMm;
  const height = options.heightMm;
  const width = (encoded.bits.length + left + right) * module;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(4)} ${height}" width="${width.toFixed(3)}mm" height="${height}mm" role="img" aria-label="${safeLabel(clean)}" data-barcode="${safeLabel(clean)}" data-symbology="${encoded.symbology}" data-module-mm="${module}" preserveAspectRatio="none" shape-rendering="crispEdges"><path d="${barsPath(encoded.bits, left * module, module, height, 4)}" fill="#000"/></svg>`;
}
