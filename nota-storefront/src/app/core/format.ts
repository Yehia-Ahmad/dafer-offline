import { AR } from './i18n/ar';

const nf = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 });

/** 180 → "١٨٠ ج.م" (Arabic-Indic digits like the designs; the numbers inside stay tabular). */
export const money = (value: number | null | undefined): string => `${nf.format(Number(value || 0))} ${AR.currency}`;
export const num = (value: number | null | undefined): string => nf.format(Number(value || 0));

/** The exact amount a customer types into a transfer: plain Latin digits, two decimals only when needed. */
export const exactAmount = (value: number): string => `${Number(Number(value).toFixed(2))} ${AR.currency}`;

/** 01012345678 → 201012345678 for a wa.me link (Egyptian numbers; other numbers keep their digits). */
export const whatsappDigits = (raw: string | null | undefined): string => {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `20${digits.slice(1)}`;
  return digits;
};

export const whatsappLink = (raw: string | null | undefined, text?: string): string | null => {
  const digits = whatsappDigits(raw);
  return digits ? `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}` : null;
};

/** Egyptian mobile (the backend normalises too): 010/011/012/015 + 8 digits, optionally with +20 / 0020. */
export const isEgyptianMobile = (raw: string): boolean => {
  let digits = String(raw || '').replace(/[\s-]/g, '');
  if (digits.startsWith('+20')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0020')) digits = `0${digits.slice(4)}`;
  else if (/^20\d{10}$/.test(digits)) digits = `0${digits.slice(2)}`;
  return /^01[0125]\d{8}$/.test(digits);
};

export const percentOff = (price: number, finalPrice: number): number => (price > 0 ? Math.round((1 - finalPrice / price) * 100) : 0);
