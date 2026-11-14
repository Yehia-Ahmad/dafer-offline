import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { AUTH_ERROR_CODES } from '../../core/auth/auth.models';
import { authErrorText } from './auth-form.util';

/** Stage 24: a client PC beyond the license's maxClients is refused at login with 403 CLIENT_LIMIT and its own text. */
describe('authErrorText CLIENT_LIMIT (Stage 24)', () => {
  const translate = { instant: (key: string) => `T:${key}` } as unknown as TranslateService;
  const refused = new HttpErrorResponse({
    status: 403,
    error: { code: 'CLIENT_LIMIT', message: 'وصلت لأقصى عدد أجهزة فرعية في الترخيص — اطلب من المالك يشيل جهاز', maxClients: 2 },
  });

  it('is a known auth error code, shown with the translated text (not the generic one)', () => {
    expect(AUTH_ERROR_CODES).toContain('CLIENT_LIMIT');
    expect(authErrorText(refused, translate)).toBe('T:auth.errors.CLIENT_LIMIT');
  });
});
