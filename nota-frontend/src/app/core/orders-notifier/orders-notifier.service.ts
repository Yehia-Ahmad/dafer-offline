import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { OrdersService } from '../../modules/orders/orders.service';
import { AuthService } from '../auth/auth.service';

export const ORDERS_POLL_MS = 20_000;
export const ORDERS_MUTE_KEY = 'nota.orders.muted';

/**
 * Online Stage 4 (decision 8): the number of NEW website orders for the sidebar badge, and a short sound when it goes up.
 * - Every signed-in user with orders.view polls GET /api/orders/summary every 20 s, only while the tab is visible
 *   (and once more when the tab becomes visible again).
 * - The sound can be muted per device (localStorage). Browsers block sound until the user interacts with the page: that
 *   is handled silently (the first click/key unlocks it; a blocked play() is swallowed, the badge still updates).
 * - Phone notifications come with the PWA (Stage 6).
 */
@Injectable({ providedIn: 'root' })
export class OrdersNotifierService {
  private readonly orders = inject(OrdersService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  /** New orders now; null before the first answer (no sound for the first number we see). */
  readonly newCount = signal<number | null>(null);
  readonly muted = signal(readMuted());

  private timer: ReturnType<typeof setInterval> | null = null;
  private audio: AudioContext | null = null;
  private readonly onVisibility = (): void => { if (isVisible()) this.poll(); };
  private readonly unlock = (): void => this.prepareAudio();

  constructor() {
    effect(() => {
      if (this.auth.signedIn() && this.auth.has('orders.view')) this.start();
      else this.stop();
    });
    this.destroyRef.onDestroy(() => this.stop());
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => { if (isVisible()) this.poll(); }, ORDERS_POLL_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      document.addEventListener('pointerdown', this.unlock, { once: true });
      document.addEventListener('keydown', this.unlock, { once: true });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.newCount.set(null);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('pointerdown', this.unlock);
      document.removeEventListener('keydown', this.unlock);
    }
  }

  /** One check. Goes up → sound (unless muted). */
  poll(): void {
    this.orders.summary().subscribe({
      next: ({ newCount }) => this.apply(newCount),
      error: () => { /* silent: the next tick tries again */ },
    });
  }

  /** Public for the orders list: it already knows the count after its own reload. */
  apply(count: number): void {
    const previous = this.newCount();
    this.newCount.set(count);
    if (previous !== null && count > previous && !this.muted()) this.beep();
  }

  toggleMute(): void {
    const next = !this.muted();
    this.muted.set(next);
    try { localStorage.setItem(ORDERS_MUTE_KEY, next ? '1' : '0'); } catch { /* private mode: the choice lasts until reload */ }
  }

  private prepareAudio(): void {
    try {
      const Context = typeof window !== 'undefined' ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
      if (!Context) return;
      this.audio = this.audio || new Context();
      if (this.audio.state === 'suspended') void this.audio.resume().catch(() => undefined);
    } catch { /* no audio on this device */ }
  }

  /** A short two-tone beep (no audio file to ship). */
  private beep(): void {
    try {
      this.prepareAudio();
      const context = this.audio;
      if (!context || context.state !== 'running') return; // still blocked: nothing to do, silently
      const now = context.currentTime;
      [660, 880].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + index * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.2, now + index * 0.16 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.16 + 0.14);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(now + index * 0.16);
        oscillator.stop(now + index * 0.16 + 0.15);
      });
    } catch { /* never let a sound break the page */ }
  }
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function readMuted(): boolean {
  try { return localStorage.getItem(ORDERS_MUTE_KEY) === '1'; } catch { return false; }
}
