import { Pipe, PipeTransform, inject } from '@angular/core';
import { LanguageService } from '../shared/services/translation.service';
import { notaLocale } from '../shared/ui/nota-number';

/** "١٦ نوفمبر ٢٠٢٦" (Arabic) / "16 November 2026" (English); `time` adds "٠٨:٣٠ م". Display only. */
export function formatMobDate(value: string | number | Date | null | undefined, lang: string | null | undefined, time = false): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) };
  return new Intl.DateTimeFormat(notaLocale(lang) + (lang === 'ar' ? '-u-nu-arab' : ''), options).format(date);
}

/** Phone screens' dates: `{{ row.date | mobDate }}` or `| mobDate: true` for date and time. Follows the UI language. */
@Pipe({ name: 'mobDate', pure: false })
export class MobDatePipe implements PipeTransform {
  private readonly language = inject(LanguageService);
  transform(value: string | number | Date | null | undefined, time = false): string {
    return formatMobDate(value, this.language.selectedLanguage(), time);
  }
}
