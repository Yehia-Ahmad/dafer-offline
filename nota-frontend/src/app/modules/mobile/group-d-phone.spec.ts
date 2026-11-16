import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { LayoutService } from '../../core/layout/layout.service';
import { signInWith } from '../../core/auth/testing/sign-in';
import { BoxDetailComponent } from '../cashbox/box-detail.component';
import { CashboxPageComponent } from '../cashbox/cashbox-page.component';
import { ExpensesPageComponent } from '../cashbox/expenses-page.component';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';

/** Online Stage 6B, group D: the cash screens on the phone (LayoutService says "mobile"). */
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };
const base = environment.api_base_url;
const BOX = { _id: 'b1', name: 'الخزنة الرئيسية', type: 'cash', accountId: 'a1', isMain: true, deviceId: null, deviceName: null, shiftsEnabled: false, isActive: true, sortOrder: 0, balance: 150, openShift: null };

describe('cash boxes list on the phone (Online Stage 6B)', () => {
  async function actions(permissions: string[]): Promise<string[]> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CashboxPageComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), phone],
    }).compileComponents();
    signInWith(permissions);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CashboxPageComponent);
    fixture.detectChanges();
    http.match((r) => r.url === `${base}cashbox/boxes`).forEach((r) => r.flush({ data: [BOX], cashTotal: 150 }));
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return Array.from(el.querySelectorAll('[data-action]')).map((node) => node.getAttribute('data-action')!).filter((action) => ['transfer', 'new-box', 'drawing'].includes(action));
  }

  it('shows transfer / new box with cashbox.manage and the owner drawing only with owner.drawings', async () => {
    expect(await actions(['cashbox.view'])).toEqual([]);
    expect((await actions(['cashbox.view', 'cashbox.manage'])).sort()).toEqual(['new-box', 'transfer']);
    expect((await actions(['cashbox.view', 'owner.drawings'])).sort()).toEqual(['drawing']);
  });
});

describe('box detail on the phone (Online Stage 6B)', () => {
  it('shows each movement as a card: money in green with +, money out red with −, and the balance as a card', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [BoxDetailComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), phone,
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'b1' }) } } }],
    }).compileComponents();
    signInWith(['cashbox.view']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(BoxDetailComponent);
    fixture.detectChanges();
    http.expectOne(`${base}cashbox/boxes/b1`).flush({ ...BOX, shifts: [] });
    http.expectOne(`${base}cashbox/boxes/b1/ledger`).flush({ openingBalance: 0, balance: 150, side: 'debit', absBalance: 150, lines: [
      { entryId: 'e1', number: 'JE-1', date: '2026-11-16', source: { type: 'sale', id: 's1', number: 'INV-1' }, debit: 20, credit: 0, balance: 20 },
      { entryId: 'e2', number: 'JE-2', date: '2026-11-16', source: { type: 'expense', id: 'x1', number: 'EX-1' }, debit: 0, credit: 5, balance: 15 },
    ] });
    http.match((r) => r.url === `${base}cashbox/boxes`).forEach((r) => r.flush({ data: [BOX], cashTotal: 150 }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.m-dark-card [data-test="detail-balance"]')).not.toBeNull();
    expect(el.querySelectorAll('table').length).toBe(0);
    const rows = Array.from(el.querySelectorAll('[data-test="ledger"] .m-row'));
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.m-in')?.textContent).toContain('+');
    expect(rows[0].querySelector('.m-out')).toBeNull();
    expect(rows[1].querySelector('.m-out')?.textContent).toContain('−');
    expect(rows[1].querySelector('.m-in')).toBeNull();
  });
});

describe('expenses on the phone (Online Stage 6B)', () => {
  async function setup(permissions: string[]) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ExpensesPageComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), provideFakeVat(), phone],
    }).compileComponents();
    signInWith(permissions);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ExpensesPageComponent);
    fixture.detectChanges();
    http.match((r) => r.url === `${base}expenses/categories`).forEach((r) => r.flush({ data: [{ _id: 'c1', code: '5201', nameAr: 'كهرباء', nameEn: 'Electricity', isActive: true, isSystem: false }] }));
    http.match((r) => r.url === `${base}expenses`).forEach((r) => r.flush({ month: '2026-11', data: [{ _id: 'x1', number: 'EX-1', date: '2026-11-16', accountId: 'c1', categoryName: 'كهرباء', categoryCode: '5201', amount: 5, boxId: 'b1', boxName: 'الخزنة', status: 'posted', createdByName: 'أحمد' }], total: 5, count: 1, byCategory: [], previous: { month: '2026-10', total: 0, count: 0, byCategory: [] }, pagination: { page: 1, limit: 50, totalItems: 1, totalPages: 1 } }));
    flushPaymentBoxes(http);
    http.match(() => true).forEach((r) => r.flush({}));
    fixture.detectChanges();
    return { fixture, http, el: fixture.nativeElement as HTMLElement, component: fixture.componentInstance as unknown as { filterCategory: ReturnType<typeof signal<string>> } };
  }

  it('offers "+ مصروف" only with expenses.create and the cancel action in the details sheet only with expenses.manage', async () => {
    const reader = await setup(['expenses.create']);
    expect(reader.el.querySelector('[data-action="new-expense"]')).not.toBeNull();
    reader.el.querySelector<HTMLElement>('.m-row__open')!.click();
    reader.fixture.detectChanges();
    expect(reader.el.querySelector('[data-action="cancel-expense"]')).toBeNull();

    const manager = await setup(['expenses.create', 'expenses.manage']);
    manager.el.querySelector<HTMLElement>('.m-row__open')!.click();
    manager.fixture.detectChanges();
    expect(manager.el.querySelector('[data-action="cancel-expense"]')!.classList).toContain('m-btn--danger');

    const noCreate = await setup(['expenses.manage']);
    expect(noCreate.el.querySelector('[data-action="new-expense"]')).toBeNull();
  });

  it('shows an active filter as a chip; removing it clears the filter and reloads the month', async () => {
    const { fixture, http, el, component } = await setup(['expenses.create']);
    component.filterCategory.set('c1');
    fixture.detectChanges();
    const chip = el.querySelector<HTMLElement>('[data-testid="m-filter-chips"] [data-chip="category"]');
    expect(chip).not.toBeNull();
    chip!.click();
    fixture.detectChanges();
    expect(component.filterCategory()).toBe('');
    expect(http.match((r) => r.url === `${base}expenses`).length).toBe(1);
  });
});
