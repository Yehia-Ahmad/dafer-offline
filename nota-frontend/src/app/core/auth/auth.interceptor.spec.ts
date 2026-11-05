import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { authInterceptor } from './auth.interceptor';
import { AuthService, HANDLES_OWN_ERRORS } from './auth.service';
import { ToastService } from './toast.service';
import { signInAs } from './testing/sign-in';

describe('authInterceptor (Stage 14)', () => {
  const base = environment.api_base_url;
  let http: HttpTestingController;
  let client: HttpClient;
  let router: Router;
  let navigate: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    router = TestBed.inject(Router);
    navigate = spyOn(router, 'navigate').and.resolveTo(true);
  });

  afterEach(() => http.verify());

  it('adds Authorization: Bearer to backend requests only', () => {
    signInAs('cashier');
    client.get(`${base}products`).subscribe();
    client.get('./assets/i18n/ar.json').subscribe();
    expect(http.expectOne(`${base}products`).request.headers.get('Authorization')).toBe('Bearer test-token-cashier');
    expect(http.expectOne('./assets/i18n/ar.json').request.headers.has('Authorization')).toBeFalse();
  });

  it('no token → no Authorization header', () => {
    client.get(`${base}auth/bootstrap`).subscribe();
    expect(http.expectOne(`${base}auth/bootstrap`).request.headers.has('Authorization')).toBeFalse();
  });

  it('401 SESSION_EXPIRED → session cleared, /login with reason=expired and returnUrl of the current page', () => {
    const auth = signInAs('cashier');
    spyOnProperty(router, 'url', 'get').and.returnValue('/customers/c1?tab=invoices');
    let failed = false;
    client.get(`${base}customers/c1`).subscribe({ error: () => (failed = true) });
    http.expectOne(`${base}customers/c1`).flush({ message: 'انتهت الجلسة', code: 'SESSION_EXPIRED' }, { status: 401, statusText: 'Unauthorized' });
    expect(failed).toBeTrue();
    expect(auth.token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { reason: 'expired', returnUrl: '/customers/c1?tab=invoices' } });
  });

  it('403 FORBIDDEN → a toast with the server message; stays on the page', () => {
    signInAs('cashier');
    const toast = spyOn(TestBed.inject(ToastService), 'error');
    client.delete(`${base}products/p1`).subscribe({ error: () => undefined });
    http.expectOne(`${base}products/p1`).flush({ message: 'ليست لديك صلاحية للقيام بهذه العملية', code: 'FORBIDDEN' }, { status: 403, statusText: 'Forbidden' });
    expect(toast).toHaveBeenCalledWith('ليست لديك صلاحية للقيام بهذه العملية');
    expect(navigate).not.toHaveBeenCalled();
    expect(TestBed.inject(AuthService).signedIn()).toBeTrue();
  });

  it('429 LOGIN_LOCKED → a toast with the minutes left (from retryAfterSeconds)', () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('ar', { auth: { errors: { LOGIN_LOCKED: 'استنى {{minutes}} دقيقة' } } });
    translate.use('ar');
    const toast = spyOn(TestBed.inject(ToastService), 'error');
    client.post(`${base}auth/change-password`, {}).subscribe({ error: () => undefined });
    http.expectOne(`${base}auth/change-password`).flush({ code: 'LOGIN_LOCKED', retryAfterSeconds: 181 }, { status: 429, statusText: 'Too Many' });
    // ceil(181 / 60) = 4 minutes
    expect(toast).toHaveBeenCalledWith('استنى 4 دقيقة');
  });

  it('requests that handle their own errors (login screen) get no toast and no redirect', () => {
    const toast = spyOn(TestBed.inject(ToastService), 'error');
    const context = new HttpContext().set(HANDLES_OWN_ERRORS, true);
    client.post(`${base}auth/login`, {}, { context }).subscribe({ error: () => undefined });
    http.expectOne(`${base}auth/login`).flush({ code: 'LOGIN_LOCKED', retryAfterSeconds: 60 }, { status: 429, statusText: 'Too Many' });
    client.post(`${base}auth/login`, {}, { context }).subscribe({ error: () => undefined });
    http.expectOne(`${base}auth/login`).flush({ code: 'INVALID_CREDENTIALS' }, { status: 401, statusText: 'Unauthorized' });
    expect(toast).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('lockedMinutes', () => {
  it('rounds up, at least 1', async () => {
    const { lockedMinutes } = await import('./auth-errors');
    expect(lockedMinutes({ error: { retryAfterSeconds: 181 } })).toBe(4);
    expect(lockedMinutes({ error: { retryAfterSeconds: 10 } })).toBe(1);
    expect(lockedMinutes({ error: {} })).toBe(5);
  });
});

describe('authInterceptor + translation loader (Stage 14 regression)', () => {
  it('the i18n files load through the interceptor (no circular TranslateService injection)', async () => {
    const { provideTranslateService, TranslateService: Translate } = await import('@ngx-translate/core');
    const { provideTranslateHttpLoader } = await import('@ngx-translate/http-loader');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideTranslateService({ loader: provideTranslateHttpLoader({ prefix: './assets/i18n/', suffix: '.json' }), fallbackLang: 'en', lang: 'ar' }),
      ],
    });
    const translate = TestBed.inject(Translate);
    const http = TestBed.inject(HttpTestingController);
    http.match((r) => r.url.includes('/i18n/')).forEach((r) =>
      r.flush(r.request.url.endsWith('ar.json') ? { auth: { login: { submit: 'دخول' } } } : { auth: { login: { submit: 'Sign in' } } }));
    await new Promise((resolve) => setTimeout(resolve));
    expect(translate.instant('auth.login.submit')).toBe('دخول');
  });
});
