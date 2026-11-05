import { routes } from './app.routes';
import { NotaPreset } from './core/theme/nota-preset';
import { provideRouter } from '@angular/router';
import { providePrimeNG } from 'primeng/config';
import { provideAngularSvgIcon } from 'angular-svg-icon';
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AuthService } from './core/auth/auth.service';
import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAngularSvgIcon(),
    provideAnimationsAsync(),
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    // Stage 14: Bearer token + session/permission errors (core/auth/auth.interceptor.ts).
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    // A token kept from this window's earlier load is checked with /auth/me before the first page.
    provideAppInitializer(() => inject(AuthService).restore()),
    provideTranslateService({
      loader: provideTranslateHttpLoader({
        prefix: './assets/i18n/',
        suffix: '.json'
      }),
      fallbackLang: 'en',
      lang: 'ar'
    }),
    providePrimeNG({
      theme: {
        preset: NotaPreset,
        options: {
          // Same class ThemeService toggles on <html>.
          darkModeSelector: '.dark'
        }
      }
    })
  ]
};
