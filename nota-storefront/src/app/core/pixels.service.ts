// Online Stage 7A: loads the Meta and TikTok pixels. Never while rendering on the server, never before the page is interactive and,
// when the shop asks for consent (the default), never before the visitor accepts the consent bar. Events sent before that are dropped,
// not queued: nothing reaches a platform without consent.
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { storage } from './storage';
import { PixelEvent, metaCall, tiktokCall } from './pixel-events';
import { StoreSettings } from './models';

export const CONSENT_KEY = 'nota.store.consent';
export const SENT_KEY = 'nota.store.purchases-sent';
const META_ID = /^\d{15,16}$/;
const TIKTOK_ID = /^[A-Za-z0-9]{8,32}$/;

type Marketing = NonNullable<StoreSettings['marketing']>;
type Win = Window & { fbq?: (...args: unknown[]) => void; ttq?: Record<string, unknown> & { track?: (...args: unknown[]) => void; page?: () => void }; _fbq?: unknown };

@Injectable({ providedIn: 'root' })
export class PixelsService {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly doc = inject(DOCUMENT);

  private config = signal<Marketing | null>(null);
  private readonly decision = signal<'unknown' | 'granted' | 'denied'>('unknown');
  private readonly started = signal(false);
  private loaded = false;
  private injected = false;
  private pending: PixelEvent[] = [];

  /** Is there a pixel to load at all? */
  readonly hasPixel = computed(() => { const c = this.config(); return !!c && (META_ID.test(c.metaPixelId) || TIKTOK_ID.test(c.tiktokPixelId)); });
  /** The consent bar shows only in the browser, after start(), when a pixel is set, the shop asks for consent and the visitor has not decided. */
  readonly needsConsent = computed(() => this.started() && this.hasPixel() && !!this.config()?.requireConsent && this.decision() === 'unknown');

  /** Browser only (called after the first render). Reads the remembered decision and loads the pixels when allowed. */
  start(marketing: StoreSettings['marketing']): void {
    if (!this.browser || !marketing) return;
    this.config.set(marketing);
    const saved = storage.get(CONSENT_KEY);
    this.decision.set(saved === '1' ? 'granted' : saved === '0' ? 'denied' : 'unknown');
    this.started.set(true);
    // Events held in memory while the page was starting are sent only if the pixels may load; otherwise they are thrown away.
    if (!this.allowed()) this.pending = [];
    this.loadIfAllowed();
  }

  accept(): void { storage.set(CONSENT_KEY, '1'); this.decision.set('granted'); this.loadIfAllowed(); }
  decline(): void { storage.set(CONSENT_KEY, '0'); this.decision.set('denied'); }

  private allowed(): boolean {
    const c = this.config();
    return !!c && this.hasPixel() && (!c.requireConsent || this.decision() === 'granted');
  }

  private loadIfAllowed(): void {
    if (!this.browser || this.loaded || !this.allowed()) return;
    this.loaded = true;
    const run = (): void => {
      this.inject();
      this.injected = true;
      this.send({ name: 'PageView' });
      for (const event of this.pending) this.send(event);
      this.pending = [];
    };
    // After the page is interactive and idle: the pixels never compete with the first render.
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 2000);
  }

  private inject(): void {
    const c = this.config();
    if (!c) return;
    const w = window as Win;
    if (META_ID.test(c.metaPixelId) && !w.fbq) {
      // The official Meta snippet: a queue stub, then the script.
      const fbq = function (...args: unknown[]): void { (fbq as unknown as { queue: unknown[][] }).queue.push(args); } as unknown as ((...args: unknown[]) => void) & { queue: unknown[][]; loaded: boolean; version: string };
      fbq.queue = []; fbq.loaded = true; fbq.version = '2.0';
      w.fbq = fbq; w._fbq = fbq;
      this.script('https://connect.facebook.net/en_US/fbevents.js');
      w.fbq('init', c.metaPixelId);
    }
    if (TIKTOK_ID.test(c.tiktokPixelId) && !w.ttq) {
      // The official TikTok snippet: a queue of method calls, then the script.
      const queue: unknown[][] = [];
      const ttq: Record<string, unknown> = { _q: queue };
      for (const method of ['load', 'page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie']) {
        ttq[method] = (...args: unknown[]): void => { queue.push([method, ...args]); };
      }
      w.ttq = ttq as Win['ttq'];
      this.script(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(c.tiktokPixelId)}&lib=ttq`);
      (w.ttq as { load: (id: string) => void }).load(c.tiktokPixelId);
    }
  }

  private script(src: string): void {
    const el = this.doc.createElement('script');
    el.async = true; el.src = src;
    this.doc.head.appendChild(el);
  }

  private send(event: PixelEvent): void {
    const w = window as Win;
    const c = this.config();
    if (!c) return;
    if (META_ID.test(c.metaPixelId) && w.fbq) {
      const call = metaCall(event);
      if (call.options) w.fbq('track', call.name, call.params, call.options); else if (call.params) w.fbq('track', call.name, call.params); else w.fbq('track', call.name);
    }
    if (TIKTOK_ID.test(c.tiktokPixelId) && w.ttq) {
      if (event.name === 'PageView') { w.ttq.page?.(); return; }
      const call = tiktokCall(event);
      if (call.options) w.ttq.track?.(call.name, call.params, call.options); else w.ttq.track?.(call.name, call.params);
    }
  }

  /**
   * Sends an event when the pixels are loaded. While the page is still starting (before start(), or before the idle load) it is held
   * in memory only; with no consent, no pixel or on the server it is dropped. A page view is never held: the loader sends the first.
   */
  track(event: PixelEvent): void {
    if (!this.browser) return;
    if (this.injected) { if (this.allowed()) this.send(event); return; }
    if (event.name === 'PageView') return;
    if (this.started() && !this.allowed()) return;
    if (this.pending.length < 20) this.pending.push(event);
  }

  /** Purchase: at most once per order number in this browser (the order page can be reloaded, the event must not repeat). */
  trackPurchase(event: Extract<PixelEvent, { name: 'Purchase' }>): void {
    if (!this.browser) return;
    const sent = storage.getJson<string[]>(SENT_KEY) ?? [];
    if (sent.includes(event.orderNumber)) return;
    storage.setJson(SENT_KEY, [...sent, event.orderNumber].slice(-20));
    this.track(event);
  }
}
