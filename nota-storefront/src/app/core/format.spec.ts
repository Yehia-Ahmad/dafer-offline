import { exactAmount, isEgyptianMobile, money, percentOff, whatsappLink } from './format';

describe('format', () => {
  it('shows prices in Arabic-Indic digits with the currency', () => {
    expect(money(180)).toBe('١٨٠ ج.م');
    expect(money(0)).toBe('٠ ج.م');
    expect(money(null)).toBe('٠ ج.م');
    expect(money(12.5)).toContain('١٢');
  });

  it('exactAmount is what the customer types into a transfer: Latin digits, decimals only when needed', () => {
    expect(exactAmount(270)).toBe('270 ج.م');
    expect(exactAmount(270.5)).toBe('270.5 ج.م');
    expect(exactAmount(99.999)).toBe('100 ج.م');
  });

  it('percentOff derives the discount from the two prices', () => {
    expect(percentOff(100, 80)).toBe(20);
    expect(percentOff(0, 0)).toBe(0);
  });

  it('builds a wa.me link from an Egyptian number and encodes the text', () => {
    expect(whatsappLink('01012345678')).toBe('https://wa.me/201012345678');
    expect(whatsappLink('+20 101 234 5678', 'مرحبا')).toBe(`https://wa.me/201012345678?text=${encodeURIComponent('مرحبا')}`);
    expect(whatsappLink('')).toBeNull();
    expect(whatsappLink(undefined)).toBeNull();
  });

  it('accepts Egyptian mobile numbers in the usual spellings only', () => {
    for (const ok of ['01012345678', '01112345678', '01212345678', '01512345678', '+201012345678', '00201012345678', '201012345678', '010 1234 5678']) expect(isEgyptianMobile(ok)).withContext(ok).toBeTrue();
    for (const bad of ['', '0101234567', '01312345678', '0221234567', 'abc', '+971501234567']) expect(isEgyptianMobile(bad)).withContext(bad).toBeFalse();
  });
});
