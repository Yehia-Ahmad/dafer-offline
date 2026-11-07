// Stage 20: the purchase screen's live numbers. These mirror the backend rules exactly
// (nota-backend/src/accounting/purchaseCost.js), so the preview and the saved invoice agree.

export const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Σ line costs = subtotal - discount + other costs exactly: the last line takes the rounding remainder. */
export function allocateCosts(lineTotals: number[], discountAmount = 0, otherCosts = 0): { lineCosts: number[]; subtotal: number; total: number } {
  const subtotal = round2(lineTotals.reduce((sum, value) => sum + value, 0));
  const total = round2(subtotal - discountAmount + otherCosts);
  const net = round2(otherCosts - discountAmount);
  const lineCosts: number[] = [];
  let allocated = 0;
  lineTotals.forEach((value, index) => {
    if (index === lineTotals.length - 1) {
      lineCosts.push(round2(total - allocated));
      return;
    }
    const cost = round2(value + (subtotal > 0 ? (net * value) / subtotal : 0));
    lineCosts.push(cost);
    allocated = round2(allocated + cost);
  });
  return { lineCosts, subtotal, total };
}

/** Moving weighted average of the product cost; the purchase cost wins when the stock is 0 or negative. */
export function weightedAverage(oldQty: number, oldCost: number, qty: number, lineCost: number): number {
  if (oldQty <= 0) return round2(lineCost / qty);
  return round2((oldQty * oldCost + lineCost) / (oldQty + qty));
}

/** Stage 21: the VAT of a purchase at the shop rate on the net total (the user may overwrite it with the supplier's printed amount). */
export const defaultPurchaseVat = (netTotal: number, rate: number): number => round2((netTotal * rate) / 100);

export type PaymentMode = 'all_cash' | 'part_cash' | 'all_credit';

export const paymentModeOf = (paid: number, total: number): PaymentMode => (paid <= 0 ? 'all_credit' : paid >= total ? 'all_cash' : 'part_cash');

export interface PreviewLine {
  account: 'inventory' | 'box' | 'supplier' | 'adjustment' | 'vat';
  side: 'debit' | 'credit';
  amount: number;
}

/**
 * "القيد اللي هيتعمل تلقائي": the design shows one entry (Dr inventory / Cr box / Cr supplier). The system posts two
 * (the purchase, then the PV), and the preview shows their net effect, as the design does.
 */
export function journalPreview(total: number, paid: number, vat = 0): PreviewLine[] {
  if (total <= 0) return [];
  // Stage 21: inventory takes the net (never the recoverable VAT); the VAT goes to VAT_INPUT; the supplier is owed the total.
  const lines: PreviewLine[] = [{ account: 'inventory', side: 'debit', amount: round2(total - vat) }];
  if (vat > 0) lines.push({ account: 'vat', side: 'debit', amount: round2(vat) });
  if (paid > 0) lines.push({ account: 'box', side: 'credit', amount: round2(paid) });
  if (round2(total - paid) > 0) lines.push({ account: 'supplier', side: 'credit', amount: round2(total - paid) });
  return lines;
}
