import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Router } from '@angular/router';

export const logoutInterceptor: HttpInterceptorFn = (req, next) => {
  const _router = inject(Router);
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
        // Clear local storage
        localStorage.clear();

        // redirect to the login page
        _router.navigate(['/login']);
      }

      // Propagate the error
      return throwError(() => error);
    })
  );
}
