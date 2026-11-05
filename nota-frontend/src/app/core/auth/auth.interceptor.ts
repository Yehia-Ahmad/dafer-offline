import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { catchError, defer, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { UnsavedWorkService } from '../unsaved-work/unsaved-work.service';
import { AuthService, HANDLES_OWN_ERRORS } from './auth.service';
import { errorCode, errorMessage, lockedMinutes } from './auth-errors';
import { CartRescueService } from './cart-rescue.service';
import { LockStateService } from './lock-state.service';
import { ToastService } from './toast.service';

/**
 * Stage 15: requests that must still run while locked. verify-password opens the screen; /me is
 * the read-only startup check needed after a locked-window reload so the user and overlay can be
 * restored. Everything else waits for unlock.
 */
const ALLOWED_WHILE_LOCKED = /\/auth\/(?:verify-password|me)$/;

/**
 * Stage 14 (replaces the online edition's httpconfig/logout/request-online interceptors).
 * - Adds `Authorization: Bearer` to backend requests. The LAN key header is added by the desktop
 *   app itself (Electron session), so both are sent.
 * - 401 SESSION_EXPIRED → the session is cleared and the user goes to /login, keeping returnUrl.
 *   Stage 15: an open POS invoice is kept for the same user (CartRescueService), the leave is not
 *   asked about, and reason DATA_RESTORED (a backup was restored) shows the restore message.
 * - 403 FORBIDDEN / DISCOUNT_LIMIT → a toast with the server message; the user stays on the page.
 * - 429 LOGIN_LOCKED → a toast with the minutes left.
 * - Stage 15: while the screen is locked, new backend requests wait until it is unlocked
 *   (requests already running finish normally; the token never changes).
 * Requests marked HANDLES_OWN_ERRORS (login screen, change password, unlock) show their errors themselves.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const lockState = inject(LockStateService);
  // Resolved only when an error needs them: the translation files themselves load through this
  // interceptor while TranslateService is still being created (an eager inject would be circular).
  const injector = inject(Injector);
  const translate = () => injector.get(TranslateService);
  const toast = () => injector.get(ToastService);

  const toBackend = Boolean(environment.api_base_url) && req.url.startsWith(environment.api_base_url);
  const ownErrors = req.context.get(HANDLES_OWN_ERRORS);
  const withToken = (request: HttpRequest<unknown>) => {
    const token = auth.token();
    return token && toBackend ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request;
  };

  const waitsForUnlock = toBackend && lockState.locked() && !ALLOWED_WHILE_LOCKED.test(req.url);
  const send = waitsForUnlock
    ? lockState.whenUnlocked().pipe(switchMap(() => next(withToken(req))))
    : defer(() => next(withToken(req)));

  return send.pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && toBackend && !ownErrors) {
        const code = errorCode(error);
        if (error.status === 401 && code === 'SESSION_EXPIRED') {
          if (auth.token()) endSession(injector, auth, error);
        } else if (error.status === 403 && (code === 'FORBIDDEN' || code === 'DISCOUNT_LIMIT')) {
          const message = errorMessage(error);
          if (message) toast().error(message);
          else translate().get(`auth.errors.${code}`).subscribe((text: string) => toast().error(text));
        } else if (error.status === 429 && code === 'LOGIN_LOCKED') {
          translate().get('auth.errors.LOGIN_LOCKED', { minutes: lockedMinutes(error) }).subscribe((text: string) => toast().error(text));
        }
      }
      return throwError(() => error);
    })
  );
};

function endSession(injector: Injector, auth: AuthService, error: HttpErrorResponse): void {
  const router = injector.get(Router);
  const restored = (error.error as { reason?: unknown } | null)?.reason === 'DATA_RESTORED';
  const current = router.url;
  // Stage 15: keep an open POS invoice for this user, then leave without the unsaved-work question.
  if (!restored) injector.get(CartRescueService).capture(auth.user()?._id);
  injector.get(UnsavedWorkService).allowNextNavigation();
  auth.clear();
  const onLogin = current.startsWith('/login');
  router.navigate(['/login'], {
    queryParams: {
      reason: restored ? 'restored' : 'expired',
      ...(restored || onLogin || current === '/' ? {} : { returnUrl: current }),
    },
  });
}
