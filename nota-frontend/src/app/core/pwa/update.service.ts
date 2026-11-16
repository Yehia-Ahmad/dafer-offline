import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** How often (while the app is open) the server is asked for a new version. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000;

/**
 * Online Stage 6A: new releases. The Angular service worker downloads a new version in the background; once it is ready
 * `updateReady` turns on ("فيه تحديث جديد") and `reload()` activates it and reloads. Nothing happens by itself, so a half-filled
 * invoice is never lost to an automatic reload.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly sw = inject(SwUpdate, { optional: true });
  readonly updateReady = signal(false);

  constructor() {
    if (!this.sw || !this.sw.isEnabled) return;
    const sw = this.sw;
    const subscription = sw.versionUpdates
      .pipe(filter((event): event is VersionReadyEvent => event.type === 'VERSION_READY'))
      .subscribe(() => this.updateReady.set(true));
    const check = (): void => { sw.checkForUpdate().catch(() => undefined); };
    const onVisible = (): void => { if (document.visibilityState === 'visible') check(); };
    const timer = setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    });
  }

  /** Activates the downloaded version and reloads the page. */
  async reload(): Promise<void> {
    try { await this.sw?.activateUpdate(); } catch { /* reload anyway */ }
    document.location.reload();
  }
}
