import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { LayoutService } from '../../core/layout/layout.service';
import { signInWith } from '../../core/auth/testing/sign-in';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { CreditSalesComponent } from '../products/components/credit-sales/credit-sales.component';
import { SuppliersPageComponent } from '../suppliers/suppliers-page.component';
import { InvoiceHistoryComponent } from '../products/components/invoice-history/invoice-history.component';

/** Online Stage 6B, group B: the phone templates over the same components (LayoutService says "mobile" here). */
const phone = (mobile: boolean) => ({ provide: LayoutService, useValue: { isMobile: signal(mobile) } });
const base = environment.api_base_url;

describe('credit sale on the phone (Online Stage 6B)', () => {
  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const digits = (text: string) => text.replace(/[^\d٠-٩]/g, '');

  async function totalsText(mobile: boolean): Promise<{ shown: string; receivable: number }> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CreditSalesComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat(), phone(mobile)],
    }).compileComponents();
    signInWith(['credit.create', 'sales.discount']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CreditSalesComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    const pick = (index: number, query: string, id: string, price: number) => {
      component.onSearchInputChange(index, input(query));
      http.expectOne((r) => r.url === `${base}products/search`).flush([{ _id: id, name: `صنف ${id}`, code: id, wholesalePrice: price, retailPrice: price, inventoryCount: 50, category: { _id: 'c1', name: 'لمبات' } }]);
      component.onNativeOptionSelect(index, component.getLineItemState(index).productOptions[0]);
    };
    pick(0, 'A', 'A35', 35);
    component.lineItemControls[0].get('quantity')!.setValue(4);
    component.addLineItem();
    pick(1, 'B', 'B65', 65);
    component.lineItemControls[1].get('quantity')!.setValue(2);
    component.creditSaleForm.patchValue({ sellingDate: new Date(2026, 10, 4), discountAmount: 20 });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const node = mobile ? el.querySelector('[data-testid="m-invoice-button"] .nota-num') : el.querySelector('.cs__net .nota-num');
    return { shown: digits(node?.textContent ?? ''), receivable: component.totalReceivable };
  }

  it('shows the same net total as the desktop layout for the same lines', async () => {
    const desktop = await totalsText(false);
    const mobile = await totalsText(true);
    expect(desktop.receivable).toBe(250);
    expect(mobile.receivable).toBe(desktop.receivable);
    expect(mobile.shown).toBe(desktop.shown);
    expect(mobile.shown.length).toBeGreaterThan(0);
  });
});

describe('suppliers on the phone (Online Stage 6B)', () => {
  async function menuActions(permissions: string[]): Promise<string[]> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SuppliersPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), phone(true)],
    }).compileComponents();
    signInWith(permissions);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([{ _id: 's1', name: 'مورد', phones: ['010'], balance: 25, isActive: true, ledgerAccountId: 'a1' }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLElement>('[data-testid="m-supplier-menu"]')!.click();
    fixture.detectChanges();
    return Array.from(el.querySelectorAll('.m-menu [data-action]')).map((node) => node.getAttribute('data-action')!);
  }

  it('offers edit and delete in the ⋯ menu only with suppliers.manage', async () => {
    expect(await menuActions(['suppliers.view'])).toEqual(['statement', 'ledger']);
    expect(await menuActions(['suppliers.view', 'suppliers.manage'])).toEqual(['statement', 'ledger', 'edit', 'toggle-active', 'delete']); // Online Fixes 1: stop / restart a supplier
  });

  it('asks before deleting (a red confirm sheet) and does not call the API until confirmed', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SuppliersPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), phone(true)],
    }).compileComponents();
    signInWith(['suppliers.view', 'suppliers.manage']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([{ _id: 's1', name: 'مورد', phones: [], balance: 0, isActive: true }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLElement>('[data-testid="m-supplier-menu"]')!.click();
    fixture.detectChanges();
    el.querySelector<HTMLElement>('.m-menu [data-action="delete"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="m-confirm-ok"]')!.classList).toContain('m-btn--danger');
    http.expectNone((r) => r.method === 'DELETE');
    el.querySelector<HTMLElement>('[data-testid="m-confirm-ok"]')!.click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === `${base}suppliers/s1`).flush({ message: 'ok' });
    http.expectOne((r) => r.url === `${base}suppliers`).flush([]);
  });
});

describe('invoice history filters on the phone (Online Stage 6B)', () => {
  it('shows each active filter as a chip and removing a chip clears that filter and reloads', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [InvoiceHistoryComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat(), phone(true)],
    }).compileComponents();
    signInWith(['sales.view']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(InvoiceHistoryComponent);
    const component = fixture.componentInstance as unknown as { filterCustomerName: string; filterCustomerPhone: string };
    fixture.detectChanges();
    http.match(() => true).forEach((request) => request.flush({ data: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 1, hasNextPage: false, hasPrevPage: false } }));
    component.filterCustomerName = 'منى';
    component.filterCustomerPhone = '0100';
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('[data-testid="m-filter-chips"] [data-chip]')).map((chip) => chip.getAttribute('data-chip'))).toEqual(['name', 'phone']);
    el.querySelector<HTMLElement>('[data-chip="name"]')!.click();
    fixture.detectChanges();
    expect(component.filterCustomerName).toBe('');
    expect(component.filterCustomerPhone).toBe('0100');
    expect(http.match((r) => r.url.includes('sellings')).length).toBeGreaterThan(0); // the list was asked again
  });
});
