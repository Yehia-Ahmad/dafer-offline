import { Pipe, PipeTransform, inject } from '@angular/core';
import { LanguageService } from '../services/translation.service';
import { notaLocale } from './nota-number';

export type BalanceSide = 'debit' | 'credit';

/** What the API sends for a balance. `balance` is the raw signed number (debit − credit); `side` and `absBalance` are additive. */
export interface BalanceSource {
  balance?: number | null;
  side?: BalanceSide | null;
  absBalance?: number | null;
  /** The account's normal side. Absent (party rows, ledger lines of unknown accounts) = debit. */
  normalSide?: BalanceSide | null;
}

export interface BalanceDisplay {
  /** Always positive. */
  abs: number;
  /** The side the balance sits on: shown as مدين / دائن (Debit / Credit). */
  side: BalanceSide;
  /** True only when the balance sits on the opposite side of the account's normal side (red/warning token + hint). */
  warning: boolean;
  /** The amount with exactly 2 decimals in the UI language's digits. */
  text: string;
}

const fixed2 = new Map<string, Intl.NumberFormat>();
function formatFixed2(value: number, lang: string | null | undefined): string {
  const locale = notaLocale(lang);
  let formatter = fixed2.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fixed2.set(locale, formatter);
  }
  return formatter.format(value);
}

/**
 * The one place that turns a signed ledger balance into what the screens show:
 * a positive number on the balance's own side, labelled مدين / دائن. A zero balance sits on the normal side.
 * Used by the accounts tree (rows and group roll-ups) and the ledger (lines and running balance).
 */
export function balanceDisplay(source: BalanceSource, lang: string | null | undefined = 'ar'): BalanceDisplay {
  const normal: BalanceSide = source.normalSide === 'credit' ? 'credit' : 'debit';
  const signed = Number(source.balance ?? 0);
  const side: BalanceSide = source.side ?? (signed > 0 ? 'debit' : signed < 0 ? 'credit' : normal);
  const abs = Math.round(Math.abs(source.absBalance ?? signed) * 100) / 100;
  return { abs, side, warning: abs !== 0 && side !== normal, text: formatFixed2(abs, lang) };
}

/** `{{ account | notaBalance }}` — follows the UI language. */
@Pipe({ name: 'notaBalance', pure: false })
export class NotaBalancePipe implements PipeTransform {
  private readonly language = inject(LanguageService);

  transform(source: BalanceSource | null | undefined): BalanceDisplay {
    return balanceDisplay(source ?? {}, this.language.selectedLanguage());
  }
}
