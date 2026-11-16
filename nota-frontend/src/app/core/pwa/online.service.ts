import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * Online Stage 6A: is the network up? Drives the "مفيش إنترنت" banner and disables the actions that need the server.
 * There is no offline queue: nothing is stored to be sent later.
 */
@Injectable({ providedIn: 'root' })
export class OnlineService {
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

  constructor() {
    if (typeof window === 'undefined') return;
    const up = (): void => this.online.set(true);
    const down = (): void => this.online.set(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    });
  }
}
