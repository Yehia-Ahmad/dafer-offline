import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { DashboardSummary } from '../../services/dashboard.service';
import { HomeComponent, salesChange } from './home.component';
import { signInAs } from '../../../../core/auth/testing/sign-in';

/** Stage 12 dashboard: one GET dashboard/summary (no params), KPIs, chart, lists and empty states (real template). */
describe('HomeComponent (Stage 12 dashboard)', () => {
  const url = `${environment.api_base_url}dashboard/summary`;
  let fixture: ComponentFixture<HomeComponent>;
  let component: HomeComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  const empty = (): DashboardSummary => ({
    date: '2026-11-04', timeZone: 'Africa/Cairo',
    today: { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } },
    yesterday: { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } },
    credit: { outstanding: 0, customersWithBalance: 0, overdueAmount: 0, overdueCount: 0 },
    last7Days: ['10-29', '10-30', '10-31', '11-01', '11-02', '11-03', '11-04'].map((d) => ({ date: `2026-${d}`, cash: 0, credit: 0 })),
    recentInvoices: [], lowStock: [],
  });
  const busy = (): DashboardSummary => ({
    ...empty(),
    today: { cash: { total: 6000, count: 31 }, credit: { total: 2450, count: 6 } },
    yesterday: { cash: { total: 6000, count: 20 }, credit: { total: 1500, count: 2 } },
    credit: { outstanding: 12900, customersWithBalance: 9, overdueAmount: 3100, overdueCount: 4 },
    last7Days: empty().last7Days.map((d, i) => ({ ...d, cash: 1000 * (i + 1), credit: i === 6 ? 2450 : 0 })),
    recentInvoices: [
      { id: 's1', type: 'cash', reference: '64b0000000000000000001aa', customerName: 'زبون نقدي', customerId: null, total: 350, sellingDate: '2026-11-04', createdAt: new Date().toISOString() },
      { id: 'c1', type: 'credit', reference: '654000000000000000000070', customerName: 'م. سامي', customerId: 'cu1', total: 2100, sellingDate: '2026-11-04', createdAt: new Date().toISOString() },
    ],
    lowStock: [{ id: 'p2', name: 'لمبة ١٢ وات', code: 'LED-12', inventoryCount: 2, threshold: 5 }, { id: 'p5', name: 'سلك', code: 'W-2', inventoryCount: 4, threshold: 5 }],
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HomeComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    fixture = TestBed.createComponent(HomeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const flush = (summary: DashboardSummary) => {
    const req = http.expectOne(url);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys()).toEqual([]);
    req.flush(summary);
    fixture.detectChanges();
  };

  it('loads GET dashboard/summary once and shows KPIs, 7 bars (today marked), low stock and recent invoices', () => {
    flush(busy());
    const kpis = component.kpis();
    expect(kpis.map((k) => k.key)).toEqual(['sales', 'invoices', 'outstanding']);
    expect(kpis[0].note).toBe('dashboard.kpis.upFromYesterday'); // 8450 vs 7500 → +12.7 %
    expect(kpis[0].tone).toBe('success');
    expect(kpis[2].note).toBe('dashboard.kpis.overdue');
    expect(kpis[2].tone).toBe('danger');

    expect(el().querySelectorAll('.db__bar-col').length).toBe(7);
    expect(el().querySelectorAll('.db__bar-col.is-today').length).toBe(1);
    expect(el().querySelectorAll('.db__low-row').length).toBe(2);
    expect(el().querySelector('.db__low-row')!.getAttribute('href')).toBe('/products/edit/p2');
    expect(el().querySelectorAll('.db__table tbody tr').length).toBe(2);
    expect(el().querySelector('a[href="/customers/cu1"]')).not.toBeNull();
    expect(el().querySelector('[data-test="new-shop"]')).toBeNull();
    // Quick actions
    expect(el().querySelector('[data-action="new-cash"]')!.getAttribute('href')).toBe('/selling');
    expect(el().querySelector('[data-action="new-credit"]')!.getAttribute('href')).toBe('/credit-sales/new');
    expect(el().querySelector('[data-action="collect"]')!.getAttribute('href')).toBe('/credit-sales');
  });

  it('brand-new shop: welcome card and empty states, no chart', () => {
    flush(empty());
    expect(el().querySelector('[data-test="new-shop"]')).not.toBeNull();
    expect(el().querySelector('.db__chart')).toBeNull();
    expect(el().querySelectorAll('nota-empty-state').length).toBe(4);
    expect(component.kpis()[0].note).toBe('dashboard.kpis.noYesterday');
  });

  it('error → retry sends the same GET again', () => {
    http.expectOne(url).flush({}, { status: 500, statusText: 'x' });
    fixture.detectChanges();
    expect(component.failed()).toBeTrue();
    (el().querySelector('.db__error button') as HTMLButtonElement).click();
    flush(empty());
    expect(component.failed()).toBeFalse();
  });

  it('% vs yesterday: one decimal, null without sales yesterday', () => {
    flush(empty());
    expect(salesChange(8450, 7500)).toBe(12.7);
    expect(salesChange(500, 1000)).toBe(-50);
    expect(salesChange(500, 0)).toBeNull();
  });

  it('low-stock pill: red at or below half the threshold, amber above', () => {
    flush(empty());
    expect(component.stockVariant({ inventoryCount: 2, threshold: 5 })).toBe('overdue');
    expect(component.stockVariant({ inventoryCount: 4, threshold: 5 })).toBe('due');
    expect(component.stockVariant({ inventoryCount: 0, threshold: 0 })).toBe('overdue');
  });
});
