import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom, take } from 'rxjs';
import { environment } from '../../../environments/environment';
import { DeviceService } from '../device/device.service';
import { InstallHintService } from './install-hint.service';

/**
 * - unsupported: this browser/build cannot do Web Push (or the service worker is off).
 * - needs-install: iOS only delivers push to an installed app (Add to Home Screen).
 * - unavailable: the server has no VAPID keys.
 * - blocked: the user refused permission in the browser.
 * - off / on: the toggle.
 */
export type PushState = 'unsupported' | 'needs-install' | 'unavailable' | 'blocked' | 'off' | 'on';

/**
 * Online Stage 6A: new-order notifications on this phone. Permission is asked only when `enable()` runs from a tap, never on page
 * load. The subscription belongs to the signed-in user (the backend keeps it under their account) and is removed on sign-out.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly http = inject(HttpClient);
  private readonly swPush = inject(SwPush, { optional: true });
  private readonly install = inject(InstallHintService);
  private readonly device = inject(DeviceService);
  private readonly url = `${environment.api_base_url}push`;

  readonly state = signal<PushState>('off');
  readonly busy = signal(false);

  constructor() {
    void this.refresh();
  }

  private get supported(): boolean {
    return Boolean(this.swPush?.isEnabled) && typeof Notification !== 'undefined' && typeof window !== 'undefined' && 'PushManager' in window;
  }

  /** Reads the current state from the browser (no prompt). */
  async refresh(): Promise<void> {
    if (!this.supported || !this.swPush) return this.state.set('unsupported');
    if (this.install.platform === 'ios' && !this.install.standalone) return this.state.set('needs-install');
    if (Notification.permission === 'denied') return this.state.set('blocked');
    try {
      const subscription = await firstValueFrom(this.swPush.subscription.pipe(take(1)));
      this.state.set(subscription ? 'on' : 'off');
    } catch {
      this.state.set('off');
    }
  }

  /** Call from a tap. Asks the browser for permission, subscribes, and registers the subscription with the server. */
  async enable(): Promise<void> {
    if (this.busy() || this.state() !== 'off' || !this.swPush) return;
    this.busy.set(true);
    try {
      const key = await firstValueFrom(this.http.get<{ enabled: boolean; publicKey?: string }>(`${this.url}/public-key`));
      if (!key.enabled || !key.publicKey) { this.state.set('unavailable'); return; }
      const subscription = await this.swPush.requestSubscription({ serverPublicKey: key.publicKey });
      await firstValueFrom(this.http.post(`${this.url}/subscribe`, subscription.toJSON()));
      this.state.set('on');
    } catch {
      this.state.set(typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'blocked' : 'off');
    } finally {
      this.busy.set(false);
    }
  }

  /** Turns notifications off on this device (the server row and the browser subscription). */
  async disable(): Promise<void> {
    if (this.busy() || this.state() !== 'on' || !this.swPush) return;
    this.busy.set(true);
    try {
      const subscription = await firstValueFrom(this.swPush.subscription.pipe(take(1)));
      if (subscription) {
        await firstValueFrom(this.http.request('DELETE', `${this.url}/subscribe`, { body: { endpoint: subscription.endpoint } }));
        await subscription.unsubscribe();
      }
      this.state.set('off');
    } catch {
      /* stays as it was; the toggle shows the real state after refresh() */
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Sign-out: removes this device's subscription. The caller passes the token it is about to drop, because the request is
   * answered after the session is cleared. Best effort: it never blocks or fails the sign-out.
   */
  unsubscribeForLogout(token: string | null): void {
    const swPush = this.swPush;
    if (!token || !swPush || !this.supported) return;
    void (async () => {
      try {
        const subscription = await firstValueFrom(swPush.subscription.pipe(take(1)));
        if (!subscription) return;
        await fetch(`${this.url}/subscribe`, {
          method: 'DELETE',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Nota-Device-Id': this.device.deviceId },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
        this.state.set('off');
      } catch { /* the server also drops dead endpoints on its next push */ }
    })();
  }
}
