// Stage 21: the VAT rules for the screens, a mirror of nota-backend/src/utils/vat.js (the server computes the stored
// figures; the screens show the same numbers live). Taxable gross = Σ non-exempt line totals - the invoice discount allocated
// by line value to the taxable lines + shipping.
//   prices include VAT: vat = round2(taxable gross × rate / (100 + rate)); the total is unchanged
//   prices exclude VAT: vat = round2(taxable gross × rate / 100);          the total = old total + vat
export const round2 = (value: number): number => Number(Number(value || 0).toFixed(2));

export interface VatLine { totalPrice: number; vatExempt?: boolean }

export interface VatContext { rate: number; included: boolean }

export interface SaleVat {
  vatAmount: number;
  /** What the customer pays (the old total, plus the VAT when prices exclude it). */
  totalPrice: number;
  /** totalPrice - vatAmount. */
  netAmount: number;
  rate: number;
  included: boolean;
  /** Σ of the exempt lines after their discount share (shown as "معفى"). */
  exemptAmount: number;
}

/** Spreads `total` over `weights`; every part but the last is rounded, the last takes the remainder. */
export function allocateByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  let allocated = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return round2(total - allocated);
    const part = sum > 0 ? round2((total * weight) / sum) : 0;
    allocated = round2(allocated + part);
    return part;
  });
}

export function computeSaleVat(lines: VatLine[], discountAmount: number, shippingFees: number, context: VatContext): SaleVat {
  const totals = lines.map((line) => round2(line.totalPrice));
  const subtotal = round2(totals.reduce((sum, value) => sum + value, 0));
  const discount = round2(Math.min(Math.max(discountAmount || 0, 0), subtotal));
  const shares = allocateByWeight(discount, totals);
  const taxableIdx = lines.map((line, index) => (line.vatExempt ? -1 : index)).filter((index) => index >= 0);
  const discountTaxable = round2(taxableIdx.reduce((sum, index) => sum + shares[index], 0));
  const taxableLines = round2(taxableIdx.reduce((sum, index) => sum + totals[index], 0));
  const shipping = round2(shippingFees || 0);
  const taxableGross = round2(Math.max(0, taxableLines - discountTaxable + shipping));
  const factor = context.included ? context.rate / (100 + context.rate) : context.rate / 100;
  const vatAmount = round2(Math.max(0, taxableGross) * factor);
  const totalBefore = round2(Math.max(0, subtotal - discount + shipping));
  const totalPrice = context.included ? totalBefore : round2(totalBefore + vatAmount);
  return {
    vatAmount, totalPrice, netAmount: round2(totalPrice - vatAmount), rate: context.rate, included: context.included,
    exemptAmount: round2(subtotal - taxableLines - (discount - discountTaxable)),
  };
}

/** The month ("YYYY-MM") of a yyyy-MM-dd date. */
export const monthOf = (date: string): string => date.slice(0, 7);

/** The shop's VAT settings as the screens read them (ShopProfile.vat). */
export interface VatSettingsLike { enabled: boolean; rate: number; pricesIncludeVat: boolean; startDate?: string | null }

/** { rate, included } when a NEW document dated `date` (yyyy-MM-dd) is taxable, else null (VAT off, or dated before the start). */
export function vatContextFor(settings: VatSettingsLike | null | undefined, date: string): VatContext | null {
  if (!settings || !settings.enabled) return null;
  const start = settings.startDate ? String(settings.startDate).slice(0, 10) : null;
  if (start && date < start) return null;
  return { rate: settings.rate, included: settings.pricesIncludeVat !== false };
}
