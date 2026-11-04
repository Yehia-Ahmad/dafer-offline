import { Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

@Injectable({
  providedIn: 'root',
})
export class LanguageService {
  // Reactive signal for the selected language
  selectedLanguage = signal<string>('en');

  private readonly storageKey = 'lang';

  constructor(private _translate: TranslateService) {
    const savedLang = localStorage.getItem(this.storageKey) || 'en';
    this.selectedLanguage.set(savedLang);
    this._translate.addLangs(['en', 'ar', 'zh']);
    this._translate.setDefaultLang('en');
    this._translate.use(savedLang);
  }

  changeLanguage(lang: string) {
    this.selectedLanguage.set(lang);
    localStorage.setItem(this.storageKey, lang);
    this._translate.use(lang);
  }

  get currentLanguage() {
    return this.selectedLanguage();
  }

  get translate() {
    return this._translate;
  }
}

export { LanguageService as TranslationService };
