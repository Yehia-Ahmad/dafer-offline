import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { DEFAULT_LANGUAGE, TranslationService } from './translation.service';

describe('TranslationService', () => {
  const root = document.documentElement;
  let saved: string | null;

  function create(): TranslationService {
    TestBed.configureTestingModule({ imports: [TranslateModule.forRoot()] });
    return TestBed.inject(TranslationService);
  }

  beforeEach(() => {
    saved = localStorage.getItem('lang');
    localStorage.removeItem('lang');
  });

  afterEach(() => {
    if (saved === null) localStorage.removeItem('lang');
    else localStorage.setItem('lang', saved);
  });

  it('defaults to Arabic, right-to-left, when nothing is saved', () => {
    const service = create();
    expect(DEFAULT_LANGUAGE).toBe('ar');
    expect(service.selectedLanguage()).toBe('ar');
    expect(root.lang).toBe('ar');
    expect(root.dir).toBe('rtl');
  });

  it('keeps a saved choice', () => {
    localStorage.setItem('lang', 'en');
    const service = create();
    expect(service.selectedLanguage()).toBe('en');
    expect(root.dir).toBe('ltr');
  });

  it('updates <html lang dir> and saves on change', () => {
    const service = create();
    service.changeLanguage('en');
    expect(root.lang).toBe('en');
    expect(root.dir).toBe('ltr');
    expect(localStorage.getItem('lang')).toBe('en');

    service.changeLanguage('ar');
    expect(root.dir).toBe('rtl');
  });
});
