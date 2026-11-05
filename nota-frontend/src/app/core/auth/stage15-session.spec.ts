import { Component, DestroyRef, inject } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { SellingComponent } from '../../modules/products/components/selling/selling.component';
import { ShopProfileService } from '../../modules/shop-profile/services/shop-profile.service';
import { UnsavedWorkService, unsavedWorkGuard } from '../unsaved-work/unsaved-work.service';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { CartRescueService } from './cart-rescue.service';
import { IDLE_TIMERS, IdleLockService, IdleTimers, REFRESH_WHEN_LEFT_MS } from './idle-lock.service';
import { LockOverlayComponent } from './lock-overlay.component';
import { LockStateService } from './lock-state.service';
import { signInAs } from './testing/sign-in';
import { tokenExpiresAt } from './token-expiry';

/** Timers driven by the spec: `advance(ms)` runs what is due. */
class FakeTimers implements IdleTimers {
  time = 1_000_000;
  private next = 1;
  private pending = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.pending.delete(handle as number);
  };
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.pending]) {
      if (timer.at <= this.time) {
        this.pending.delete(id);
        timer.callback();
      }
    }
  }
  get count(): number {
    return this.pending.size;
  }
}

/** A JWT-shaped token (unsigned) with this expiry; the frontend only reads `exp`. */
const tokenExpiring = (expMs: number) =>
  `h.${btoa(JSON.stringify({ sub: 'id-cashier', tv: 0, exp: Math.floor(expMs / 1000) })).replace(/=+$/, '')}.s`;

const MIN = 60 * 1000;
const base = environment.api_base_url;

function configure(extra: unknown[] = []) {
  const timers = new FakeTimers();
  TestBed.configureTestingModule({
    imports: [TranslateModule.forRoot()],
    providers: [
      provideRouter([]),
      provideNoopAnimations(),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: IDLE_TIMERS, useValue: timers },
      ...(extra as never[]),
    ],
  });
  return timers;
}

/** Starts the idle service like the app shell does, with the shop setting already loaded. */
function startIdle(minutes: number | undefined) {
  TestBed.inject(ShopProfileService);
  const idle = TestBed.inject(IdleLockService);
  TestBed.runInInjectionContext(() => idle.start(inject(DestroyRef)));
  TestBed.tick();
  const http = TestBed.inject(HttpTestingController);
  for (const req of http.match((r) => r.url.endsWith('shop-profile'))) req.flush({ name: 'محل النور', autoLockMinutes: minutes, logo: null });
  TestBed.tick();
  return idle;
}

describe('Stage 15: idle auto-lock', () => {
  let timers: FakeTimers;
  beforeEach(() => {
    sessionStorage.removeItem('nota.locked');
    timers = configure();
  });
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    sessionStorage.removeItem('nota.locked');
    sessionStorage.removeItem('nota.session');
  });

  it('locks after N idle minutes (shop setting, default 10) and remembers it in sessionStorage', () => {
    signInAs('cashier');
    const idle = startIdle(undefined);
    expect(idle.minutes()).toBe(10);
    timers.advance(10 * MIN - 1);
    expect(idle.locked()).toBeFalse();
    timers.advance(1);
    expect(idle.locked()).toBeTrue();
    expect(sessionStorage.getItem('nota.locked')).toBe('1');
  });

  it('activity resets the timer', () => {
    signInAs('cashier');
    const idle = startIdle(5);
    timers.advance(4 * MIN);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    timers.advance(4 * MIN);
    expect(idle.locked()).toBeFalse();
    document.dispatchEvent(new MouseEvent('mousemove'));
    timers.advance(5 * MIN - 1);
    expect(idle.locked()).toBeFalse();
    timers.advance(1);
    expect(idle.locked()).toBeTrue();
  });

  it('setting 0 disables the lock', () => {
    signInAs('cashier');
    const idle = startIdle(0);
    expect(timers.count).toBe(0);
    timers.advance(24 * 60 * MIN);
    expect(idle.locked()).toBeFalse();
  });

  it('never locks without a signed-in user; signing out clears the lock', () => {
    const idle = startIdle(5);
    timers.advance(60 * MIN);
    expect(idle.locked()).toBeFalse();
    signInAs('cashier');
    TestBed.tick();
    TestBed.inject(HttpTestingController).match((r) => r.url.endsWith('shop-profile')).forEach((r) => r.flush({ autoLockMinutes: 5 }));
    TestBed.tick();
    timers.advance(5 * MIN);
    expect(idle.locked()).toBeTrue();
    TestBed.inject(AuthService).logout();
    expect(idle.locked()).toBeFalse();
    expect(sessionStorage.getItem('nota.locked')).toBeNull();
  });

  it('a reload of a locked window starts locked (sessionStorage flag)', () => {
    sessionStorage.setItem('nota.locked', '1');
    TestBed.resetTestingModule();
    configure();
    expect(TestBed.inject(LockStateService).locked()).toBeTrue();
  });

  it('a locked-window reload may validate /auth/me so startup reaches the lock overlay', async () => {
    sessionStorage.setItem('nota.locked', '1');
    sessionStorage.setItem('nota.session', 'reload-token-xxxxxxxx');
    TestBed.resetTestingModule();
    configure();
    const auth = TestBed.inject(AuthService);
    const restoring = auth.restore();
    const request = TestBed.inject(HttpTestingController).expectOne(`${base}auth/me`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer reload-token-xxxxxxxx');
    request.flush({
      user: { _id: 'id-cashier', name: 'محمود', username: 'mahmoud', role: 'cashier', permissions: ['sales.create'], isActive: true },
      permissions: ['sales.create'],
    });
    await restoring;
    expect(TestBed.inject(LockStateService).locked()).toBeTrue();
    expect(auth.signedIn()).toBeTrue();
  });

  it('refreshes the token on activity when less than 2h is left; not with more left; never while locked', () => {
    const auth = signInAs('cashier');
    startIdle(10);
    const http = TestBed.inject(HttpTestingController);

    auth.token.set(tokenExpiring(timers.now() + 3 * 60 * MIN));
    document.dispatchEvent(new MouseEvent('mousemove'));
    http.expectNone(`${base}auth/refresh`);

    timers.advance(2 * MIN);
    auth.token.set(tokenExpiring(timers.now() + REFRESH_WHEN_LEFT_MS - MIN));
    document.dispatchEvent(new MouseEvent('mousemove'));
    const req = http.expectOne(`${base}auth/refresh`);
    expect(req.request.method).toBe('POST');
    const fresh = tokenExpiring(timers.now() + 12 * 60 * MIN);
    req.flush({ token: fresh, user: auth.user(), permissions: auth.permissions() });
    expect(auth.token()).toBe(fresh);

    // Locked: the session is idle and must expire on time.
    auth.token.set(tokenExpiring(timers.now() + 30 * MIN));
    TestBed.inject(LockStateService).lock();
    timers.advance(2 * MIN);
    document.dispatchEvent(new MouseEvent('mousemove'));
    http.expectNone(`${base}auth/refresh`);
  });

  it('tokenExpiresAt reads exp; bad tokens give null', () => {
    expect(tokenExpiresAt(tokenExpiring(2_000_000_000_000))).toBe(2_000_000_000_000);
    expect(tokenExpiresAt('nope')).toBeNull();
    expect(tokenExpiresAt(null)).toBeNull();
  });
});

@Component({
  imports: [SellingComponent, LockOverlayComponent],
  template: `<app-selling /><nota-lock-overlay />`,
})
class PosWithLockHost {}

describe('Stage 15: lock screen overlay', () => {
  let timers: FakeTimers;
  let fixture: ComponentFixture<PosWithLockHost>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const overlay = () => el().querySelector('[data-test="lock-overlay"]');
  // ngModel inside a <form> is wired up a microtask after render.
  const type = async (value: string) => {
    await fixture.whenStable();
    const input = el().querySelector<HTMLInputElement>('#notaLockPassword')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const submit = () => {
    // The fixture is not in the document, so a submit button click does not submit the form.
    el().querySelector<HTMLFormElement>('.nota-lock__card')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    sessionStorage.removeItem('nota.locked');
    timers = configure();
    await TestBed.compileComponents();
    http = TestBed.inject(HttpTestingController);
    signInAs('cashier');
    startIdle(5);
    fixture = TestBed.createComponent(PosWithLockHost);
    fixture.detectChanges();
  });
  afterEach(() => sessionStorage.removeItem('nota.locked'));

  const pos = () => fixture.debugElement.children[0].componentInstance as SellingComponent;
  const product = { id: 'p1', name: 'لمبة', displayLabel: 'لمبة', categoryName: 'لمبات', wholesalePrice: 60, retailPrice: 75, inventoryCount: 9 } as never;

  it('shows "الشاشة مقفولة", the user name, a password field, فتح and دخول بمستخدم تاني', () => {
    timers.advance(5 * MIN);
    fixture.detectChanges();
    expect(overlay()).not.toBeNull();
    expect(overlay()!.textContent).toContain('session.lock.title');
    expect(el().querySelector('[data-test="lock-user"]')!.textContent).toContain('محمود');
    expect(el().querySelector('#notaLockPassword')).not.toBeNull();
    expect(el().querySelector('[data-test="lock-switch"]')).not.toBeNull();
  });

  it('the POS cart survives lock → unlock (the page stays mounted; the token is unchanged)', async () => {
    const before = pos();
    before.addProductToInvoice(product);
    before.stepQuantity(0, 1);
    timers.advance(5 * MIN);
    fixture.detectChanges();
    expect(overlay()).not.toBeNull();

    await type('cash-pass');
    submit();
    const req = http.expectOne(`${base}auth/verify-password`);
    expect(req.request.body).toEqual({ password: 'cash-pass' });
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-cashier');
    req.flush(null, { status: 204, statusText: 'No Content' });
    fixture.detectChanges();

    expect(overlay()).toBeNull();
    expect(pos()).toBe(before);
    expect(pos().invoiceItemStates[0].selectedProduct?.id).toBe('p1');
    expect(Number(pos().getInvoiceItem(0).get('quantity')!.value)).toBe(2);
    expect(TestBed.inject(AuthService).token()).toBe('test-token-cashier');
  });

  it('wrong password: message, overlay stays; 5th → the 429 lockout message, overlay stays', async () => {
    timers.advance(5 * MIN);
    fixture.detectChanges();
    await type('nope');
    submit();
    http.expectOne(`${base}auth/verify-password`).flush({ code: 'WRONG_PASSWORD', message: 'كلمة المرور غير صحيحة' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(overlay()).not.toBeNull();
    expect(el().querySelector('[data-test="lock-error"]')!.textContent).toContain('session.lock.wrongPassword');

    await type('nope');
    submit();
    http.expectOne(`${base}auth/verify-password`).flush({ code: 'LOGIN_LOCKED', retryAfterSeconds: 300 }, { status: 429, statusText: 'Too Many Requests' });
    fixture.detectChanges();
    expect(overlay()).not.toBeNull();
    expect(el().querySelector('[data-test="lock-error"]')!.textContent).toContain('auth.errors.LOGIN_LOCKED');
    expect(TestBed.inject(AuthService).token()).toBe('test-token-cashier');
  });

  it('while locked, new backend requests wait; they are sent after unlock', async () => {
    timers.advance(5 * MIN);
    fixture.detectChanges();
    let answered = false;
    TestBed.inject(HttpClient).get(`${base}customers`).subscribe(() => (answered = true));
    http.expectNone(`${base}customers`);
    await type('cash-pass');
    submit();
    http.expectOne(`${base}auth/verify-password`).flush(null, { status: 204, statusText: 'No Content' });
    http.expectOne(`${base}customers`).flush([]);
    expect(answered).toBeTrue();
  });

  it('"دخول بمستخدم تاني" with a cart: warns first; staying keeps the session; leaving signs out to /login', async () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    pos().addProductToInvoice(product);
    timers.advance(5 * MIN);
    fixture.detectChanges();
    const unsaved = TestBed.inject(UnsavedWorkService);

    el().querySelector<HTMLButtonElement>('[data-test="lock-switch"]')!.click();
    await Promise.resolve();
    expect(unsaved.prompt()).not.toBeNull();
    unsaved.answer(false);
    await fixture.whenStable();
    expect(TestBed.inject(AuthService).token()).toBe('test-token-cashier');
    expect(navigate).not.toHaveBeenCalled();

    el().querySelector<HTMLButtonElement>('[data-test="lock-switch"]')!.click();
    await Promise.resolve();
    unsaved.answer(true);
    await fixture.whenStable();
    expect(TestBed.inject(AuthService).token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('"دخول بمستخدم تاني" with nothing open does not ask', async () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    timers.advance(5 * MIN);
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('[data-test="lock-switch"]')!.click();
    await fixture.whenStable();
    expect(TestBed.inject(UnsavedWorkService).prompt()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });
});

describe('Stage 15: UnsavedWorkService and the route guard', () => {
  beforeEach(() => configure());

  it('nothing registered → confirm() is true without asking', async () => {
    const unsaved = TestBed.inject(UnsavedWorkService);
    expect(await unsaved.confirm()).toBeTrue();
    expect(unsaved.prompt()).toBeNull();
  });

  it('a dirty screen asks; the answer decides; unregister removes the check', async () => {
    const unsaved = TestBed.inject(UnsavedWorkService);
    let dirty = true;
    const unregister = unsaved.register('form', () => dirty);
    const first = unsaved.confirm();
    unsaved.answer(false);
    expect(await first).toBeFalse();
    const second = unsaved.confirm();
    unsaved.answer(true);
    expect(await second).toBeTrue();
    dirty = false;
    expect(await unsaved.confirm()).toBeTrue();
    dirty = true;
    unregister();
    expect(unsaved.hasUnsavedWork()).toBeFalse();
  });

  it('canDeactivate asks; allowNextNavigation() lets one navigation through (forced: session expired, restore)', async () => {
    const unsaved = TestBed.inject(UnsavedWorkService);
    unsaved.register('pos', () => true);
    const guard = () => TestBed.runInInjectionContext(() => unsavedWorkGuard(null as never, null as never, null as never, null as never));
    const asked = guard() as Promise<boolean>;
    expect(unsaved.prompt()).not.toBeNull();
    unsaved.answer(false);
    expect(await asked).toBeFalse();
    unsaved.allowNextNavigation();
    expect(guard()).toBeTrue();
    const again = guard() as Promise<boolean>;
    unsaved.answer(true);
    expect(await again).toBeTrue();
  });
});

describe('Stage 15: interceptor (session end, restore, discount limit)', () => {
  let http: HttpTestingController;
  let navigate: jasmine.Spy;
  beforeEach(() => {
    configure();
    http = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
  });
  afterEach(() => http.verify());

  it('SESSION_EXPIRED with an open POS cart: the cart is kept for the same user, the leave is not asked', () => {
    signInAs('cashier');
    const rescue = TestBed.inject(CartRescueService);
    rescue.register(() => ({ lines: ['x'] }));
    TestBed.inject(UnsavedWorkService).register('pos', () => true);
    TestBed.inject(HttpClient).get(`${base}customers`).subscribe({ error: () => undefined });
    http.expectOne(`${base}customers`).flush({ code: 'SESSION_EXPIRED' }, { status: 401, statusText: 'Unauthorized' });
    expect(rescue.hasSaved()).toBeTrue();
    expect(TestBed.inject(UnsavedWorkService).consumeBypass()).toBeTrue();
    expect(rescue.take('id-manager')).toBeNull();
    expect(rescue.hasSaved()).toBeFalse();
  });

  it('the same user gets the kept cart back once', () => {
    signInAs('cashier');
    const rescue = TestBed.inject(CartRescueService);
    rescue.register(() => ({ lines: ['x'] }));
    TestBed.inject(HttpClient).get(`${base}customers`).subscribe({ error: () => undefined });
    http.expectOne(`${base}customers`).flush({ code: 'SESSION_EXPIRED' }, { status: 401, statusText: 'Unauthorized' });
    expect(rescue.take<{ lines: string[] }>('id-cashier')).toEqual({ lines: ['x'] });
    expect(rescue.take('id-cashier')).toBeNull();
  });

  it('reason DATA_RESTORED → /login with reason=restored (no returnUrl, no cart kept)', () => {
    signInAs('cashier');
    const rescue = TestBed.inject(CartRescueService);
    rescue.register(() => ({ lines: ['x'] }));
    TestBed.inject(HttpClient).get(`${base}customers`).subscribe({ error: () => undefined });
    http.expectOne(`${base}customers`).flush({ code: 'SESSION_EXPIRED', reason: 'DATA_RESTORED' }, { status: 401, statusText: 'Unauthorized' });
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { reason: 'restored' } });
    expect(rescue.hasSaved()).toBeFalse();
  });

  it('403 DISCOUNT_LIMIT shows the server message as a toast', async () => {
    signInAs('manager');
    TestBed.inject(HttpClient).post(`${base}sellings`, {}).subscribe({ error: () => undefined });
    http.expectOne(`${base}sellings`).flush({ code: 'DISCOUNT_LIMIT', message: 'أقصى خصم مسموح لك 10٪' }, { status: 403, statusText: 'Forbidden' });
    const { ToastService } = await import('./toast.service');
    expect(TestBed.inject(ToastService).toasts().map((t) => t.text)).toContain('أقصى خصم مسموح لك 10٪');
  });
});
