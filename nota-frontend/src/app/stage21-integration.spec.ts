import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../environments/environment';
import arJson from '../assets/i18n/ar.json';
import enJson from '../assets/i18n/en.json';
import { signInAs, signInWith } from './core/auth/testing/sign-in';
import { LANDING_ORDER, ROUTE_RULES, ruleAllows } from './core/auth/route-permissions';
import { ShiftReport } from './modules/cashbox/cashbox.models';
import { ShiftPanelComponent } from './modules/cashbox/shift-panel.component';
import { CategoryToolsComponent } from './modules/category/components/category-tools/category-tools.component';
import { CustomersComponent } from './modules/customer/components/customers/customers.component';
import { DashboardSummary } from './modules/layout/services/dashboard.service';
import { HomeComponent } from './modules/layout/components/home/home.component';
import { LanguageService } from './modules/shared/services/translation.service';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

describe('Stage 21 — routes and permissions', () => {
  it('the VAT return needs vat.file or accounting.view and is in the landing order; the sidebar and the route map agree', () => {
    expect(ROUTE_RULES.vat.any).toEqual(['vat.file', 'accounting.view']);
    expect(LANDING_ORDER.some((entry) => entry.path === '/accounting/vat')).toBeTrue();
    const has = (keys: string[]) => (key: string) => keys.includes(key);
    expect(ruleAllows(ROUTE_RULES.vat, has(['vat.file']), true)).toBeTrue();
    expect(ruleAllows(ROUTE_RULES.vat, has(['accounting.view']), true)).toBeTrue();
    expect(ruleAllows(ROUTE_RULES.vat, has(['sales.view', 'purchases.view']), true)).toBeFalse();
  });
});

describe('Stage 21 — the translations: every VAT key exists in both languages', () => {
  const flat = (value: unknown, prefix = ''): string[] =>
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => flat(inner, prefix ? `${prefix}.${key}` : key))
      : [prefix];
  it('the vat block has the same keys in Arabic and English, none empty', () => {
    const ar = flat((arJson as Record<string, unknown>)['vat']).sort();
    const en = flat((enJson as Record<string, unknown>)['vat']).sort();
    expect(ar.length).toBeGreaterThan(80);
    expect(ar).toEqual(en);
  });
  it('the sidebar label and the shift line exist in both languages', () => {
    expect((arJson as any).nav.items.vat).toBe('الضريبة');
    expect((enJson as any).nav.items.vat).toBe('VAT');
    expect((arJson as any).cashbox.shift.lines.vatPayments).toBe('سداد ضريبة');
    expect((enJson as any).cashbox.shift.lines.vatPayments).toBeTruthy();
  });
});

describe('Stage 21 — the shift panel shows "سداد ضريبة" as a minus line, hidden when nothing was paid', () => {
  const REPORT: ShiftReport = {
    _id: 's1', number: 'SH-000001', boxId: 'b-d1', boxName: 'درج الكاشير ١', userId: 'id-owner', userName: 'محمود', openedAt: '2026-11-06T07:00:00.000Z',
    openingFloat: 2000, openingBalance: 2000, closedAt: null, closedByName: null, expected: 1500, counted: null, difference: null, differenceNote: null,
    depositBoxId: null, depositAmount: 0, status: 'open', remaining: null,
    lines: [{ key: 'float', amount: 2000 }, { key: 'sales', amount: 0 }, { key: 'vatPayments', amount: 500 }],
  };

  it('lists the VAT payment with a minus sign', async () => {
    await TestBed.configureTestingModule({
      imports: [ShiftPanelComponent, TranslateModule.forRoot({ defaultLanguage: 'en' })],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    TestBed.inject(TranslateService).setTranslation('en', enJson as never);
    TestBed.inject(TranslateService).use('en');
    signInAs('owner');
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ShiftPanelComponent);
    fixture.componentRef.setInput('shiftId', 's1');
    fixture.detectChanges();
    http.expectOne(`${base}shifts/s1`).flush(REPORT);
    await settle(fixture);
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.sp__row')).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(rows.some((row) => row.includes('− VAT payments') && row.includes('500'))).withContext(rows.join(' | ')).toBeTrue();
    expect(fixture.componentInstance.lines().map((line) => line.key)).toContain('vatPayments');
    fixture.componentInstance.report.set({ ...REPORT, lines: REPORT.lines.map((line) => (line.key === 'vatPayments' ? { ...line, amount: 0 } : line)) });
    expect(fixture.componentInstance.lines().map((line) => line.key)).not.toContain('vatPayments');
    http.verify();
  });
});

describe('Stage 21 — the dashboard', () => {
  const summary = (extra: Partial<DashboardSummary> = {}): DashboardSummary => ({
    date: '2026-11-04', timeZone: 'Africa/Cairo',
    today: { cash: { total: 2450, count: 3 }, credit: { total: 0, count: 0 } }, yesterday: { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } },
    credit: { outstanding: 0, customersWithBalance: 0, overdueAmount: 0, overdueCount: 0 },
    last7Days: [], recentInvoices: [], lowStock: [], ...extra,
  });
  const open = async (data: DashboardSummary, permissions: string[] | 'owner' = 'owner') => {
    await TestBed.configureTestingModule({ imports: [HomeComponent, TranslateModule.forRoot()], providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    if (permissions === 'owner') signInAs('owner'); else signInWith(permissions);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    http.expectOne(`${base}dashboard/summary`).flush(data);
    http.match((request) => request.url === `${base}cashbox/boxes`).forEach((request) => request.flush({ data: [], cashTotal: 0 }));
    fixture.detectChanges();
    return { fixture, http };
  };

  it('VAT off: today\'s sales has no tag and there is no VAT KPI', async () => {
    const { fixture, http } = await open(summary());
    expect(fixture.componentInstance.kpis().map((kpi) => kpi.key)).not.toContain('vatDue');
    expect(fixture.componentInstance.kpis().find((kpi) => kpi.key === 'sales')!.tagKey).toBeUndefined();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="vat-tag"]')).toBeNull();
    http.verify();
  });

  it('VAT on: "مبيعات النهارده" still shows what the customer paid, with a "شامل الضريبة" label, and "ضريبة مستحقة" shows for vat.file / accounting.view', async () => {
    const { fixture, http } = await open(summary({ vat: { enabled: true, rate: 14, pricesIncludeVat: false }, vatDue: { amount: 35, payable: 35, input: 0 } }));
    const sales = fixture.componentInstance.kpis().find((kpi) => kpi.key === 'sales')!;
    expect(sales.value).toContain('2,450');
    expect(sales.tagKey).toBe('vat.dashboard.includesVat');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="vat-tag"]')).toBeTruthy();
    const due = fixture.componentInstance.kpis().find((kpi) => kpi.key === 'vatDue')!;
    expect(due.labelKey).toBe('vat.dashboard.due');
    expect(due.value).toContain('35');
    expect(due.link).toBe('/accounting/vat');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-kpi="vatDue"] [data-action="vat-link"]')).toBeTruthy();
    http.verify();
  });

  it('a user without those permissions gets the label but no VAT-due KPI (the server leaves it out)', async () => {
    const { fixture, http } = await open(summary({ vat: { enabled: true, rate: 14, pricesIncludeVat: true } }), ['dashboard.view']);
    expect(fixture.componentInstance.kpis().map((kpi) => kpi.key)).not.toContain('vatDue');
    expect(fixture.componentInstance.kpis().find((kpi) => kpi.key === 'sales')!.tagKey).toBe('vat.dashboard.includesVat');
    http.verify();
  });
});

describe('Stage 21 — customer tax number and the category bulk toggle: payloads', () => {
  it('a customer without a tax number posts {name, phone} as always; with one, taxNumber is added', async () => {
    await TestBed.configureTestingModule({
      imports: [CustomersComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CustomersComponent);
    const component = fixture.componentInstance;
    component.ngOnInit();
    http.match((r) => r.url === `${base}customers`).forEach((r) => r.flush({ data: { customers: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 1 } } }));
    component.customerForm.patchValue({ name: 'أحمد', phone: '0128' });
    component.saveCustomer();
    let req = http.expectOne((r) => r.url === `${base}customers` && r.method === 'POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ name: 'أحمد', phone: '0128' }));
    req.flush({ _id: 'cu1' }, { status: 201, statusText: 'Created' });
    http.match((r) => r.url === `${base}customers` && r.method === 'GET').forEach((r) => r.flush({ data: { customers: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 1 } } }));
    component.customerForm.patchValue({ name: 'شركة النيل', phone: '0129', taxNumber: ' 555-111 ' });
    component.saveCustomer();
    req = http.expectOne((r) => r.url === `${base}customers` && r.method === 'POST');
    expect(req.request.body).toEqual({ name: 'شركة النيل', phone: '0129', taxNumber: '555-111' });
    req.flush({ _id: 'cu2' }, { status: 201, statusText: 'Created' });
    http.match((r) => r.url === `${base}customers` && r.method === 'GET').forEach((r) => r.flush({ data: { customers: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 1 } } }));
    http.verify();
  });

  it('a new category sends vatExempt only when it is on; the bulk toggle on an edit is sent only when it changed', async () => {
    await TestBed.configureTestingModule({
      imports: [CategoryToolsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    signInAs('owner');
    const fixture = TestBed.createComponent(CategoryToolsComponent);
    const component = fixture.componentInstance as any;
    component.addCategory.patchValue({ name: 'كتب' });
    expect(component.buildCategoryPayload()).toEqual({ name: 'كتب' });
    component.addCategory.patchValue({ vatExempt: true });
    expect(component.buildCategoryPayload()).toEqual({ name: 'كتب', vatExempt: true });
    // editing a category that was already exempt: unchanged -> not sent; cleared -> false
    component.editingCategory = { id: 'c1', category: { vatExempt: true } };
    expect(component.buildCategoryPayload().vatExempt).toBeUndefined();
    component.addCategory.patchValue({ vatExempt: false });
    expect(component.buildCategoryPayload().vatExempt).toBe(false);
  });
});
