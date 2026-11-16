import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { discardPeriodicTasks, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { signInWith } from '../auth/testing/sign-in';
import { ORDERS_MUTE_KEY, ORDERS_POLL_MS, OrdersNotifierService } from './orders-notifier.service';

/** Online Stage 4 (decision 8): the badge count, the sound when it goes up, mute per device, polling only while the tab is visible. */
describe('OrdersNotifierService (Online Stage 4)', () => {
  const url = `${environment.api_base_url}orders/summary`;
  let http: HttpTestingController;

  beforeEach(() => {
    try { localStorage.removeItem(ORDERS_MUTE_KEY); } catch { /* ignore */ }
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { try { localStorage.removeItem(ORDERS_MUTE_KEY); } catch { /* ignore */ } });

  const visible = (state: 'visible' | 'hidden') => spyOnProperty(document, 'visibilityState', 'get').and.returnValue(state);
  const answer = (newCount: number) => http.expectOne((request) => request.url === url).flush({ newCount });

  it('polls every 20 s for a user with orders.view; the first count makes no sound, a higher one does', fakeAsync(() => {
    visible('visible');
    signInWith(['orders.view']);
    const service = TestBed.inject(OrdersNotifierService);
    const beep = spyOn(service as unknown as { beep: () => void }, 'beep');
    TestBed.tick();
    answer(2);
    expect(service.newCount()).toBe(2);
    expect(beep).not.toHaveBeenCalled();

    tick(ORDERS_POLL_MS);
    answer(2);
    expect(beep).not.toHaveBeenCalled();

    tick(ORDERS_POLL_MS);
    answer(3);
    expect(service.newCount()).toBe(3);
    expect(beep).toHaveBeenCalledTimes(1);

    tick(ORDERS_POLL_MS);
    answer(1); // the shop handled some: it goes down, no sound
    expect(service.newCount()).toBe(1);
    expect(beep).toHaveBeenCalledTimes(1);
    service.stop();
    discardPeriodicTasks();
  }));

  it('does not poll while the tab is hidden, and asks again when it becomes visible', fakeAsync(() => {
    const state = visible('hidden');
    signInWith(['orders.view']);
    const service = TestBed.inject(OrdersNotifierService);
    TestBed.tick();
    answer(0); // the start-up check
    tick(ORDERS_POLL_MS * 3);
    http.expectNone(url);
    state.and.returnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    answer(4);
    expect(service.newCount()).toBe(4);
    service.stop();
    discardPeriodicTasks();
  }));

  it('a user without orders.view never polls', fakeAsync(() => {
    visible('visible');
    signInWith(['sales.view']);
    const service = TestBed.inject(OrdersNotifierService);
    TestBed.tick();
    tick(ORDERS_POLL_MS * 2);
    http.expectNone(url);
    expect(service.newCount()).toBeNull();
  }));

  it('mute is per device (localStorage) and silences the sound, not the badge', () => {
    signInWith([]);
    const service = TestBed.inject(OrdersNotifierService);
    const beep = spyOn(service as unknown as { beep: () => void }, 'beep');
    service.apply(1);
    service.apply(2);
    expect(beep).toHaveBeenCalledTimes(1);
    service.toggleMute();
    expect(service.muted()).toBeTrue();
    expect(localStorage.getItem(ORDERS_MUTE_KEY)).toBe('1');
    service.apply(5);
    expect(service.newCount()).toBe(5);
    expect(beep).toHaveBeenCalledTimes(1);
    // a new page load on the same device starts muted
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    expect(TestBed.inject(OrdersNotifierService).muted()).toBeTrue();
  });

  it('a blocked or missing audio device is handled silently (the badge still updates)', () => {
    signInWith([]);
    const service = TestBed.inject(OrdersNotifierService);
    const win = window as unknown as { AudioContext: unknown };
    const original = win.AudioContext;
    win.AudioContext = function BlockedAudio() { throw new Error('NotAllowedError'); };
    try {
      expect(() => { service.apply(1); service.apply(2); }).not.toThrow();
      expect(service.newCount()).toBe(2);
    } finally {
      win.AudioContext = original;
    }
  });
});
