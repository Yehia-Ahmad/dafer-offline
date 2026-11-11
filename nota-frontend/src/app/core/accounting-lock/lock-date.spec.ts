import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse, HttpRequest, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { authInterceptor } from '../auth/auth.interceptor';
import { signInAs } from '../auth/testing/sign-in';
import { NotaLockBannerComponent, NotaLockedDateDirective } from '../../modules/shared/ui';
import { LockDateService } from './lock-date.service';

const base = environment.api_base_url;

describe('LockDateService (Stage 22)', () => {
  let lock: LockDateService;
  beforeEach(() => { TestBed.configureTestingModule({}); lock = TestBed.inject(LockDateService); });

  it('no lock: nothing is locked, no minimum date, an empty label', () => {
    expect(lock.lockedThrough()).toBeNull();
    expect(lock.minOpenKey()).toBeNull();
    expect(lock.minOpenDate()).toBeNull();
    expect(lock.label()).toBe('');
    expect(lock.isLocked('2020-01-01')).toBeFalse();
  });

  it('a lock date: the first open day is the next one (across a month and a year end), the label is dd/mm/yyyy', () => {
    lock.set('2026-10-31');
    expect(lock.minOpenKey()).toBe('2026-11-01');
    expect(lock.minOpenDate()?.getTime()).toBe(new Date(2026, 10, 1).getTime());
    expect(lock.label()).toBe('31/10/2026');
    lock.set('2026-12-31');
    expect(lock.minOpenKey()).toBe('2027-01-01');
  });

  it('isLocked: on or before the lock date, for a day key and for a local Date; a bad value clears the lock', () => {
    lock.set('2026-10-31');
    expect(lock.isLocked('2026-10-31')).toBeTrue();
    expect(lock.isLocked('2026-10-01')).toBeTrue();
    expect(lock.isLocked('2026-11-01')).toBeFalse();
    expect(lock.isLocked(new Date(2026, 9, 31, 23, 59))).toBeTrue();
    expect(lock.isLocked(new Date(2026, 10, 1, 0, 1))).toBeFalse();
    expect(lock.isLocked(null)).toBeFalse();
    lock.set('not a date');
    expect(lock.lockedThrough()).toBeNull();
    lock.set(undefined);
    expect(lock.lockedThrough()).toBeNull();
  });
});

@Component({
  selector: 'app-lock-host',
  imports: [FormsModule, NotaLockedDateDirective, NotaLockBannerComponent],
  template: `<input id="d" type="date" notaLockedDate [ngModel]="picked()" (ngModelChange)="picked.set($event)" /><nota-lock-banner [selected]="picked()" />`,
})
class HostComponent { readonly picked = signal('2026-11-05'); }

describe('lock banner and the date input directive (Stage 22)', () => {
  const setup = () => {
    TestBed.configureTestingModule({ imports: [HostComponent, TranslateModule.forRoot()] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return { fixture, lock: TestBed.inject(LockDateService), el: fixture.nativeElement as HTMLElement };
  };

  it('no lock: no banner and no min on the date input', () => {
    const { el } = setup();
    expect(el.querySelector('[data-test="lock-banner"]')).toBeNull();
    expect(el.querySelector('input')?.getAttribute('min')).toBeNull();
  });

  it('a lock: the date input starts at the first open day and the banner says the period is closed', () => {
    const { fixture, lock, el } = setup();
    lock.set('2026-10-31');
    fixture.detectChanges();
    expect(el.querySelector('input')?.getAttribute('min')).toBe('2026-11-01');
    const banner = el.querySelector('[data-test="lock-banner"]') as HTMLElement;
    expect(banner.textContent).toContain('lock.banner');
    expect(banner.classList).not.toContain('nota-lock-banner--blocked');
  });

  it('a selected date inside the closed period turns the banner into the error', () => {
    const { fixture, lock, el } = setup();
    lock.set('2026-10-31');
    fixture.componentInstance.picked.set('2026-10-15');
    fixture.detectChanges();
    const banner = el.querySelector('[data-test="lock-banner"]') as HTMLElement;
    expect(banner.textContent).toContain('lock.selectedLocked');
    expect(banner.classList).toContain('nota-lock-banner--blocked');
  });
});

describe('the lock date comes with login, /me and a PERIOD_LOCKED error (Stage 22)', () => {
  let http: HttpTestingController;
  let auth: AuthService;
  let lock: LockDateService;
  const user = { _id: 'u1', name: 'أحمد', username: 'owner', role: 'owner', permissions: [], permissionsEdited: false, isActive: true, lastLoginAt: null };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()], imports: [TranslateModule.forRoot()] });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    lock = TestBed.inject(LockDateService);
  });
  afterEach(() => http.verify());

  it('login with lockedThrough sets it; /me without it clears it (the period was reopened)', () => {
    auth.login('owner', 'pw').subscribe();
    http.expectOne(`${base}auth/login`).flush({ user, token: 't', permissions: ['sales.view'], lockedThrough: '2026-10-31' });
    expect(lock.lockedThrough()).toBe('2026-10-31');
    auth.refreshMe().subscribe();
    http.expectOne(`${base}auth/me`).flush({ user, permissions: ['sales.view'] });
    expect(lock.lockedThrough()).toBeNull();
    auth.refreshMe().subscribe();
    http.expectOne(`${base}auth/me`).flush({ user, permissions: ['sales.view'], lockedThrough: '2026-09-30' });
    expect(lock.lockedThrough()).toBe('2026-09-30');
  });

  it('signing out forgets the lock date', () => {
    lock.set('2026-10-31');
    signInAs('owner');
    auth.logout();
    expect(lock.lockedThrough()).toBeNull();
  });

  it('a 409 PERIOD_LOCKED error carries the lock date (another PC closed a period): the service takes it, the error still reaches the form', () => {
    signInAs('owner');
    let failure: HttpErrorResponse | null = null;
    TestBed.inject(HttpClient).post(`${base}expenses`, {}).subscribe({ error: (error) => { failure = error; } });
    http.expectOne(`${base}expenses`).flush({ message: 'الفترة دي مقفولة لحد 31/10/2026', code: 'PERIOD_LOCKED', lockedThrough: '2026-10-31' }, { status: 409, statusText: 'Conflict' });
    expect(lock.lockedThrough()).toBe('2026-10-31');
    expect((failure as HttpErrorResponse | null)?.status).toBe(409);
    expect(((failure as HttpErrorResponse | null)?.error as { message: string }).message).toContain('31/10/2026');
  });

  it('other 409 errors leave the lock alone', () => {
    signInAs('owner');
    lock.set('2026-10-31');
    TestBed.inject(HttpClient).post(`${base}expenses`, {}).subscribe({ error: () => undefined });
    http.expectOne(`${base}expenses`).flush({ message: 'x', code: 'BOX_INACTIVE' }, { status: 409, statusText: 'Conflict' });
    expect(lock.lockedThrough()).toBe('2026-10-31');
    void HttpRequest; void HttpResponse;
  });
});
