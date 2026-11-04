import { Pipe, PipeTransform, inject } from '@angular/core';
import { LanguageService } from '../services/translation.service';

export type NotaNumberKind = 'number' | 'money';

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(locale: string, minimumFractionDigits: number, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${locale}|${minimumFractionDigits}|${maximumFractionDigits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits, maximumFractionDigits });
    formatters.set(key, f);
  }
  return f;
}

/** 'ar-EG' (Arabic-Indic digits ٠١٢٣) for Arabic, 'en-EG' (Latin digits) otherwise. */
export function notaLocale(lang: string | null | undefined): string {
  return lang === 'ar' ? 'ar-EG' : 'en-EG';
}

/**
 * Display formatting for numbers and money, with thousands separators.
 * - number: 0–2 decimals, trailing zeros dropped (1234.5 → 1,234.5).
 * - money: whole amounts without decimals, otherwise exactly 2 (1234.5 → 1,234.50; 1000 → 1,000).
 * Accepts numbers or numeric strings (Latin digits); null/empty/NaN → '—'. Display only.
 */
export function formatNotaNumber(value: unknown, lang: string | null | undefined, kind: NotaNumberKind = 'number'): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  const locale = notaLocale(lang);
  if (kind === 'money') {
    const whole = Math.round(Math.abs(n) * 100) % 100 === 0;
    return whole ? formatter(locale, 0, 0).format(Math.round(n * 100) / 100) : formatter(locale, 2, 2).format(n);
  }
  return formatter(locale, 0, 2).format(n);
}

/** `{{ qty | notaNumber }}` — follows the UI language (re-renders when it changes). */
@Pipe({ name: 'notaNumber', pure: false })
export class NotaNumberPipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(value: unknown): string {
    return formatNotaNumber(value, this.language.selectedLanguage(), 'number');
  }
}

/** `{{ total | notaMoney }}` — follows the UI language (re-renders when it changes). */
@Pipe({ name: 'notaMoney', pure: false })
export class NotaMoneyPipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(value: unknown): string {
    return formatNotaNumber(value, this.language.selectedLanguage(), 'money');
  }
}
