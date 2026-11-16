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
import { ExpensesPageComponent } from '../cashbox/expenses-page.component';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { PurchaseDetailComponent } from '../purchases/purchase-detail.component';
import { PurchaseDetail } from '../purchases/purchases.models';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';

/** Online Stage 6B: a phone sheet that submits stays open while saving, shows a server error inside itself with the values kept, and closes only on success. */
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };
const base = environment.api_base_url;

describe('the add-expense sheet (Online Stage 6B)', () => {
  it('stays open while saving, keeps the values and shows the error inside on a failure, and closes only on success', async () => {
    await TestBed.configureTestingModule({
      imports: [ExpensesPageComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), provideFakeVat(), phone],
    }).compileComponents();
    signInWith(['expenses.create']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ExpensesPageComponent);
    fixture.detectChanges();
    http.match((r) => r.url === `${base}expenses/categories`).forEach((r) => r.flush({ data: [{ _id: 'c1', code: '5201', nameAr: 'كهرباء', nameEn: 'Electricity', isActive: true, isSystem: false }] }));
    http.match((r) => r.url === `${base}expenses` && r.method === 'GET').forEach((r) => r.flush({ month: '2026-11', data: [], total: 0, count: 0, byCategory: [], previous: { month: '2026-10', total: 0, count: 0, byCategory: [] }, pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 1 } }));
    flushPaymentBoxes(http);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const sheetOpen = () => el.querySelector('[data-testid="m-sheet"] [data-action="save-expense"]') !== null;

    el.querySelector<HTMLElement>('[data-action="new-expense"]')!.click();
    fixture.detectChanges();
    expect(sheetOpen()).toBeTrue();
    component.category.set('c1');
    component.amount.set(75);
    component.note.set('فاتورة النور');
    fixture.detectChanges();

    el.querySelector<HTMLElement>('[data-action="save-expense"]')!.click();
    fixture.detectChanges();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === `${base}expenses`);
    expect(sheetOpen()).withContext('still open while the request is running').toBeTrue();
    expect(el.querySelector<HTMLButtonElement>('[data-action="save-expense"]')!.disabled).toBeTrue();

    post.flush({ code: 'INSUFFICIENT_BALANCE' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(sheetOpen()).withContext('a failure keeps the sheet open').toBeTrue();
    expect(el.querySelector('[data-testid="m-sheet"] [data-test="expense-error"]')).not.toBeNull();
    expect(component.amount()).toBe(75);
    expect(component.note()).toBe('فاتورة النور');

    el.querySelector<HTMLElement>('[data-action="save-expense"]')!.click();
    fixture.detectChanges();
    http.expectOne((r) => r.method === 'POST' && r.url === `${base}expenses`).flush({ _id: 'x1' });
    fixture.detectChanges();
    expect(sheetOpen()).withContext('success closes the sheet').toBeFalse();
    http.match(() => true).forEach((r) => r.flush({}));
  });
});

describe('the cancel-purchase sheet (Online Stage 6B)', () => {
  const PURCHASE = {
    _id: 'po1', number: 'PO-000001', supplierId: 's1', supplierName: 'مورد', supplierInvoiceNo: '', date: '2026-11-03T00:00:00.000Z',
    items: [{ _id: 'i1', productId: 'p1', name: 'لمبة', code: 'L1', qty: 2, unitPrice: 70, lineTotal: 140, lineCost: 140, unitCost: 70, returnedQty: 0, returnedValue: 0 }],
    subtotal: 140, discountAmount: 0, otherCosts: 0, total: 140, paidAmount: 0, status: 'posted', returns: [],
  } as unknown as PurchaseDetail;

  it('shows the error inside the sheet and keeps the reason when the server refuses, and closes on success', async () => {
    await TestBed.configureTestingModule({
      imports: [PurchaseDetailComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), provideFakeVat(), phone,
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'po1' }), queryParamMap: convertToParamMap({}) } } }],
    }).compileComponents();
    signInWith(['purchases.view', 'purchases.cancel']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PurchaseDetailComponent);
    fixture.detectChanges();
    http.expectOne(`${base}purchases/po1`).flush(PURCHASE);
    flushPaymentBoxes(http);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const sheetOpen = () => el.querySelector('[data-testid="m-sheet"] [data-action="confirm-cancel"]') !== null;

    el.querySelector<HTMLElement>('[data-action="cancel"]')!.click();
    fixture.detectChanges();
    expect(sheetOpen()).toBeTrue();
    const reasonInput = el.querySelector<HTMLInputElement>('[data-test="cancel-reason-input"]')!;
    reasonInput.value = 'تم الشراء بالغلط';
    reasonInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    el.querySelector<HTMLElement>('[data-action="confirm-cancel"]')!.click();
    http.expectOne((r) => r.method === 'POST' && r.url.includes('purchases/po1/cancel')).flush({ code: 'STOCK_ALREADY_USED' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(sheetOpen()).toBeTrue();
    expect(el.querySelector('[data-testid="m-sheet"] [data-test="cancel-error"]')).not.toBeNull();
    expect(component.reason).toBe('تم الشراء بالغلط');

    el.querySelector<HTMLElement>('[data-action="confirm-cancel"]')!.click();
    http.expectOne((r) => r.method === 'POST' && r.url.includes('purchases/po1/cancel')).flush({});
    fixture.detectChanges();
    expect(sheetOpen()).toBeFalse();
    http.match(() => true).forEach((r) => r.flush({ ...PURCHASE, status: 'cancelled' }));
  });
});
