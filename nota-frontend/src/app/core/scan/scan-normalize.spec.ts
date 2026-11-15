// Stage 26: scanned/typed codes are normalised before any lookup: the Arabic (101) layout back to the Latin keys,
// Arabic-Indic / Persian digits to ASCII, invisible characters stripped. And the barcode rules (mirror of the backend).

import { barcodeProblem, barcodeType, cleanCode, gs1CheckDigit, normalizeCode, normalizeScan } from './scan-normalize';

describe('scan normalisation', () => {
  it('"INV-000125" typed on the Arabic layout (Shift held) arrives as "÷آ{-000125" and becomes INV-000125', () => {
    expect(normalizeScan('÷آ{-000125').primary).toBe('INV-000125');
    expect(normalizeCode('÷آ{-000125')).toBe('INV-000125');
    // "CR-000007": C = ؤ+Shift → '}', R = ق+Shift → U+064C
    expect(normalizeCode('}ٌ-000007')).toBe('CR-000007');
  });

  it('lowercase and uppercase letters map back key by key (shifted keys give the uppercase letter)', () => {
    expect(normalizeCode('شسيبل')).toBe('asdfg'); // a s d f g
    expect(normalizeCode('ضصثقف')).toBe('qwert');
    expect(normalizeCode('غعهخح')).toBe('yuiop');
    expect(normalizeCode('ئءؤرى')).toBe('zxcvn');
    expect(normalizeCode('ًٌَُ')).toBe('QWER');
    expect(normalizeCode('ٍِ')).toBe('AS');
  });

  it('"لا" is the B key; its other reading (G then H) is offered as an alternate', () => {
    const scan = normalizeScan('شلاؤ123'); // a b c 1 2 3
    expect(scan.primary).toBe('abc123');
    expect(scan.alternates).toContain('aghc123');
    expect(scan.alternates).not.toContain(scan.primary);
    expect(scan.alternates.length).toBeLessThanOrEqual(8);
  });

  it('shifted two-character keys: لأ = G, لإ = T, لآ = B', () => {
    expect(normalizeCode('لأ')).toBe('G');
    expect(normalizeCode('لإ')).toBe('T');
    expect(normalizeCode('لآ')).toBe('B');
    expect(normalizeCode('ِلآ}-1')).toBe('ABC-1');
  });

  it('Arabic-Indic and Persian digits become ASCII digits', () => {
    expect(normalizeCode('٤٠٠٦٣٨١٣٣٣٩٣١')).toBe('4006381333931');
    expect(normalizeCode('۹۶۳۸۵۰۷۴')).toBe('96385074');
    expect(cleanCode('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹')).toBe('01234567890123456789');
  });

  it('invisible characters (RLM, LRM, zero-width, BOM, bidi marks) are stripped', () => {
    expect(normalizeCode('‏INV-000125‎')).toBe('INV-000125');
    expect(normalizeCode('INV​-‌000‍125﻿')).toBe('INV-000125');
    expect(normalizeCode('‪ABC-1‬⁦⁩')).toBe('ABC-1');
    expect(normalizeCode('  ABC-1  ')).toBe('ABC-1');
  });

  it('Latin-layout text is left alone: a real / . , or [ ] in a code is not remapped', () => {
    for (const code of ['INV-000125', 'SKU-1.2/3+4', 'A[1]{2}~3', '4006381333931', 'abc,def.ghi']) expect(normalizeCode(code)).toBe(code);
  });

  it('an Arabic text is not a layout scan in cleanCode: names and Arabic product codes stay as typed', () => {
    expect(cleanCode('قلم رصاص')).toBe('قلم رصاص');
    expect(cleanCode('‏قلم')).toBe('قلم');
  });

  it('empty and non-string input give nothing', () => {
    expect(normalizeScan('')).toEqual({ primary: '', alternates: [] });
    expect(normalizeScan(null)).toEqual({ primary: '', alternates: [] });
    expect(normalizeScan(undefined).primary).toBe('');
    expect(normalizeScan('   ').primary).toBe('');
  });
});

describe('barcode rules (the same as the backend)', () => {
  it('check digits: EAN-13, EAN-8, UPC-A are recognised when valid, otherwise Code 128', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1);
    expect(barcodeType('4006381333931')).toBe('EAN-13');
    expect(barcodeType('96385074')).toBe('EAN-8');
    expect(barcodeType('036000291452')).toBe('UPC-A');
    expect(barcodeType('4006381333932')).toBe('Code 128');
    expect(barcodeType('ABC-123')).toBe('Code 128');
    expect(barcodeType('1234567')).toBe('Code 128');
    expect(barcodeType('2000000000015')).toBe('EAN-13'); // an in-store generated number
  });

  it('a problem is reported as a translation key: length, characters, wrong check digit', () => {
    expect(barcodeProblem('4006381333931')).toBeNull();
    expect(barcodeProblem('ABC-1.2/3+4')).toBeNull();
    expect(barcodeProblem('')?.key).toBe('barcodes.errors.empty');
    expect(barcodeProblem('abc')?.key).toBe('barcodes.errors.length');
    expect(barcodeProblem('x'.repeat(49))?.key).toBe('barcodes.errors.length');
    expect(barcodeProblem('AB CD')?.key).toBe('barcodes.errors.chars');
    expect(barcodeProblem('منتج123')?.key).toBe('barcodes.errors.chars');
    expect(barcodeProblem('4006381333932')).toEqual({ key: 'barcodes.errors.checkDigit', params: { type: 'EAN-13' } });
    expect(barcodeProblem('96385075')?.params).toEqual({ type: 'EAN-8' });
    expect(barcodeProblem('036000291453')?.params).toEqual({ type: 'UPC-A' });
  });
});
