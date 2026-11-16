import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideClientHydration, withEventReplay, withNoHttpTransferCache } from '@angular/platform-browser';

import { routes } from './app.routes';
import { SettingsStore } from './core/settings.store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' })),
    // Data is handed to the browser by ApiService through TransferState, not by HttpClient's cache.
    provideClientHydration(withEventReplay(), withNoHttpTransferCache()),
    // Every page needs the public settings first (brand colour, closed website, shop name): load them before the first render.
    provideAppInitializer(() => inject(SettingsStore).load()),
  ],
};
