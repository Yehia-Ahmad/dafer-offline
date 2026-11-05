import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, NgZone, computed, effect, inject } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ShopProfileService } from '../../modules/shop-profile/services/shop-profile.service';
import { AuthService } from './auth.service';
import { LockStateService } from './lock-state.service';
import { tokenExpiresAt } from './token-expiry';

/** Shop setting `autoLockMinutes` (GET /api/shop-profile): 0 = off. */
export const AUTO_LOCK_CHOICES = [0, 5, 10, 15, 30, 60] as const;
export const DEFAULT_AUTO_LOCK_MINUTES = 10;
/** Input that counts as activity in this window. */
export const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'pointerdown'] as const;
/** Refresh the token on activity when less than this is left (an active cashier is never signed out). */
export const REFRESH_WHEN_LEFT_MS = 2 * 60 * 60 * 1000;
const REFRESH_CHECK_EVERY_MS = 60 * 1000;
const RESET_THROTTLE_MS = 1000;

export interface IdleTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Real timers; specs provide fakes. Outside the Angular zone, so a pending idle timer never keeps
 * the app "unstable" (the app itself is zoneless; zone-based specs would wait for it).
 */
export const IDLE_TIMERS = new InjectionToken<IdleTimers>('IDLE_TIMERS', {
  providedIn: 'root',
  factory: () => {
    const zone = inject(NgZone);
    return {
      now: () => Date.now(),
      setTimeout: (callback, ms) => zone.runOutsideAngular(() => setTimeout(() => zone.run(callback), ms)),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  },
});

export function normalizeAutoLock(value: unknown): number {
  const minutes = Number(value);
  return (AUTO_LOCK_CHOICES as readonly number[]).includes(minutes) ? minutes : DEFAULT_AUTO_LOCK_MINUTES;
}

/**
 * Stage 15: locks the screen after N idle minutes (shop setting, 0 = off), per window, on every PC.
 * Idle = no mouse, keyboard, touch or wheel input in this window. The lock is an overlay
 * (LockOverlayComponent): the page under it stays as it was. The same activity refreshes the
 * session token when less than 2 hours are left; a locked or idle session is never refreshed, so
 * it still expires on time.
 */
@Injectable({ providedIn: 'root' })
export class IdleLockService {
  private readonly auth = inject(AuthService);
  private readonly lockState = inject(LockStateService);
  private readonly shopProfile = inject(ShopProfileService);
  private readonly timers = inject(IDLE_TIMERS);
  private readonly document = inject(DOCUMENT);

  readonly locked = this.lockState.locked;
  readonly minutes = computed(() => normalizeAutoLock(this.shopProfile.profile()?.autoLockMinutes));
  /** Shown on the lock screen. */
  readonly shopLogo = computed(() => this.shopProfile.profile()?.logo || null);
  readonly shopName = computed(() => this.shopProfile.profile()?.name || '');

  private timer: unknown = null;
  private started = false;
  private lastReset = 0;
  private lastRefreshCheck = 0;
  private refreshing = false;
  private loadedFor: string | null = null;

  constructor() {
    // A new sign-in (or a reload) reads the shop setting; the timer follows the setting and the session.
    effect(() => {
      const userId = this.auth.user()?._id ?? null;
      if (userId && userId !== this.loadedFor) this.shopProfile.refresh();
      this.loadedFor = userId;
    });
    effect(() => {
      this.minutes();
      this.auth.signedIn();
      this.locked();
      this.schedule();
    });
  }

  /** Called once by the app shell. */
  start(destroyRef: DestroyRef): void {
    if (this.started) return;
    this.started = true;
    const listener = () => this.onActivity();
    for (const name of ACTIVITY_EVENTS) this.document.addEventListener(name, listener, { passive: true, capture: true });
    destroyRef.onDestroy(() => {
      for (const name of ACTIVITY_EVENTS) this.document.removeEventListener(name, listener, { capture: true });
      this.cancel();
      this.started = false;
    });
    this.schedule();
  }

  onActivity(): void {
    if (this.locked() || !this.auth.signedIn()) return;
    const now = this.timers.now();
    if (now - this.lastReset >= RESET_THROTTLE_MS) {
      this.lastReset = now;
      this.schedule();
    }
    this.maybeRefresh(now);
  }

  lockNow(): void {
    if (!this.auth.signedIn() || this.locked()) return;
    this.cancel();
    this.lockState.lock();
  }

  /** The user's password again (POST /api/auth/verify-password); errors go to the overlay. */
  unlock(password: string): Observable<void> {
    return this.auth.verifyPassword(password).pipe(
      tap(() => {
        this.lockState.unlock();
        this.lastReset = this.timers.now();
        this.schedule();
      })
    );
  }

  private schedule(): void {
    this.cancel();
    const minutes = this.minutes();
    if (!this.started || minutes === 0 || !this.auth.signedIn() || this.locked()) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.lockNow();
    }, minutes * 60 * 1000);
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private maybeRefresh(now: number): void {
    if (this.refreshing || now - this.lastRefreshCheck < REFRESH_CHECK_EVERY_MS) return;
    this.lastRefreshCheck = now;
    const expiresAt = tokenExpiresAt(this.auth.token());
    if (expiresAt === null || expiresAt <= now || expiresAt - now >= REFRESH_WHEN_LEFT_MS) return;
    this.refreshing = true;
    this.auth.refreshToken().subscribe({
      next: () => (this.refreshing = false),
      error: () => (this.refreshing = false), // a 401 later ends the session as usual
    });
  }
}
