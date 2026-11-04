import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';
import {
  loadDesktopRuntimeConfig,
  renderRuntimeConfigError,
} from './app/core/runtime/runtime-config';

async function start(): Promise<void> {
  if (environment.offline) {
    // The offline desktop edition gets its API address at runtime, not at build time.
    try {
      await loadDesktopRuntimeConfig();
    } catch (error) {
      renderRuntimeConfigError(error);
      return;
    }
  }

  await bootstrapApplication(App, appConfig);
}

start().catch((err) => console.error(err));
