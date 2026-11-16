import { Injectable, computed, signal } from '@angular/core';

export const INSTALL_DISMISSED_KEY = 'nota.installHint.dismissed';

export type InstallPlatform = 'android' | 'ios' | 'other';

/** Pure: which install path applies to this browser. iOS Safari has no install prompt (Share → Add to Home Screen). */
export function detectInstallPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && maxTouchPoints > 1)) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  return 'other';
}

/** The event Chrome on Android fires when the app is installable. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const readDismissed = (): boolean => {
  try { return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'; } catch { return false; }
};

/**
 * Online Stage 6A: the "ثبّت نوتة على موبايلك" hint.
 * - Android Chrome: a button that calls the browser's own prompt (beforeinstallprompt).
 * - iOS Safari: a short instruction (Share → Add to Home Screen).
 * - Dismissible, remembered on this device; never shown when the app already runs installed (standalone).
 */
@Injectable({ providedIn: 'root' })
export class InstallHintService {
  readonly platform: InstallPlatform =
    typeof navigator === 'undefined' ? 'other' : detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints);
  readonly standalone = isStandalone();
  readonly dismissed = signal(readDismissed());
  private readonly promptEvent = signal<BeforeInstallPromptEvent | null>(null);

  /** Android: the browser said the app can be installed. */
  readonly canInstall = computed(() => this.promptEvent() !== null);
  /** What the hint shows: the install button, the iOS steps, or nothing. */
  readonly mode = computed<'android' | 'ios' | null>(() => {
    if (this.standalone || this.dismissed()) return null;
    if (this.platform === 'ios') return 'ios';
    return this.canInstall() ? 'android' : null;
  });

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.promptEvent.set(event as BeforeInstallPromptEvent);
    });
    window.addEventListener('appinstalled', () => this.promptEvent.set(null));
  }

  async install(): Promise<void> {
    const event = this.promptEvent();
    if (!event) return;
    await event.prompt();
    await event.userChoice.catch(() => undefined);
    this.promptEvent.set(null);
  }

  dismiss(): void {
    this.dismissed.set(true);
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, '1'); } catch { /* private mode */ }
  }
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone) || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}
