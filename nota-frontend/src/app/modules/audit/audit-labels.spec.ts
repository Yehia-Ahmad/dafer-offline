import { TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import ar from '../../../assets/i18n/ar.json';
import en from '../../../assets/i18n/en.json';
import { BACKEND_AUDIT_ACTIONS } from '../../help/generated/audit-actions';
import { AUDIT_ACTIONS } from './audit.service';

/** Online Fixes 1: every audit action code the backend writes has an Arabic and an English label and is in the audit page's filter. */
describe('audit action labels (Online Fixes 1)', () => {
  let translate: TranslateService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TranslateModule.forRoot()] });
    translate = TestBed.inject(TranslateService);
    translate.setTranslation('ar', ar as never);
    translate.setTranslation('en', en as never);
  });

  it('the generated list is not empty and includes the codes of the new screens', () => {
    expect(BACKEND_AUDIT_ACTIONS.length).toBeGreaterThan(80);
    for (const code of ['order.courier_changed', 'document.printed', 'supplier.payment.cancelled', 'transfer.cancelled', 'drawing.cancelled', 'credit.payout.cancelled', 'cashbox.deactivated', 'website.zone.created', 'courier.created']) {
      expect(BACKEND_AUDIT_ACTIONS).withContext(code).toContain(code);
    }
  });

  for (const lang of ['ar', 'en'] as const) {
    it(`every code has a ${lang} label`, () => {
      translate.use(lang);
      const missing = BACKEND_AUDIT_ACTIONS.filter((code) => {
        const key = `audit.actions.${code}`;
        const text = translate.instant(key);
        return !text || text === key;
      });
      expect(missing).withContext(`codes with no ${lang} label`).toEqual([]);
    });
  }

  it('the audit page filter lists every code the backend writes', () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual([...BACKEND_AUDIT_ACTIONS].sort());
  });
});
