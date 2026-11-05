import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { authGuard, guestGuard, landingRedirect, permissionGuard } from './auth.guards';
import { ROUTE_RULES } from './route-permissions';
import { ToastService } from './toast.service';
import { signInAs, signInWith } from './testing/sign-in';
import { ROLE_PERMISSIONS } from './testing/auth-fixtures';
import { routes } from '../../app.routes';

describe('auth guards (Stage 14)', () => {
  const route = {} as ActivatedRouteSnapshot;
  const state = (url: string) => ({ url }) as RouterStateSnapshot;
  const run = (guard: (r: ActivatedRouteSnapshot, s: RouterStateSnapshot) => unknown, url = '/x') =>
    TestBed.runInInjectionContext(() => guard(route, state(url)));
  const asUrl = (value: unknown) => (value instanceof UrlTree ? TestBed.inject(Router).serializeUrl(value) : value);

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('authGuard: not signed in → /login with returnUrl', () => {
    expect(asUrl(run(authGuard, '/customers/c1'))).toBe('/login?returnUrl=%2Fcustomers%2Fc1');
    signInAs('cashier');
    expect(run(authGuard)).toBeTrue();
  });

  it('permissionGuard: allowed → true', () => {
    signInAs('cashier');
    expect(run(permissionGuard(ROUTE_RULES.selling))).toBeTrue();
  });

  it('permissionGuard: refused → the first allowed page, with one toast "مش عندك صلاحية تفتح الصفحة دي"', () => {
    const toast = spyOn(TestBed.inject(ToastService), 'error');
    signInAs('cashier');
    expect(asUrl(run(permissionGuard(ROUTE_RULES.users)))).toBe('/home');
    expect(toast).toHaveBeenCalledOnceWith('auth.noPagePermission');

    signInAs('storekeeper');
    expect(asUrl(run(permissionGuard(ROUTE_RULES.selling)))).toBe('/products');

    // A cashier without the dashboard: /home sends them to the POS.
    signInWith(ROLE_PERMISSIONS.cashier.filter((key) => key !== 'dashboard.view'));
    expect(asUrl(run(permissionGuard(ROUTE_RULES.home)))).toBe('/selling');
  });

  it('permissionGuard: not signed in → /login (no toast)', () => {
    const toast = spyOn(TestBed.inject(ToastService), 'error');
    expect(asUrl(run(permissionGuard(ROUTE_RULES.home), '/home'))).toBe('/login?returnUrl=%2Fhome');
    expect(toast).not.toHaveBeenCalled();
  });

  it('profit report needs reports.profit AND products.viewCost; returns needs either returns key', () => {
    signInWith(['reports.profit']);
    expect(run(permissionGuard(ROUTE_RULES.profitReport))).not.toBeTrue();
    signInWith(['reports.profit', 'products.viewCost']);
    expect(run(permissionGuard(ROUTE_RULES.profitReport))).toBeTrue();
    signInWith(['returns.create']);
    expect(run(permissionGuard(ROUTE_RULES.returns))).toBeTrue();
    signInWith(['returns.view']);
    expect(run(permissionGuard(ROUTE_RULES.returns))).toBeTrue();
  });

  it('/products/new needs products.manage + products.viewCost; edit needs products.manage only', () => {
    signInWith(['products.view', 'products.manage', 'categories.manage']);
    expect(asUrl(run(permissionGuard(ROUTE_RULES.productNew)))).toBe('/products');
    expect(run(permissionGuard(ROUTE_RULES.productForm))).toBeTrue();
    signInAs('storekeeper');
    expect(run(permissionGuard(ROUTE_RULES.productNew))).toBeTrue();
    signInAs('cashier');
    expect(run(permissionGuard(ROUTE_RULES.productNew))).not.toBeTrue();
  });

  it('backup needs backup.manage and the main PC (outside the desktop app: never)', () => {
    signInAs('owner');
    expect(run(permissionGuard(ROUTE_RULES.backup))).not.toBeTrue();
  });

  it('guestGuard (/login): signed in → first allowed page', () => {
    expect(run(guestGuard)).toBeTrue();
    signInAs('storekeeper');
    expect(asUrl(run(guestGuard))).toBe('/products');
  });

  it('landing ("" and unknown paths): first allowed page, or /login', () => {
    const land = () => asUrl(TestBed.runInInjectionContext(() => (landingRedirect as () => unknown)()));
    expect(land()).toBe('/login');
    signInAs('accountant');
    expect(land()).toBe('/home');
  });
});

describe('app routes (Stage 14 route → permission map)', () => {
  const byPath = (path: string) => routes.find((route) => route.path === path)!;

  it('every page except /login, redirects and the fallback has a guard', () => {
    const open = routes.filter((route) => !route.redirectTo && route.path !== 'login' && !route.canActivate?.length);
    expect(open.map((route) => route.path)).toEqual([]);
  });

  it('/admins is gone; /users and /audit exist', () => {
    expect(routes.some((route) => route.path === 'admins')).toBeFalse();
    expect(byPath('users')).toBeDefined();
    expect(byPath('audit')).toBeDefined();
  });

  it('/backup keeps the main-PC guard and adds backup.manage', () => {
    expect(byPath('backup').canMatch?.length).toBe(1);
    expect(byPath('backup').canActivate?.length).toBe(1);
  });

  it('/products/new uses the create rule, /products/edit/:id the edit rule', () => {
    expect(byPath('products/new').canActivate?.length).toBe(1);
    expect(byPath('products/edit/:id').canActivate?.length).toBe(1);
    expect(ROUTE_RULES.productNew.all).toEqual(['products.manage', 'products.viewCost']);
    expect(ROUTE_RULES.productForm.all).toEqual(['products.manage']);
  });

  it('/login is outside the frame', () => {
    expect(byPath('login').data?.['frame']).toBeFalse();
  });
});
