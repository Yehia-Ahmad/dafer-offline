import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { LanguageService } from '../services/translation.service';
import { NotaBalancePipe, balanceDisplay } from './balance-display.pipe';

describe('balanceDisplay', () => {
  it('shows a credit balance on a credit-normal account as a positive amount on its own side, no warning (capital 1,756 Cr)', () => {
    const shown = balanceDisplay({ balance: -1756, normalSide: 'credit' }, 'ar');
    expect(shown.abs).toBe(1756);
    expect(shown.side).toBe('credit');
    expect(shown.warning).toBeFalse();
    expect(shown.text).toBe('١٬٧٥٦٫٠٠');
    expect(balanceDisplay({ balance: -1756, normalSide: 'credit' }, 'en').text).toBe('1,756.00');
  });

  it('shows a debit balance on a debit-normal account without warning', () => {
    const shown = balanceDisplay({ balance: 15000, normalSide: 'debit' }, 'en');
    expect(shown).toEqual({ abs: 15000, side: 'debit', warning: false, text: '15,000.00' });
  });

  it('warns only when the balance is on the opposite side of the normal side (cash box with a credit balance, supplier with a debit balance)', () => {
    expect(balanceDisplay({ balance: -50, normalSide: 'debit' }).warning).toBeTrue();
    expect(balanceDisplay({ balance: -50, normalSide: 'debit' }).side).toBe('credit');
    expect(balanceDisplay({ balance: 200, normalSide: 'credit' }).warning).toBeTrue();
    expect(balanceDisplay({ balance: 200, normalSide: 'credit' }).side).toBe('debit');
  });

  it('a zero balance sits on the normal side and never warns', () => {
    expect(balanceDisplay({ balance: 0, normalSide: 'credit' })).toEqual(jasmine.objectContaining({ abs: 0, side: 'credit', warning: false }));
    expect(balanceDisplay({ balance: 0 }).side).toBe('debit');
  });

  it('prefers the API side and absBalance when present, and derives them from the signed balance otherwise', () => {
    expect(balanceDisplay({ balance: -10, side: 'credit', absBalance: 10, normalSide: 'credit' }).abs).toBe(10);
    expect(balanceDisplay({ side: 'credit', absBalance: 7.5, normalSide: 'credit' }).abs).toBe(7.5);
    expect(balanceDisplay({ balance: -3.456, normalSide: 'credit' }).abs).toBe(3.46);
  });

  it('a group total rolls up by its own normal side (assets debit, liabilities credit)', () => {
    expect(balanceDisplay({ balance: 135500, side: 'debit', absBalance: 135500, normalSide: 'debit' }).warning).toBeFalse();
    expect(balanceDisplay({ balance: -8500, side: 'credit', absBalance: 8500, normalSide: 'credit' }).warning).toBeFalse();
  });
});

describe('NotaBalancePipe', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [TranslateModule.forRoot()] }));

  it('follows the UI language', () => {
    const pipe = TestBed.runInInjectionContext(() => new NotaBalancePipe());
    const language = TestBed.inject(LanguageService);
    language.selectedLanguage.set('ar');
    expect(pipe.transform({ balance: -1756, normalSide: 'credit' }).text).toBe('١٬٧٥٦٫٠٠');
    language.selectedLanguage.set('en');
    expect(pipe.transform({ balance: -1756, normalSide: 'credit' }).text).toBe('1,756.00');
    expect(pipe.transform(null).abs).toBe(0);
  });
});
