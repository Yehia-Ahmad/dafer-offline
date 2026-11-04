import { routes } from './app.routes';
import { NotaPreset } from './core/theme/nota-preset';
import { provideRouter } from '@angular/router';
import { providePrimeNG } from 'primeng/config';
import { provideAngularSvgIcon } from 'angular-svg-icon';
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { logoutInterceptor } from './core/interceptor/logout.interceptor';
import { httpconfigInterceptor } from './core/interceptor/httpconfig.interceptor';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { requestOnlineInterceptor } from './core/interceptor/request-online.interceptor';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAngularSvgIcon(),
    provideAnimationsAsync(),
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    // provideHttpClient(withFetch(), withInterceptors([httpconfigInterceptor, logoutInterceptor, requestOnlineInterceptor])),
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
