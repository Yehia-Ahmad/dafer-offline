import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { AuthService, HANDLES_OWN_ERRORS } from './auth.service';
import { fakeUser, ROLE_PERMISSIONS } from './testing/auth-fixtures';
import { signInAs, signInWith } from './testing/sign-in';

describe('AuthService (Stage 14)', () => {
  const base = environment.api_base_url;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.removeItem('nota.session');
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    sessionStorage.clear();
  });

  it('login: POST auth/login {username, password}; keeps user, permissions and token (sessionStorage only, never localStorage)', () => {
    const auth = TestBed.inject(AuthService);
    let done = false;
    auth.login('mahmoud', 'secret-1').subscribe(() => (done = true));
    const req = http.expectOne(`${base}auth/login`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ username: 'mahmoud', password: 'secret-1' });
    expect(req.request.context.get(HANDLES_OWN_ERRORS)).toBeTrue();
    req.flush({ user: fakeUser('cashier'), token: 'tok-1', permissions: ROLE_PERMISSIONS.cashier });
    expect(done).toBeTrue();
    expect(auth.token()).toBe('tok-1');
    expect(auth.user()?.role).toBe('cashier');
    expect(auth.signedIn()).toBeTrue();
    expect(sessionStorage.getItem('nota.session')).toBe('tok-1');
    expect(localStorage.getItem('nota.session')).toBeNull();
    expect(Object.keys(localStorage).some((key) => localStorage.getItem(key) === 'tok-1')).toBeFalse();
  });

  it('has / hasAll / hasAny', () => {
    const auth = signInWith(['sales.create', 'sales.view']);
    expect(auth.has('sales.create')).toBeTrue();
    expect(auth.has('sales.delete')).toBeFalse();
    expect(auth.hasAll('sales.create', 'sales.view')).toBeTrue();
    expect(auth.hasAll('sales.create', 'sales.delete')).toBeFalse();
    expect(auth.hasAny('sales.delete', 'sales.view')).toBeTrue();
    expect(auth.hasAny('sales.delete', 'users.manage')).toBeFalse();
  });

  it('first allowed page per role template (sidebar order)', () => {
    expect(signInAs('owner').firstAllowedPath()).toBe('/home');
    expect(signInAs('manager').firstAllowedPath()).toBe('/home');
    expect(signInAs('cashier').firstAllowedPath()).toBe('/home');
    expect(signInAs('storekeeper').firstAllowedPath()).toBe('/products');
    expect(signInAs('accountant').firstAllowedPath()).toBe('/home');
    // A cashier whose dashboard was removed lands on the POS.
    expect(signInWith(ROLE_PERMISSIONS.cashier.filter((key) => key !== 'dashboard.view')).firstAllowedPath()).toBe('/selling');
    expect(signInWith([]).firstAllowedPath()).toBe('/no-access');
  });

  it('not signed in → /login', () => {
    expect(TestBed.inject(AuthService).firstAllowedPath()).toBe('/login');
  });

  it('setup-owner, recover and change-password: exact bodies; the returned token replaces the old one', () => {
    const auth = TestBed.inject(AuthService);
    auth.setupOwner({ name: 'أحمد', username: 'ahmed', password: 'owner-pass' }).subscribe();
    let req = http.expectOne(`${base}auth/setup-owner`);
    expect(req.request.body).toEqual({ name: 'أحمد', username: 'ahmed', password: 'owner-pass' });
    req.flush({ user: fakeUser('owner'), token: 't-setup', permissions: ROLE_PERMISSIONS.owner, recoveryCode: 'ABCD-EFGH-JKLM-NPQR' });
    expect(auth.token()).toBe('t-setup');

    auth.changePassword('owner-pass', 'new-pass-1').subscribe();
    req = http.expectOne(`${base}auth/change-password`);
    expect(req.request.body).toEqual({ currentPassword: 'owner-pass', newPassword: 'new-pass-1' });
    req.flush({ user: fakeUser('owner'), token: 't-changed', permissions: ROLE_PERMISSIONS.owner });
    expect(auth.token()).toBe('t-changed');
    expect(sessionStorage.getItem('nota.session')).toBe('t-changed');

    auth.recover({ username: 'ahmed', recoveryCode: 'ABCD-EFGH-JKLM-NPQR', newPassword: 'again-123' }).subscribe();
    req = http.expectOne(`${base}auth/recover`);
    expect(req.request.body).toEqual({ username: 'ahmed', recoveryCode: 'ABCD-EFGH-JKLM-NPQR', newPassword: 'again-123' });
    req.flush({ user: fakeUser('owner'), token: 't-recovered', permissions: ROLE_PERMISSIONS.owner, recoveryCode: 'WXYZ-WXYZ-WXYZ-WXYZ' });
    expect(auth.token()).toBe('t-recovered');
  });

  it('bootstrap: GET auth/bootstrap', () => {
    TestBed.inject(AuthService).bootstrap().subscribe();
    const req = http.expectOne(`${base}auth/bootstrap`);
    expect(req.request.method).toBe('GET');
    req.flush({ hasOwner: true, isLocal: true, shop: { name: '', logo: '' } });
  });

  it('app start with a stored token: GET auth/me fills user and permissions', async () => {
    sessionStorage.setItem('nota.session', 'stored-token-123');
    const auth = TestBed.inject(AuthService);
    expect(auth.token()).toBe('stored-token-123');
    const restoring = auth.restore();
    http.expectOne(`${base}auth/me`).flush({ user: fakeUser('cashier'), permissions: ROLE_PERMISSIONS.cashier });
    await restoring;
    expect(auth.signedIn()).toBeTrue();
    expect(auth.has('sales.create')).toBeTrue();
  });

  it('app start with a stale token: auth/me fails → the session is cleared (the guards send the user to /login)', async () => {
    sessionStorage.setItem('nota.session', 'stale-token-123');
    const auth = TestBed.inject(AuthService);
    const restoring = auth.restore();
    http.expectOne(`${base}auth/me`).flush({ code: 'SESSION_EXPIRED' }, { status: 401, statusText: 'Unauthorized' });
    await restoring;
    expect(auth.token()).toBeNull();
    expect(auth.signedIn()).toBeFalse();
    expect(sessionStorage.getItem('nota.session')).toBeNull();
  });

  it('no stored token: no request at start', async () => {
    await TestBed.inject(AuthService).restore();
    http.expectNone(`${base}auth/me`);
  });

  it('logout clears memory and sessionStorage', () => {
    const auth = signInAs('owner');
    sessionStorage.setItem('nota.session', 'x-token-123');
    auth.logout();
    expect(auth.token()).toBeNull();
    expect(auth.user()).toBeNull();
    expect(auth.permissions()).toEqual([]);
    expect(sessionStorage.getItem('nota.session')).toBeNull();
  });

  it('permission catalog: GET auth/permissions', () => {
    TestBed.inject(AuthService).permissionCatalog().subscribe();
    http.expectOne(`${base}auth/permissions`).flush({ permissions: [], groups: {}, roles: [] });
  });
});
