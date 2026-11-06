import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { LanguageService } from '../../../shared/services/translation.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CustomerDetailsComponent } from './customer-details.component';
import { CustomersService } from '../../services/customers.service';

/** Stage 18: the statement shows "رصيد أول المدة" first, the aging table, and collecting the opening balance. */
describe('CustomerDetailsComponent (Stage 18 opening balance)', () => {
  const base = environment.api_base_url;
  let http: HttpTestingController;
  let component: CustomerDetailsComponent;

  const customer = (opening: object | null) => ({
    _id: 'cu1', name: 'م. سامي', phone: '01001234567', createdAt: '2026-09-01T00:00:00.000Z', opening,
    creditSummary: { totalInvoices: 0, remainingAmount: opening ? 1000 : 0 }, creditHistory: [],
  });
  const statementBody = {
    lines: [
      { date: '2026-11-05T08:00:00.000Z', type: 'opening_balance', number: 'OB-000002', description: 'رصيد أول المدة', debit: 1000, credit: 0, balance: 1000 },
      { date: '2026-11-06T08:00:00.000Z', type: 'payment', number: 'RC-000001', description: 'دفعة عميل', debit: 0, credit: 400, balance: 600 },
    ],
    totals: { debit: 1000, credit: 400, balance: 600 },
    aging: { current: 0, days1to30: 100, days31to60: 200, over60: 300, total: 600, credit: 0 },
    outstanding: 600,
  };

  const create = async (opening: object | null, statement: object = statementBody) => {
    await TestBed.configureTestingModule({
      imports: [CustomerDetailsComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cu1' })), snapshot: { paramMap: convertToParamMap({ id: 'cu1' }) } } },
      ],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const auth = TestBed.inject(AuthService);
    spyOn(auth, 'hasAll').and.returnValue(true);
    spyOn(auth, 'hasAny').and.returnValue(true);
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CustomerDetailsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne(`${base}customers/cu1`).flush(customer(opening));
    http.expectOne(`${base}customers/cu1/statement`).flush(statement);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };

  afterEach(() => http.verify());

  it('the statement starts with the opening line "رصيد أول المدة", then the receipts that collected it', async () => {
    const fixture = await create({ amount: 1000, date: '2026-11-05T08:00:00.000Z', number: 'OB-000002', collected: 400, remaining: 600 });
    const rows = Array.from(fixture.nativeElement.querySelectorAll('tbody tr') as NodeListOf<HTMLElement>);
    expect(rows[0].textContent).toContain('رصيد أول المدة');
    expect(rows[0].textContent).toContain('OB-000002');
    expect(rows[1].textContent).toContain('RC-000001');
    expect(component.statement.rows[0].kind).toBe('opening_balance');
    expect(component.statement.balance).toBe(600);
  });

  it('shows the aging table from the statement API (current, 1–30, 31–60, over 60, total)', async () => {
    const fixture = await create({ amount: 1000, date: '2026-11-05T08:00:00.000Z', number: 'OB-000002', collected: 400, remaining: 600 });
    const cell = (id: string) => (fixture.nativeElement.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim();
    expect(fixture.nativeElement.querySelector('[data-testid="customer-aging"]')).toBeTruthy();
    expect(cell('aging-current')).toBe('0');
    expect(cell('aging-1-30')).toBe('100');
    expect(cell('aging-31-60')).toBe('200');
    expect(cell('aging-over-60')).toBe('300');
    expect(cell('aging-total')).toBe('600');
    expect(fixture.nativeElement.querySelector('[data-testid="aging-credit"]')).toBeNull();
  });

  it('a customer credit (negative opening) shows as credit under the aging table, not as debt', async () => {
    const fixture = await create({ amount: -300, date: '2026-11-05T08:00:00.000Z', number: 'OB-000002', collected: 0, remaining: 0 }, {
      lines: [{ date: '2026-11-05T08:00:00.000Z', type: 'opening_balance', number: 'OB-000002', description: 'رصيد أول المدة', debit: 0, credit: 300, balance: -300 }],
      totals: { debit: 0, credit: 300, balance: -300 },
      aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0, credit: 300 },
      outstanding: 0,
    });
    expect(fixture.nativeElement.querySelector('[data-testid="aging-credit"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="customer-credit-balance"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="opening-collect"]')).toBeNull();
  });

  it('collect the opening balance: POST customers/:id/payments with firstInvoice, then reload the customer and the statement', async () => {
    const fixture = await create({ amount: 1000, date: '2026-11-05T08:00:00.000Z', number: 'OB-000002', collected: 400, remaining: 600 });
    expect(component.openingRemaining).toBe(600);
    (fixture.nativeElement.querySelector('[data-action="opening-collect-toggle"]') as HTMLElement).click();
    fixture.detectChanges();
    component.openingPay.amount = 650;
    component.collectOpening();
    http.expectNone(`${base}customers/cu1/payments`); // more than the remaining opening: not sent
    expect(component.openingPay.error).toBe('customerDetailsPage.s10.openingCollect.invalid');
    component.openingPay.amount = 250;
    component.openingPay.note = ' نقدي ';
    component.collectOpening();
    const req = http.expectOne(`${base}customers/cu1/payments`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body.amount).toBe(250);
    expect(req.request.body.firstInvoice).toBe(true);
    expect(req.request.body.note).toBe('نقدي');
    expect(req.request.body.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    req.flush({ openingCollected: 250 });
    http.expectOne(`${base}customers/cu1`).flush(customer({ amount: 1000, date: '2026-11-05T08:00:00.000Z', number: 'OB-000002', collected: 650, remaining: 350 }));
    http.expectOne(`${base}customers/cu1/statement`).flush(statementBody);
    expect(component.openingPay.open).toBeFalse();
  });

  it('CustomersService.collectPayment always sends firstInvoice (the opening is the oldest item)', async () => {
    await create(null);
    const service = TestBed.inject(CustomersService);
    service.collectPayment('cu1', { amount: 10 }).subscribe();
    const req = http.expectOne(`${base}customers/cu1/payments`);
    expect(req.request.body).toEqual({ amount: 10, firstInvoice: true });
    req.flush({});
  });
});
