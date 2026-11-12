// Stage 23: how the printed documents write numbers, money, dates and "the amount in words".
// Pure functions (no Angular, no browser APIs), so every template is unit-testable with fixtures.
//
// Arabic prints use Arabic-Indic digits and the Arabic separators ("١٢٬٣٤٥٫٥٠"); English prints use
// Latin digits. Money always has two decimals and thousands separators. Dates are the PC's LOCAL day.

export type PrintLanguage = 'ar' | 'en';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Replaces Latin digits with Arabic-Indic ones (Arabic prints only). */
export function localizeDigits(text: string, lang: PrintLanguage): string {
  return lang === 'ar' ? text.replace(/[0-9]/g, (digit) => AR_DIGITS[Number(digit)]) : text;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A value inside a CSS string ("…") such as `content:` of a page margin box. */
export function cssString(value: unknown): string {
  // `<` becomes a CSS escape: a name like "</style><img ...>" must never close the <style> element it is printed in.
  return String(value ?? '').replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ').replace(/</g, '\\3C ');
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 1234.5 → "1,234.50" / "١٬٢٣٤٫٥٠". `decimals` 0 for whole numbers (counts, quantities). Negative numbers keep a leading minus. */
export function formatNumber(value: number | string | null | undefined, lang: PrintLanguage, decimals = 2): string {
  const number = Number(value ?? 0);
  const safe = Number.isFinite(number) ? number : 0;
  const rounded = Math.round(Math.abs(safe) * 10 ** decimals + Number.EPSILON) / 10 ** decimals;
  const [whole, fraction] = rounded.toFixed(decimals).split('.');
  const text = `${group(whole)}${fraction ? `.${fraction}` : ''}`;
  const signed = safe < 0 && rounded !== 0 ? `-${text}` : text;
  return lang === 'ar' ? localizeDigits(signed, 'ar').replace(/,/g, '٬').replace(/\./g, '٫').replace(/^-/, '−') : signed;
}

/** Money: two decimals, thousands separators. */
export const formatMoney = (value: number | string | null | undefined, lang: PrintLanguage): string => formatNumber(value, lang, 2);
/** A count or a quantity (whole numbers show without decimals; a fractional quantity keeps up to 3). */
export function formatQty(value: number | string | null | undefined, lang: PrintLanguage): string {
  const number = Number(value ?? 0);
  return formatNumber(number, lang, Number.isInteger(number) ? 0 : 3).replace(/([.٫]\d*?)0+$/, '$1').replace(/[.٫]$/, '');
}
/** Whole currency amounts of the financial statements ("١٨٬٤٠٠"; negatives in parentheses like the design: "(٦٥٠)"). */
export function formatWhole(value: number | string | null | undefined, lang: PrintLanguage, parentheses = false): string {
  const number = Number(value ?? 0);
  const text = formatNumber(Math.abs(number), lang, 0);
  return parentheses && number < 0 ? `(${text})` : number < 0 ? `${lang === 'ar' ? '−' : '-'}${text}` : text;
}
/** "٣٠٫٨٪" / "30.8%". */
export const formatPercent = (value: number | null | undefined, lang: PrintLanguage): string =>
  `${formatNumber(value ?? 0, lang, 1)}${lang === 'ar' ? '٪' : '%'}`;

/** A date-only string (YYYY-MM-DD) is that LOCAL day; anything else is read as an instant and shown in local time. */
export function toLocalDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dayOnly ? new Date(Number(dayOnly[1]), Number(dayOnly[2]) - 1, Number(dayOnly[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "٥ / ١١ / ٢٠٢٦" (ar) or "5 / 11 / 2026" (en). */
export function formatDate(value: string | Date | null | undefined, lang: PrintLanguage): string {
  const date = toLocalDate(value);
  if (!date) return '';
  return localizeDigits(`${date.getDate()} / ${date.getMonth() + 1} / ${date.getFullYear()}`, lang);
}

/** "٥ / ١١" without the year (statement lines). */
export function formatDayMonth(value: string | Date | null | undefined, lang: PrintLanguage): string {
  const date = toLocalDate(value);
  return date ? localizeDigits(`${date.getDate()} / ${date.getMonth() + 1}`, lang) : '';
}

/** "١٢:٤٠ م" / "12:40 PM" (12-hour clock like the designs). */
export function formatTime(value: string | Date | null | undefined, lang: PrintLanguage): string {
  const date = toLocalDate(value);
  if (!date) return '';
  const hours = date.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const text = `${hour12}:${String(date.getMinutes()).padStart(2, '0')}`;
  const mark = lang === 'ar' ? (hours < 12 ? 'ص' : 'م') : hours < 12 ? 'AM' : 'PM';
  return `${localizeDigits(text, lang)} ${mark}`;
}

/** "٥ / ١١ / ٢٠٢٦ · ١٢:٤٠ م". */
export function formatDateTime(value: string | Date | null | undefined, lang: PrintLanguage): string {
  const date = formatDate(value, lang);
  return date ? `${date} · ${formatTime(value, lang)}` : '';
}

// ---------------------------------------------------------------- the amount in words

const AR_ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function arBelowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) parts.push(AR_HUNDREDS[hundreds]);
  if (rest) {
    if (rest < 20) parts.push(AR_ONES[rest]);
    else parts.push(rest % 10 ? `${AR_ONES[rest % 10]} و${AR_TENS[Math.floor(rest / 10)]}` : AR_TENS[Math.floor(rest / 10)]);
  }
  return parts.join(' و');
}

function arScale(chunk: number, one: string, two: string, few: string, many: string): string {
  if (chunk === 1) return one;
  if (chunk === 2) return two;
  if (chunk >= 3 && chunk <= 10) return `${arBelowThousand(chunk)} ${few}`;
  return `${arBelowThousand(chunk)} ${many}`;
}

/** 0 < n < 10^12 in Arabic words ("مائة وخمسة وعشرون"). */
export function arabicWholeWords(n: number): string {
  if (n === 0) return 'صفر';
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1e3;
  const parts: string[] = [];
  if (billions) parts.push(arScale(billions, 'مليار', 'ملياران', 'مليارات', 'مليارًا'));
  if (millions) parts.push(arScale(millions, 'مليون', 'مليونان', 'ملايين', 'مليونًا'));
  if (thousands) parts.push(arScale(thousands, 'ألف', 'ألفان', 'آلاف', 'ألفًا'));
  if (rest) parts.push(arBelowThousand(rest));
  return parts.join(' و');
}

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enBelowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`);
  const rest = n % 100;
  if (rest) parts.push(rest < 20 ? EN_ONES[rest] : `${EN_TENS[Math.floor(rest / 10)]}${rest % 10 ? `-${EN_ONES[rest % 10]}` : ''}`);
  return parts.join(' ');
}

function englishWholeWords(n: number): string {
  if (n === 0) return 'zero';
  const scales: Array<[number, string]> = [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [1, '']];
  const parts: string[] = [];
  let left = n;
  for (const [size, name] of scales) {
    const chunk = Math.floor(left / size);
    left %= size;
    if (chunk) parts.push(`${enBelowThousand(chunk)}${name ? ` ${name}` : ''}`);
  }
  return parts.join(' ');
}

const arPounds = (n: number): string =>
  n === 1 ? 'جنيه مصري واحد' : n === 2 ? 'جنيهان مصريان' : n >= 3 && n <= 10 ? `${arabicWholeWords(n)} جنيهات مصرية` : `${arabicWholeWords(n)} جنيهًا مصريًا`;
const arPiasters = (n: number): string =>
  n === 1 ? 'قرش واحد' : n === 2 ? 'قرشان' : n >= 3 && n <= 10 ? `${arabicWholeWords(n)} قروش` : `${arabicWholeWords(n)} قرشًا`;

/**
 * 650 → "ستمائة وخمسون جنيهًا مصريًا فقط لا غير"; 12.5 → "اثنا عشر جنيهًا مصريًا وخمسون قرشًا فقط لا غير".
 * English: "Six hundred fifty Egyptian pounds only".
 */
export function amountInWords(amount: number, lang: PrintLanguage): string {
  const cents = Math.round(Math.abs(Number(amount) || 0) * 100);
  const pounds = Math.floor(cents / 100);
  const piasters = cents % 100;
  if (lang === 'ar') {
    const parts: string[] = [];
    if (pounds || !piasters) parts.push(pounds ? arPounds(pounds) : 'صفر جنيه');
    if (piasters) parts.push(arPiasters(piasters));
    return `${parts.join(' و')} فقط لا غير`;
  }
  const text = (n: number): string => {
    const words = englishWholeWords(n);
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const parts: string[] = [];
  if (pounds || !piasters) parts.push(`${text(pounds)} Egyptian ${pounds === 1 ? 'pound' : 'pounds'}`);
  if (piasters) parts.push(`${pounds ? 'and ' : ''}${pounds ? englishWholeWords(piasters) : text(piasters)} ${piasters === 1 ? 'piaster' : 'piasters'}`);
  return `${parts.join(' ')} only`;
}
