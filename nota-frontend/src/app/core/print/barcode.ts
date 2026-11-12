// Stage 23: a real Code 128 barcode of the document number (INV-000125) as an inline SVG.
// The encoder is jsbarcode's CODE128 (pinned 3.12.3); only that encoder is imported, not the other
// formats. The bars are drawn here, so the barcode is vector, works offline and prints sharp.

// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as Code128Module from 'jsbarcode/bin/barcodes/CODE128/CODE128_AUTO.js';

interface Code128Encoder {
  encode(): { text: string; data: string };
}
type Code128Constructor = new (text: string, options: Record<string, unknown>) => Code128Encoder;

const Code128 = ((Code128Module as unknown as { default?: Code128Constructor }).default ?? (Code128Module as unknown)) as Code128Constructor;

/** The Code 128 bit pattern of `text` ("1" = bar, "0" = space), quiet zones not included. Throws for characters Code 128 cannot hold. */
export function code128Bits(text: string): string {
  return new Code128(text, {}).encode().data;
}

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
  const bars: string[] = [];
  let index = 0;
  while (index < bits.length) {
    if (bits[index] === '1') {
      let end = index;
      while (end < bits.length && bits[end] === '1') end += 1;
      bars.push(`M${(quiet + index * moduleWidth).toFixed(2)} 0h${((end - index) * moduleWidth).toFixed(2)}v${height}h-${((end - index) * moduleWidth).toFixed(2)}z`);
      index = end;
    } else index += 1;
  }
  const width = bits.length * moduleWidth + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height}" width="${width.toFixed(2)}" height="${height}" role="img" aria-label="${clean.replace(/[^A-Za-z0-9 \-./]/g, '')}" data-barcode="${clean.replace(/[^A-Za-z0-9 \-./]/g, '')}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"><path d="${bars.join('')}" fill="#000"/></svg>`;
}
