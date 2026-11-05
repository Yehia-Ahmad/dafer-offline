import { inject } from '@angular/core';
import { CanActivateFn, RedirectFunction, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from './auth.service';
import { RouteRule } from './route-permissions';
import { ToastService } from './toast.service';

/** Signed in, else /login (keeping where they wanted to go). */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  if (auth.signedIn()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: state.url && state.url !== '/' ? { returnUrl: state.url } : {} });
};

/** /login: a signed-in user goes to their first allowed page. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.signedIn() ? inject(Router).parseUrl(auth.firstAllowedPath()) : true;
};

/**
 * The page's permission rule (route-permissions.ts). Not signed in → /login. Without the
 * permission → the user's first allowed page, with one toast "مش عندك صلاحية تفتح الصفحة دي".
 */
export function permissionGuard(rule: RouteRule): CanActivateFn {
  return (route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.signedIn()) return authGuard(route, state);
    if (auth.allows(rule)) return true;
    // get(), not instant(): on the app's first navigation the translation files may still be loading.
    const toast = inject(ToastService);
    inject(TranslateService).get('auth.noPagePermission').subscribe((text: string) => toast.error(text));
    return router.parseUrl(auth.firstAllowedPath());
  };
}

/** "" and unknown paths: the first allowed page (or /login). */
export const landingRedirect: RedirectFunction = () => {
  const auth = inject(AuthService);
  return inject(Router).parseUrl(auth.firstAllowedPath());
};
