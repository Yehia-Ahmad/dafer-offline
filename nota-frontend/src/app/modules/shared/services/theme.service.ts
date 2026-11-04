import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject } from 'rxjs';

export const THEME_STORAGE_KEY = 'theme';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private _isDarkMode = new BehaviorSubject<boolean>(false);
  isDarkMode$ = this._isDarkMode.asObservable();
  private isBrowser: boolean;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    this.isBrowser = isPlatformBrowser(this.platformId);

    if (this.isBrowser) {
      const savedTheme = this.savedTheme();
      const media = typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

      if (savedTheme) {
        // A theme the user picked wins over the OS setting.
        this.apply(savedTheme === 'dark');
      } else {
        this.apply(!!media?.matches);
      }

      // Follow the OS setting only while the user has never picked a theme.
      media?.addEventListener('change', e => {
        if (!this.savedTheme()) this.apply(e.matches);
      });
    }
  }

  get isDarkMode(): boolean {
    return this._isDarkMode.value;
  }

  toggleTheme(): void {
    if (this._isDarkMode.value) {
      this.enableLightMode();
    } else {
      this.enableDarkMode();
    }
  }

  /** User's pick: applied and saved. */
  enableDarkMode(): void {
    this.apply(true);
    this.save('dark');
  }

  /** User's pick: applied and saved. */
  enableLightMode(): void {
    this.apply(false);
    this.save('light');
  }

  private apply(dark: boolean): void {
    if (this.isBrowser) {
      document.documentElement.classList.toggle('dark', dark);
    }
    this._isDarkMode.next(dark);
  }

  private savedTheme(): 'dark' | 'light' | null {
    try {
      const value = localStorage.getItem(THEME_STORAGE_KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  }

  private save(theme: 'dark' | 'light'): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage unavailable: the pick lasts for this session only.
    }
  }
}
