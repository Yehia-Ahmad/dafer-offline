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
import { DashboardSummary } from './modules/layout/services/dashboard.service';
import { HomeComponent } from './modules/layout/components/home/home.component';
import { LanguageService } from './modules/shared/services/translation.service';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

describe('Stage 20 — routes and permissions', () => {
  it('purchases need purchases.view, a new purchase needs purchases.create, and both are in the landing order', () => {
    expect(ROUTE_RULES.purchases.all).toEqual(['purchases.view']);
    expect(ROUTE_RULES.purchaseNew.all).toEqual(['purchases.create']);
    expect(LANDING_ORDER.some((entry) => entry.path === '/purchases')).toBeTrue();
    const has = (keys: string[]) => (key: string) => keys.includes(key);
    expect(ruleAllows(ROUTE_RULES.purchases, has(['purchases.view']), true)).toBeTrue();
    expect(ruleAllows(ROUTE_RULES.purchases, has(['suppliers.view']), true)).toBeFalse();
    expect(ruleAllows(ROUTE_RULES.purchaseNew, has(['purchases.view']), true)).toBeFalse();
  });
});

describe('Stage 20 — the shift close panel shows supplier payments and refunds as their own lines', () => {
  const REPORT: ShiftReport = {
    _id: 's1', number: 'SH-000001', boxId: 'b-d1', boxName: 'درج الكاشير ١', userId: 'id-owner', userName: 'محمود', openedAt: '2026-11-06T07:00:00.000Z',
    openingFloat: 2000, openingBalance: 2000, closedAt: null, closedByName: null, expected: 1920, counted: null, difference: null, differenceNote: null,
    depositBoxId: null, depositAmount: 0, status: 'open', remaining: null,
    lines: [
      { key: 'float', amount: 2000 }, { key: 'sales', amount: 0 }, { key: 'receipts', amount: 0 }, { key: 'transfersIn', amount: 0 }, { key: 'supplierRefunds', amount: 720 },
      { key: 'refunds', amount: 0 }, { key: 'expenses', amount: 0 }, { key: 'transfersOut', amount: 0 }, { key: 'payouts', amount: 0 }, { key: 'drawings', amount: 0 }, { key: 'supplierPayments', amount: 800 },
    ],
  };

  it('"سداد موردين" is a minus line, "استرداد من موردين" a plus line, and both hide when nothing moved', async () => {
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
    const lines = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.sp__row')).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(lines.some((line) => line.includes('− Supplier payments') && line.includes('800'))).withContext(lines.join(' | ')).toBeTrue();
    expect(lines.some((line) => line.includes('+ Supplier refunds') && line.includes('720'))).withContext(lines.join(' | ')).toBeTrue();
    expect(fixture.componentInstance.lines().map((line) => line.key)).toContain('supplierPayments');

    fixture.componentInstance.report.set({ ...REPORT, lines: REPORT.lines.map((line) => (['supplierPayments', 'supplierRefunds'].includes(line.key) ? { ...line, amount: 0 } : line)) });
    expect(fixture.componentInstance.lines().map((line) => line.key)).not.toContain('supplierPayments');
    expect(fixture.componentInstance.lines().map((line) => line.key)).not.toContain('supplierRefunds');
    http.verify();
  });
});

describe('Stage 20 — the dashboard shows what we owe suppliers (suppliers.view)', () => {
  const summary = (suppliersDue?: { owed: number; suppliersWithBalance: number }): DashboardSummary => ({
    date: '2026-11-04', timeZone: 'Africa/Cairo',
    today: { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } }, yesterday: { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } },
    credit: { outstanding: 0, customersWithBalance: 0, overdueAmount: 0, overdueCount: 0 },
    last7Days: [], recentInvoices: [], lowStock: [], ...(suppliersDue ? { suppliersDue } : {}),
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

  it('adds the "مستحق للموردين" KPI with the total and the number of suppliers to pay', async () => {
    const { fixture, http } = await open(summary({ owed: 14650, suppliersWithBalance: 3 }));
    const kpi = fixture.componentInstance.kpis().find((row) => row.key === 'suppliersDue')!;
    expect(kpi.labelKey).toBe('dashboard.kpis.suppliersDue');
    expect(kpi.value).toContain('14,650');
    expect(kpi.noteParams?.['count']).toBeDefined();
    http.verify();
  });

  it('is absent when the backend leaves it out (no suppliers.view)', async () => {
    const { fixture, http } = await open(summary(), ['dashboard.view']);
    expect(fixture.componentInstance.kpis().map((row) => row.key)).not.toContain('suppliersDue');
    http.verify();
  });
});

describe('Stage 20 — Arabic and English texts', () => {
  const keys = (node: unknown, prefix = ''): string[] =>
    node && typeof node === 'object' ? Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => keys(value, `${prefix}${prefix ? '.' : ''}${key}`)) : [prefix];
  const section = (json: unknown, name: string) => (json as Record<string, unknown>)[name];

  it('purchases, supplierPay and the supplier statement have the same keys in both languages', () => {
    for (const name of ['purchases', 'supplierPay']) {
      expect(keys(section(arJson, name)).sort()).withContext(name).toEqual(keys(section(enJson, name)).sort());
    }
    const statement = (json: unknown) => keys((section(json, 'suppliers') as Record<string, unknown>)['statement']).sort();
    expect(statement(arJson)).toEqual(statement(enJson));
  });

  it('the shift lines, the dashboard KPI and the document sources are translated', () => {
    for (const json of [arJson, enJson]) {
      const text = JSON.stringify(json);
      for (const key of ['supplierPayments', 'supplierRefunds', 'suppliersDue', 'supplier_payment', 'supplier_refund', 'purchase_return']) expect(text).withContext(key).toContain(`"${key}"`);
    }
    expect(JSON.stringify(arJson)).toContain('سداد موردين');
    expect(JSON.stringify(arJson)).toContain('استرداد من موردين');
    expect(JSON.stringify(arJson)).toContain('مستحق للموردين');
  });
});
