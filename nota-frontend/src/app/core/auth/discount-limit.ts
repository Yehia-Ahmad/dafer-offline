/**
 * Stage 15: the per-user max discount (users' maxDiscountPercent). The backend refuses a discount
 * above it (403 DISCOUNT_LIMIT, "أقصى خصم مسموح لك X٪"); POS and the new credit sale block it
 * before sending, with the same 0.01 tolerance for rounding.
 */
export const DISCOUNT_LIMIT_TOLERANCE = 0.01;

/** The discount as a percent of the subtotal (unrounded); Infinity for a discount on nothing. */
export function discountShare(discount: number, subtotal: number): number {
  if (!(discount > 0)) return 0;
  return subtotal > 0 ? (discount / subtotal) * 100 : Infinity;
}

export function isOverDiscountLimit(discount: number, subtotal: number, limit: number | null): boolean {
  return limit !== null && discountShare(discount, subtotal) > limit + DISCOUNT_LIMIT_TOLERANCE;
}
