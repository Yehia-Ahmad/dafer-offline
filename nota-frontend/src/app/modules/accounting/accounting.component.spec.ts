import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AccountsComponent } from './accounts.component';
import { JournalComponent } from './journal.component';

describe('accounting screens', () => {
  beforeEach(() => TestBed.configureTestingModule({
    imports: [TranslateModule.forRoot(), AccountsComponent, JournalComponent],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  }));

  it('accounts tree requests as-of and renders rolled-up virtual customers', () => {
    const fixture = TestBed.createComponent(AccountsComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    const request = http.expectOne((r) => r.url.includes('/accounting/accounts'));
    expect(request.request.params.get('asOf')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    request.flush({ accounts: [{ code: '113', nameEn: 'Customers', balance: -25, virtualCustomers: [{ name: 'A', balance: -25 }] }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Customers');
    expect(fixture.nativeElement.textContent).toContain('A');
  });

  it('journal list filters by number and shows entry detail lines', () => {
    const fixture = TestBed.createComponent(JournalComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne((r) => r.url.includes('/accounting/journal')).flush({ data: [{ number: 'JE-1', totalDebit: 10, date: new Date(), memo: 'sale', lines: [{ accountCode: '1111', accountName: 'Cash', debit: 10, credit: 0 }] }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('JE-1');
    fixture.componentInstance.number = 'JE-2';
    fixture.componentInstance.load();
    const filtered = http.expectOne((r) => r.url.includes('/accounting/journal'));
    expect(filtered.request.params.get('number')).toBe('JE-2');
    filtered.flush({ data: [] });
  });
});
