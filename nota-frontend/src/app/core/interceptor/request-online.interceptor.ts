import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent } from '@angular/common/http';
import { Observable, of, throwError, fromEvent, merge } from 'rxjs';
import { retryWhen, mergeMap, delay, map } from 'rxjs/operators';
import { isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { inject } from '@angular/core';

// Constants
const MAX_RETRIES = 5;
const DEFAULT_BACKOFF = 3000;

// Function to check network status
const checkNetworkStatus = (isBrowser: boolean) => {
  if (!isBrowser) {
    // Return a function that always returns true on the server
    return () => true;
  }

  let isOnline = navigator.onLine;

  merge(
    of(null),
    fromEvent(window, 'online'),
    fromEvent(window, 'offline')
  )
    .pipe(map(() => navigator.onLine))
    .subscribe(status => {
      isOnline = status;
    });

  return () => isOnline; // Return a function to get the current network status
};

export const requestOnlineInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn): Observable<HttpEvent<any>> => {
  const platformId = inject(PLATFORM_ID);
  const isBrowser = isPlatformBrowser(platformId);

  const getNetworkStatus = checkNetworkStatus(isBrowser);

  let retries = MAX_RETRIES;
  let delayTime = DEFAULT_BACKOFF;

  return next(req).pipe(
    retryWhen((errors: Observable<any>) => errors.pipe(
      mergeMap(error => {
        if (!getNetworkStatus() && error.status === 0) { // Offline
          if (retries-- > 0) {
            const backOffTime = delayTime + (MAX_RETRIES - retries) * DEFAULT_BACKOFF;
            return of(error).pipe(delay(backOffTime));
          }
        }
        retries = MAX_RETRIES; // Reset retries
        delayTime = DEFAULT_BACKOFF; // Reset delay time
        return throwError(error); // Throw error if retries exhausted
      })
    ))
  );
};