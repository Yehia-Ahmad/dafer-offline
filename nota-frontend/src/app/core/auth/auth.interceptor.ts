import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService, HANDLES_OWN_ERRORS } from './auth.service';
import { errorCode, errorMessage, lockedMinutes } from './auth-errors';
import { ToastService } from './toast.service';

/**
 * Stage 14 (replaces the online edition's httpconfig/logout/request-online interceptors).
 * - Adds `Authorization: Bearer` to backend requests. The LAN key header is added by the desktop
 *   app itself (Electron session), so both are sent.
 * - 401 SESSION_EXPIRED → the session is cleared and the user goes to /login, keeping returnUrl.
 * - 403 FORBIDDEN → a toast with the server message; the user stays on the page.
 * - 429 LOGIN_LOCKED → a toast with the minutes left.
 * Requests marked HANDLES_OWN_ERRORS (login screen, change password) show their errors themselves.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  // Resolved only when an error needs them: the translation files themselves load through this
  // interceptor while TranslateService is still being created (an eager inject would be circular).
  const injector = inject(Injector);
  const translate = () => injector.get(TranslateService);
  const toast = () => injector.get(ToastService);

  const token = auth.token();
  const toBackend = Boolean(environment.api_base_url) && req.url.startsWith(environment.api_base_url);
  const outgoing = token && toBackend ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  const ownErrors = req.context.get(HANDLES_OWN_ERRORS);

  return next(outgoing).pipe(
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && toBackend && !ownErrors) {
        const code = errorCode(error);
        if (error.status === 401 && code === 'SESSION_EXPIRED') {
          if (auth.token()) {
            const router = injector.get(Router);
            const current = router.url;
            auth.clear();
            const onLogin = current.startsWith('/login');
            router.navigate(['/login'], {
              queryParams: { reason: 'expired', ...(onLogin || current === '/' ? {} : { returnUrl: current }) },
            });
          }
        } else if (error.status === 403 && code === 'FORBIDDEN') {
          const message = errorMessage(error);
          if (message) toast().error(message);
          else translate().get('auth.errors.FORBIDDEN').subscribe((text: string) => toast().error(text));
        } else if (error.status === 429 && code === 'LOGIN_LOCKED') {
          translate().get('auth.errors.LOGIN_LOCKED', { minutes: lockedMinutes(error) }).subscribe((text: string) => toast().error(text));
        }
      }
      return throwError(() => error);
    })
  );
};
