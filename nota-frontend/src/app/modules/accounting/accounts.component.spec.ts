import { TestBed } from '@angular/core/testing'; import { provideHttpClient } from '@angular/common/http'; import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'; import { provideRouter, Router } from '@angular/router'; import { TranslateModule } from '@ngx-translate/core'; import { AccountsComponent } from './accounts.component';
import { LanguageService } from '../shared/services/translation.service';

describe('AccountsComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AccountsComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    TestBed.inject(LanguageService).selectedLanguage.set('en');
  });

  const load = (accounts: unknown[]) => {
    const fixture = TestBed.createComponent(AccountsComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne((r) => r.url.includes('accounting/accounts')).flush({ accounts });
    fixture.detectChanges();
    return fixture;
  };
  const row = (fixture: ReturnType<typeof load>, code: string) =>
    Array.from(fixture.nativeElement.querySelectorAll('.tree-row') as NodeListOf<HTMLElement>).find((element) => element.querySelector('.code')?.textContent?.trim() === code) as HTMLElement;

  it('renders rollups and virtual customer rows in the current language and sends asOf', () => {
    const fixture = TestBed.createComponent(AccountsComponent); const http = TestBed.inject(HttpTestingController); fixture.detectChanges();
    const req = http.expectOne((r) => r.url.includes('accounting/accounts')); expect(req.request.params.get('asOf')).toMatch(/^\d{4}-/);
    req.flush({ accounts: [{ _id: '113', code: '113', nameAr: 'العملاء', nameEn: 'Customers', systemKey: 'CUSTOMERS', normalSide: 'debit', balance: 75, children: [], virtualCustomers: [{ _id: 'c1', name: 'Ahmed', balance: 75 }] }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('العملاء'); expect(fixture.nativeElement.textContent).toContain('Ahmed'); expect(fixture.nativeElement.textContent).toContain('75.00');
  });

  it('expands groups and opens a customer-filtered ledger', () => {
    const fixture = TestBed.createComponent(AccountsComponent); const router = TestBed.inject(Router); spyOn(router, 'navigate');
    fixture.componentInstance.activate({ customer: true, _id: 'c1', parentAccountId: '113' });
    expect(router.navigate).toHaveBeenCalledWith(['/accounting/accounts', '113', 'ledger'], { queryParams: { partyId: 'c1' } });
  });

  it('a credit-normal account with a credit balance shows a positive amount on the credit side, no warning (capital 1,756 Cr)', () => {
    const fixture = load([{ _id: 'a31', code: '31', nameAr: 'رأس المال', nameEn: 'Capital', normalSide: 'credit', balance: -1756, side: 'credit', absBalance: 1756, children: [] }]);
    const shown = row(fixture, '31').querySelector('[data-test="balance"]') as HTMLElement;
    expect(shown.textContent).toContain('1,756.00');
    expect(shown.textContent).not.toContain('-');
    expect(shown.getAttribute('data-side')).toBe('credit');
    expect(shown.textContent).toContain('accounting.side.credit');
    expect(shown.classList).not.toContain('warn');
    expect(row(fixture, '31').querySelector('[data-test="opposite-hint"]')).toBeNull();
  });

  it('uses the warning token and a hint only when the balance is opposite to the normal side (cash box with a credit balance, supplier with a debit balance)', () => {
    const fixture = load([
      { _id: 'a1111', code: '1111', nameAr: 'الخزنة', nameEn: 'Main cash', normalSide: 'debit', balance: -50, side: 'credit', absBalance: 50, children: [] },
      { _id: 'a21', code: '21', nameAr: 'الموردين', nameEn: 'Suppliers', normalSide: 'credit', balance: 200, side: 'debit', absBalance: 200, children: [] },
      { _id: 'a114', code: '114', nameAr: 'المخزون', nameEn: 'Inventory', normalSide: 'debit', balance: 84200, side: 'debit', absBalance: 84200, children: [] },
    ]);
    for (const code of ['1111', '21']) {
      expect((row(fixture, code).querySelector('[data-test="balance"]') as HTMLElement).classList).toContain('warn');
      expect(row(fixture, code).querySelector('[data-test="opposite-hint"]')).toBeTruthy();
    }
    expect((row(fixture, '1111').querySelector('[data-test="balance"]') as HTMLElement).getAttribute('data-side')).toBe('credit');
    expect((row(fixture, '21').querySelector('[data-test="balance"]') as HTMLElement).getAttribute('data-side')).toBe('debit');
    expect((row(fixture, '114').querySelector('[data-test="balance"]') as HTMLElement).classList).not.toContain('warn');
  });

  it('group totals roll up by their own normal side (assets debit, liabilities credit)', () => {
    const fixture = load([
      { _id: 'g1', code: '1', nameAr: 'الأصول', nameEn: 'Assets', isGroup: true, normalSide: 'debit', balance: 135500, side: 'debit', absBalance: 135500, children: [] },
      { _id: 'g2', code: '2', nameAr: 'الخصوم', nameEn: 'Liabilities', isGroup: true, normalSide: 'credit', balance: -8500, side: 'credit', absBalance: 8500, children: [] },
    ]);
    expect(row(fixture, '1').textContent).toContain('135,500.00');
    expect(row(fixture, '2').textContent).toContain('8,500.00');
    expect(row(fixture, '1').querySelector('[data-test="opposite-hint"]')).toBeNull();
    expect(row(fixture, '2').querySelector('[data-test="opposite-hint"]')).toBeNull();
  });

  it('virtual customer rows are debit-normal: a customer credit shows the warning', () => {
    const fixture = load([{ _id: '113', code: '113', nameAr: 'العملاء', nameEn: 'Customers', systemKey: 'CUSTOMERS', normalSide: 'debit', balance: 100, side: 'debit', absBalance: 100, children: [], virtualCustomers: [{ _id: 'c1', name: 'Owed', balance: -300, side: 'credit', absBalance: 300 }] }]);
    const customerRow = Array.from(fixture.nativeElement.querySelectorAll('.tree-row') as NodeListOf<HTMLElement>).find((element) => element.textContent?.includes('Owed')) as HTMLElement;
    expect(customerRow.querySelector('[data-test="balance"]')?.classList).toContain('warn');
    expect(customerRow.textContent).toContain('300.00');
  });
});
