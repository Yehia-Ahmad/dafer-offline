import { TestBed } from '@angular/core/testing'; import { provideHttpClient } from '@angular/common/http'; import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing'; import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router'; import { TranslateModule } from '@ngx-translate/core'; import { LedgerComponent } from './ledger.component';
import { LanguageService } from '../shared/services/translation.service';

describe('LedgerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LedgerComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'a1' }), queryParamMap: convertToParamMap({ partyId: 'c1' }) } } }] });
    TestBed.inject(LanguageService).selectedLanguage.set('en');
  });

  it('requests party/date filters and renders opening and running balances', () => {
    const f = TestBed.createComponent(LedgerComponent); const http = TestBed.inject(HttpTestingController); f.detectChanges();
    let req = http.expectOne((r) => r.url.includes('/a1/ledger')); expect(req.request.params.get('partyId')).toBe('c1');
    req.flush({ account: { code: '113', nameEn: 'Customers', systemKey: 'CUSTOMERS', normalSide: 'debit' }, openingBalance: 90, openingSide: 'debit', openingAbsBalance: 90, balance: 70, side: 'debit', absBalance: 70, lines: [{ entryId: 'j1', number: 'JE-1', date: '2026-02-01', debit: 0, credit: 20, balance: 70, side: 'debit', absBalance: 70 }] });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('90.00'); expect(f.nativeElement.textContent).toContain('70.00');
    f.componentInstance.from = '2026-02-01'; f.componentInstance.to = '2026-02-28'; f.componentInstance.load();
    req = http.expectOne((r) => r.url.includes('/a1/ledger')); expect(req.request.params.get('from')).toBe('2026-02-01'); expect(req.request.params.get('to')).toBe('2026-02-28');
    req.flush({ account: { code: '113' }, openingBalance: 90, balance: 70, lines: [] });
  });

  it('the running balance and the closing balance show positive amounts labelled by side (capital: credit, no minus sign, no warning)', () => {
    const f = TestBed.createComponent(LedgerComponent); const http = TestBed.inject(HttpTestingController); f.detectChanges();
    http.expectOne((r) => r.url.includes('/a1/ledger')).flush({
      account: { code: '31', nameEn: 'Capital', normalSide: 'credit' }, openingBalance: 0, openingSide: 'credit', openingAbsBalance: 0,
      balance: -1756, side: 'credit', absBalance: 1756,
      lines: [{ entryId: 'j1', number: 'OB-1', date: '2026-02-01', debit: 0, credit: 1756, balance: -1756, side: 'credit', absBalance: 1756 }],
    });
    f.detectChanges();
    const line = f.nativeElement.querySelector('[data-test="line-balance"]') as HTMLElement;
    expect(line.textContent).toContain('1,756.00'); expect(line.textContent).not.toContain('-'); expect(line.textContent).toContain('accounting.side.credit'); expect(line.classList).not.toContain('warn');
    const closing = f.nativeElement.querySelector('[data-test="closing-balance"]') as HTMLElement;
    expect(closing.textContent).toContain('1,756.00'); expect(closing.classList).not.toContain('warn');
  });

  it('a balance on the opposite side of the normal side is flagged (a cash box that went to credit)', () => {
    const f = TestBed.createComponent(LedgerComponent); const http = TestBed.inject(HttpTestingController); f.detectChanges();
    http.expectOne((r) => r.url.includes('/a1/ledger')).flush({
      account: { code: '1111', nameEn: 'Main cash', normalSide: 'debit' }, openingBalance: 0, openingSide: 'debit', openingAbsBalance: 0,
      balance: -50, side: 'credit', absBalance: 50,
      lines: [{ entryId: 'j1', number: 'JE-1', date: '2026-02-01', debit: 0, credit: 50, balance: -50, side: 'credit', absBalance: 50 }],
    });
    f.detectChanges();
    expect((f.nativeElement.querySelector('[data-test="line-balance"]') as HTMLElement).classList).toContain('warn');
    expect((f.nativeElement.querySelector('[data-test="closing-balance"]') as HTMLElement).classList).toContain('warn');
  });

  it('excludeClosing from the income statement link: the request carries it and the page says closing entries are left out', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [LedgerComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'a1' }), queryParamMap: convertToParamMap({ from: '2025-01-01', to: '2025-12-31', excludeClosing: '1' }) } } }] });
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const f = TestBed.createComponent(LedgerComponent); const http = TestBed.inject(HttpTestingController); f.detectChanges();
    const req = http.expectOne((r) => r.url.includes('/a1/ledger'));
    expect(req.request.params.get('excludeClosing')).toBe('1'); expect(req.request.params.get('from')).toBe('2025-01-01');
    req.flush({ account: { code: '523', nameEn: 'Utilities', normalSide: 'debit' }, excludeClosing: true, openingBalance: 0, balance: 100, side: 'debit', absBalance: 100, lines: [] });
    f.detectChanges();
    expect(f.nativeElement.querySelector('[data-test="closing-excluded"]')?.textContent).toContain('accounting.closingExcluded');
    f.componentInstance.excludeClosing = false; f.componentInstance.load();
    expect(http.expectOne((r) => r.url.includes('/a1/ledger')).request.params.has('excludeClosing')).toBeFalse();
  });

  it('no excludeClosing: no flag on the request and no note', () => {
    const f = TestBed.createComponent(LedgerComponent); const http = TestBed.inject(HttpTestingController); f.detectChanges();
    const req = http.expectOne((r) => r.url.includes('/a1/ledger'));
    expect(req.request.params.has('excludeClosing')).toBeFalse();
    req.flush({ account: { code: '113' }, openingBalance: 0, balance: 0, lines: [] });
    f.detectChanges();
    expect(f.nativeElement.querySelector('[data-test="closing-excluded"]')).toBeNull();
  });

  it('the supplier ledger (account 21) offers the supplier filter', () => {
    const f = TestBed.createComponent(LedgerComponent); const http = TestBed.inject(HttpTestingController); f.detectChanges();
    http.expectOne((r) => r.url.includes('/a1/ledger')).flush({ account: { code: '21', nameEn: 'Suppliers', systemKey: 'SUPPLIERS', normalSide: 'credit' }, parties: [{ _id: 's1', name: 'Light Co', phones: ['0102'] }], openingBalance: 0, balance: 0, lines: [] });
    f.detectChanges();
    expect(f.nativeElement.querySelector('select[name="party"]')).toBeTruthy();
    expect(f.nativeElement.querySelector('select[name="party"]').textContent).toContain('Light Co');
  });
});
