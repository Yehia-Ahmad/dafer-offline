import { HttpErrorResponse } from '@angular/common/http';

/** The backend's error code (`{ message, code }`), if any. */
export function errorCode(error: unknown): string | null {
  const body = error instanceof HttpErrorResponse ? error.error : (error as { error?: unknown })?.error;
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

/** The backend's Arabic message, if any. */
export function errorMessage(error: unknown): string {
  const body = error instanceof HttpErrorResponse ? error.error : (error as { error?: unknown })?.error;
  const message = body && typeof body === 'object' ? (body as { message?: unknown }).message : null;
  return typeof message === 'string' ? message : '';
}

/** 429 LOGIN_LOCKED: whole minutes left (at least 1), from retryAfterSeconds. */
export function lockedMinutes(error: unknown): number {
  const body = error instanceof HttpErrorResponse ? error.error : (error as { error?: unknown })?.error;
  const seconds = Number(body && typeof body === 'object' ? (body as { retryAfterSeconds?: unknown }).retryAfterSeconds : NaN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 5;
}
