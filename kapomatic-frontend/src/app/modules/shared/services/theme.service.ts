import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private _isDarkMode = new BehaviorSubject<boolean>(false);
  isDarkMode$ = this._isDarkMode.asObservable();
  private isBrowser: boolean;

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    this.isBrowser = isPlatformBrowser(this.platformId);

    // Only access localStorage in browser
    if (this.isBrowser) {
      const savedTheme = localStorage.getItem('theme');

      if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        this.enableDarkMode();
      } else {
        this.enableLightMode();
      }

      // Optional: listen for system preference changes
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (e.matches) this.enableDarkMode();
        else this.enableLightMode();
      });
    }
  }

  toggleTheme(): void {
    if (this._isDarkMode.value) {
      this.enableLightMode();
    } else {
      this.enableDarkMode();
    }
  }

  enableDarkMode(): void {
    if (this.isBrowser) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    }
    this._isDarkMode.next(true);
  }

  enableLightMode(): void {
    if (this.isBrowser) {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
    this._isDarkMode.next(false);
  }
}
