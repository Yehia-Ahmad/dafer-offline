import { TranslateService } from '@ngx-translate/core';

/**
 * Online Fixes 1: the Arabic text of a refused correction. The backend answers { code, message }; a code that has a label under
 * `corrections.errors.<CODE>` (the codes of the cancel / deactivate / refund endpoints) wins, else the server's own message, else the fallback key.
 */
export function correctionErrorText(response: unknown, translate: TranslateService, fallbackKey = 'corrections.errors.GENERIC'): string {
  const body = (response as { error?: { code?: string; message?: string } } | null)?.error;
  const code = body?.code;
  if (code) {
    const key = `corrections.errors.${code}`;
    const text = translate.instant(key);
    if (text && text !== key) return text;
  }
  if (typeof body?.message === 'string' && body.message.trim()) return body.message;
  return translate.instant(fallbackKey);
}
