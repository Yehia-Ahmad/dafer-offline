import { Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/** UI language for new installs (no saved choice). */
export const DEFAULT_LANGUAGE = 'ar';

@Injectable({
  providedIn: 'root',
})
export class LanguageService {
  // Reactive signal for the selected language
  selectedLanguage = signal<string>(DEFAULT_LANGUAGE);

  private readonly storageKey = 'lang';

  constructor(private _translate: TranslateService) {
    const savedLang = this.readSavedLanguage() || DEFAULT_LANGUAGE;
    this.selectedLanguage.set(savedLang);
    this._translate.addLangs(['en', 'ar', 'zh']);
    this._translate.setDefaultLang('en');
    this._translate.use(savedLang);
    this.applyDocumentLanguage(savedLang);
  }

  changeLanguage(lang: string) {
    this.selectedLanguage.set(lang);
    try {
      localStorage.setItem(this.storageKey, lang);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
    this._translate.use(lang);
    this.applyDocumentLanguage(lang);
  }

  get currentLanguage() {
    return this.selectedLanguage();
  }

  get translate() {
    return this._translate;
  }

  private readSavedLanguage(): string | null {
    try {
      return localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  /** <html lang dir>: Arabic is right-to-left, everything else left-to-right. */
  private applyDocumentLanguage(lang: string): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }
}

export { LanguageService as TranslationService };
