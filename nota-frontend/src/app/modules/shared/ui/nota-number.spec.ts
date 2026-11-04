import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { LanguageService } from '../services/translation.service';
import { NotaMoneyPipe, NotaNumberPipe, formatNotaNumber, notaLocale } from './nota-number';

describe('formatNotaNumber', () => {
  it('uses ar-EG for Arabic and en-EG otherwise', () => {
    expect(notaLocale('ar')).toBe('ar-EG');
    expect(notaLocale('en')).toBe('en-EG');
    expect(notaLocale('zh')).toBe('en-EG');
    expect(notaLocale(null)).toBe('en-EG');
  });

  it('formats numbers with 0–2 decimals and thousands separators', () => {
    expect(formatNotaNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNotaNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatNotaNumber(2.345, 'en')).toBe('2.35');
    expect(formatNotaNumber(-1500.25, 'en')).toBe('-1,500.25');
    expect(formatNotaNumber(1234.5, 'ar')).toBe('١٬٢٣٤٫٥');
    expect(formatNotaNumber(0, 'ar')).toBe('٠');
  });

  it('formats money: whole amounts without decimals, otherwise exactly 2', () => {
    expect(formatNotaNumber(1000, 'en', 'money')).toBe('1,000');
    expect(formatNotaNumber(1234.5, 'en', 'money')).toBe('1,234.50');
    expect(formatNotaNumber(99.999, 'en', 'money')).toBe('100');
    expect(formatNotaNumber(1234.5, 'ar', 'money')).toBe('١٬٢٣٤٫٥٠');
    expect(formatNotaNumber(12480, 'ar', 'money')).toBe('١٢٬٤٨٠');
  });

  it('accepts numeric strings with Latin digits and returns — for empty or invalid input', () => {
    expect(formatNotaNumber('2500.75', 'en', 'money')).toBe('2,500.75');
    expect(formatNotaNumber('2500', 'ar')).toBe('٢٬٥٠٠');
    expect(formatNotaNumber(null, 'en')).toBe('—');
    expect(formatNotaNumber(undefined, 'en')).toBe('—');
    expect(formatNotaNumber('', 'en')).toBe('—');
    expect(formatNotaNumber('abc', 'en')).toBe('—');
    expect(formatNotaNumber(Number.NaN, 'en')).toBe('—');
  });
});

@Component({
  imports: [NotaNumberPipe, NotaMoneyPipe],
  template: `<span id="n">{{ 1234.5 | notaNumber }}</span><span id="m">{{ 1234.5 | notaMoney }}</span>`,
})
class HostComponent {}

describe('notaNumber / notaMoney pipes', () => {
  let savedLang: string | null;

  beforeEach(() => {
    savedLang = localStorage.getItem('lang');
    TestBed.configureTestingModule({ imports: [TranslateModule.forRoot()] });
  });

  afterEach(() => {
    if (savedLang === null) localStorage.removeItem('lang');
    else localStorage.setItem('lang', savedLang);
  });

  it('follows the UI language, including after it changes', () => {
    const language = TestBed.inject(LanguageService);
    language.changeLanguage('en');
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const text = (id: string) => (fixture.nativeElement.querySelector(`#${id}`) as HTMLElement).textContent;
    expect(text('n')).toBe('1,234.5');
    expect(text('m')).toBe('1,234.50');

    language.changeLanguage('ar');
    fixture.detectChanges();
    expect(text('n')).toBe('١٬٢٣٤٫٥');
    expect(text('m')).toBe('١٬٢٣٤٫٥٠');
  });
});
