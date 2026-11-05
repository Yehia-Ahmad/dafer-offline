import { TranslateService } from '@ngx-translate/core';
import { errorCode, errorMessage, lockedMinutes } from '../../core/auth/auth-errors';
import { AUTH_ERROR_CODES } from '../../core/auth/auth.models';

/** Codes with one fixed meaning: our own text (auth.errors.<code>). */
const OWN_TEXT = new Set<string>(AUTH_ERROR_CODES.filter((code) => code !== 'PASSWORD_INVALID' && code !== 'VALIDATION_ERROR'));

/** Same limits as the backend (User.passwordProblem): 6–128 characters. */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;

export function passwordProblemKey(password: string): string | null {
  if (!password) return 'auth.validation.passwordRequired';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return 'auth.validation.passwordLength';
  return null;
}

/**
 * Arabic/English message for a failed auth request. Codes with one meaning use our own text;
 * validation codes show the server's message (it names the exact problem).
 */
export function authErrorText(error: unknown, translate: TranslateService): string {
  const code = errorCode(error);
  const status = (error as { status?: number })?.status;
  if (status === 0) return translate.instant('auth.errors.UNREACHABLE');
  if (code === 'LOGIN_LOCKED') return translate.instant('auth.errors.LOGIN_LOCKED', { minutes: lockedMinutes(error) });
  if (code === 'PASSWORD_INVALID' || code === 'VALIDATION_ERROR') {
    return errorMessage(error) || translate.instant('auth.errors.generic');
  }
  if (code && OWN_TEXT.has(code)) return translate.instant(`auth.errors.${code}`);
  return errorMessage(error) || translate.instant('auth.errors.generic');
}
