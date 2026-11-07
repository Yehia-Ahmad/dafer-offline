import { computeSaleVat, monthOf, round2, vatContextFor } from './vat-math';

/** Stage 21: the screens' VAT math mirrors the server (nota-backend utils/vat.js): same design numbers. */
describe('vat-math (Stage 21)', () => {
  const lines = [{ totalPrice: 140 }, { totalPrice: 130 }]; // 4 x 35 + 2 x 65

  it('prices including VAT: 250 -> VAT 30.70, net 219.30, the total is unchanged', () => {
    const vat = computeSaleVat(lines, 20, 0, { rate: 14, included: true });
    expect(vat.vatAmount).toBe(30.7);
    expect(vat.totalPrice).toBe(250);
    expect(vat.netAmount).toBe(219.3);
  });

  it('prices excluding VAT: the same items -> VAT 35.00, total 285.00', () => {
    const vat = computeSaleVat(lines, 20, 0, { rate: 14, included: false });
    expect(vat.vatAmount).toBe(35);
    expect(vat.totalPrice).toBe(285);
    expect(vat.netAmount).toBe(250);
  });

  it('a mixed taxable/exempt invoice with shipping: the exempt line is untaxed, the shipping is taxable', () => {
    const vat = computeSaleVat([{ totalPrice: 140 }, { totalPrice: 130, vatExempt: true }], 20, 10, { rate: 14, included: true });
    expect(vat.vatAmount).toBe(17.15);
    expect(vat.totalPrice).toBe(260);
    expect(vat.netAmount).toBe(242.85);
  });

  it('a discount larger than the subtotal is capped; an empty invoice has no VAT', () => {
    expect(computeSaleVat(lines, 999, 0, { rate: 14, included: true }).totalPrice).toBe(0);
    expect(computeSaleVat([], 0, 0, { rate: 14, included: false }).vatAmount).toBe(0);
  });

  it('the settings decide whether a document dated X carries VAT: off, before the start date, from the start date', () => {
    const on = { enabled: true, rate: 14, pricesIncludeVat: true, startDate: '2026-11-05T00:00:00.000Z' };
    expect(vatContextFor(null, '2026-11-06')).toBeNull();
    expect(vatContextFor({ ...on, enabled: false }, '2026-11-06')).toBeNull();
    expect(vatContextFor(on, '2026-11-04')).toBeNull();
    expect(vatContextFor(on, '2026-11-05')).toEqual({ rate: 14, included: true });
    expect(vatContextFor({ ...on, pricesIncludeVat: false }, '2026-12-01')).toEqual({ rate: 14, included: false });
  });

  it('round2 and monthOf', () => {
    expect(round2(30.7018)).toBe(30.7);
    expect(monthOf('2026-11-05')).toBe('2026-11');
  });
});
