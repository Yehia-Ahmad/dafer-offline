import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CONSENT_KEY, PixelsService, SENT_KEY } from './pixels.service';

type W = { fbq?: unknown; ttq?: unknown; requestIdleCallback?: unknown };
const marketing = (extra: Record<string, unknown> = {}) => ({ metaPixelId: '123456789012345', tiktokPixelId: 'CABCDEF123456', requireConsent: true, attributionDays: 7, heardFromOptions: [], ...extra });
const purchase = { name: 'Purchase' as const, orderNumber: 'W-000001', value: 100, lines: [{ id: 'a'.repeat(24), qty: 1, price: 100 }] };

describe('PixelsService', () => {
  let scripts: string[];
  let idle: unknown;
  let savedIdle: unknown;

  const make = (platform: 'browser' | 'server' = 'browser'): PixelsService => {
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: platform }] });
    return TestBed.inject(PixelsService);
  };

  beforeEach(() => {
    localStorage.clear();
    scripts = [];
    const w = window as unknown as W;
    delete w.fbq; delete w.ttq;
    savedIdle = w.requestIdleCallback;
    w.requestIdleCallback = (cb: () => void) => { cb(); return 0; }; // "the page is idle" right away
    // Never load a real third-party script in a test; just record what would have been loaded.
    idle = spyOn(document.head, 'appendChild').and.callFake(((node: Node) => { scripts.push((node as HTMLScriptElement).src); return node; }) as typeof document.head.appendChild);
  });
  afterEach(() => { const w = window as unknown as W; w.requestIdleCallback = savedIdle; delete w.fbq; delete w.ttq; });

  it('never loads anything on the server', () => {
    const service = make('server');
    service.start(marketing({ requireConsent: false }));
    service.track({ name: 'ViewContent', id: 'x', value: 1 });
    expect(scripts).toEqual([]);
    expect((window as unknown as W).fbq).toBeUndefined();
    expect(service.needsConsent()).toBeFalse();
  });

  it('with consent required, nothing loads until the visitor accepts; the bar shows once and the answer is remembered', () => {
    const service = make();
    service.start(marketing());
    expect(service.needsConsent()).toBeTrue();
    expect(scripts).toEqual([]);
    service.track({ name: 'ViewContent', id: 'x', value: 1 });
    expect(scripts).toEqual([]);
    service.accept();
    expect(service.needsConsent()).toBeFalse();
    expect(localStorage.getItem(CONSENT_KEY)).toBe('1');
    expect(scripts.some((s) => s.includes('connect.facebook.net/en_US/fbevents.js'))).toBeTrue();
    expect(scripts.some((s) => s.includes('analytics.tiktok.com') && s.includes('sdkid=CABCDEF123456'))).toBeTrue();
    expect((window as unknown as W).fbq).toBeDefined(); expect((window as unknown as W).ttq).toBeDefined();
  });

  it('a remembered refusal never loads and never asks again', () => {
    localStorage.setItem(CONSENT_KEY, '0');
    const service = make();
    service.start(marketing());
    expect(service.needsConsent()).toBeFalse();
    expect(scripts).toEqual([]);
  });

  it('a remembered acceptance loads at start without the bar', () => {
    localStorage.setItem(CONSENT_KEY, '1');
    const service = make();
    service.start(marketing());
    expect(service.needsConsent()).toBeFalse();
    expect(scripts.length).toBe(2);
  });

  it('with consent switched off in the settings the pixels load without a bar; with no ids nothing loads', () => {
    const service = make();
    service.start(marketing({ requireConsent: false }));
    expect(service.needsConsent()).toBeFalse();
    expect(scripts.length).toBe(2);
    TestBed.resetTestingModule();
    scripts.length = 0; delete (window as unknown as W).fbq; delete (window as unknown as W).ttq;
    const none = make();
    none.start(marketing({ metaPixelId: '', tiktokPixelId: '' }));
    expect(none.hasPixel()).toBeFalse(); expect(none.needsConsent()).toBeFalse(); expect(scripts).toEqual([]);
  });

  it('only the platform with a valid id loads', () => {
    const service = make();
    service.start(marketing({ requireConsent: false, tiktokPixelId: 'bad id' }));
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain('facebook');
  });

  it('events reach the pixels with the right payload: Meta eventID and TikTok event_id are the order number', () => {
    const service = make();
    service.start(marketing({ requireConsent: false }));
    const fbq = jasmine.createSpy('fbq'); const track = jasmine.createSpy('track'); const page = jasmine.createSpy('page');
    (window as unknown as W).fbq = fbq; (window as unknown as W).ttq = { track, page };
    service.track(purchase);
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', jasmine.objectContaining({ value: 100, currency: 'EGP' }), { eventID: 'W-000001' });
    expect(track).toHaveBeenCalledWith('Purchase', jasmine.objectContaining({ value: 100, currency: 'EGP' }), { event_id: 'W-000001' });
    service.track({ name: 'PageView' });
    expect(page).toHaveBeenCalled();
  });

  it('events raised before the pixels start are sent only if consent allows, otherwise discarded', () => {
    localStorage.setItem(CONSENT_KEY, '0');
    const refused = make();
    refused.track({ name: 'ViewContent', id: 'x', value: 1 });
    refused.start(marketing());
    expect((window as unknown as W).fbq).toBeUndefined();
    TestBed.resetTestingModule();

    const fbq = jasmine.createSpy('fbq');
    localStorage.setItem(CONSENT_KEY, '1');
    const allowed = make();
    allowed.track({ name: 'ViewContent', id: 'x', value: 1 });
    // the stub installed by start() queues calls; swap in a spy right after it exists
    allowed.start(marketing({ tiktokPixelId: '' }));
    const queue = ((window as unknown as W).fbq as unknown as { queue: unknown[][] }).queue;
    expect(queue.some((call) => call[1] === 'ViewContent')).toBeTrue();
    expect(queue.some((call) => call[1] === 'PageView')).toBeTrue();
    void fbq;
  });

  it('Purchase is sent once per order number even if the order page is opened again', () => {
    const service = make();
    service.start(marketing({ requireConsent: false }));
    const fbq = jasmine.createSpy('fbq');
    (window as unknown as W).fbq = fbq; (window as unknown as W).ttq = { track: () => undefined, page: () => undefined };
    service.trackPurchase(purchase); service.trackPurchase(purchase);
    expect(fbq.calls.allArgs().filter((a) => a[1] === 'Purchase').length).toBe(1);
    expect(JSON.parse(localStorage.getItem(SENT_KEY)!)).toEqual(['W-000001']);
    void idle;
  });
});
