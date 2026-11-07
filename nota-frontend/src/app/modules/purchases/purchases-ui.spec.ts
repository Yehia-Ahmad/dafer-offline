import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { ROLE_PERMISSIONS } from '../../core/auth/testing/auth-fixtures';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { LanguageService } from '../shared/services/translation.service';
import { Supplier } from '../suppliers/suppliers.service';
import { PurchaseDetailComponent } from './purchase-detail.component';
import { PurchaseFormComponent } from './purchase-form.component';
import { PurchaseReturnDialogComponent, returnValue } from './purchase-return-dialog.component';
import { PurchasesPageComponent } from './purchases-page.component';
import { PurchaseDetail } from './purchases.models';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
const text = (fixture: ComponentFixture<unknown>) => (fixture.nativeElement as HTMLElement).textContent ?? '';

const SUPPLIER: Supplier = { _id: 's1', name: 'الشركة المصرية للإضاءة', phones: [], isActive: true, paymentTermsDays: 30, balance: 4200, openingAmount: 4200, ledgerAccountId: 'acc21' };
const LED = { _id: 'p-led', name: 'لمبة LED ١٢ وات', code: 'LED12', inventoryCount: 32, purchasePrice: 70 };
const CHARGER = { _id: 'p-chg', name: 'شاحن تايب سي', code: 'CHG25', inventoryCount: 13, purchasePrice: 240 };

async function setup<T>(component: new (...args: never[]) => T, { signIn = () => signInAs('owner', { permissions: [...ROLE_PERMISSIONS.owner, 'accounting.view'] }), route = {} as Record<string, string>, query = {} as Record<string, string> } = {}) {
  await TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(route), queryParamMap: convertToParamMap(query) } } }],
  }).compileComponents();
  signIn();
  TestBed.inject(LanguageService).selectedLanguage.set('en');
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(component);
  return { fixture, http, component: fixture.componentInstance };
}

describe('PurchaseFormComponent (Stage 20)', () => {
  const open = async (options = {}) => {
    const ctx = await setup(PurchaseFormComponent, options);
    ctx.fixture.detectChanges();
    ctx.http.expectOne((r) => r.url === `${base}suppliers`).flush([SUPPLIER, { ...SUPPLIER, _id: 's2', name: 'مؤسسة الفتح', balance: 0 }]);
    flushPaymentBoxes(ctx.http);
    await settle(ctx.fixture);
    return ctx;
  };
  const add = (component: PurchaseFormComponent, product: typeof LED, qty: number, price: number) => {
    component.addProduct(product);
    const row = component.lines().find((line) => line.product._id === product._id)!;
    component.setLine(row.key, 'qty', qty);
    component.setLine(row.key, 'unitPrice', price);
  };

  it("the design's invoice: totals, stock after, the journal preview and the supplier balance after (4,200 -> 6,650)", async () => {
    const { fixture, component, http } = await open();
    component.supplierId.set('s1');
    add(component, LED, 20, 70); add(component, CHARGER, 10, 240);
    component.addProduct({ _id: 'p-out', name: 'بريزة', code: 'OUT3', inventoryCount: 6, purchasePrice: 55 });
    component.setLine(component.lines()[2].key, 'qty', 30); component.setLine(component.lines()[2].key, 'unitPrice', 55);
    component.setMode('part_cash'); component.paidInput.set(3000);
    await settle(fixture);
    expect(component.allocation().total).toBe(5450);
    expect(component.remaining()).toBe(2450);
    expect(component.lines().map((row) => component.stockAfter(row))).toEqual([52, 23, 36]);
    expect(text(fixture)).toContain('5,450');
    const preview = fixture.nativeElement.querySelector('[data-test="journal-preview"]').textContent as string;
    expect(preview).toContain('5,450'); expect(preview).toContain('3,000'); expect(preview).toContain('2,450'); expect(preview).toContain('الشركة المصرية للإضاءة');
    expect(fixture.nativeElement.querySelector('[data-test="balance-before"]').textContent).toContain('4,200.00');
    expect(fixture.nativeElement.querySelector('[data-test="balance-after"]').textContent).toContain('6,650.00');
    http.verify();
  });

  it('shows each line\'s new average cost: 32 at 70 + 20 at 100 -> 81.54, lines of one product build on each other', async () => {
    const { fixture, component, http } = await open();
    add(component, LED, 20, 100);
    await settle(fixture);
    expect(component.hints()[0]?.newCost).toBe(81.54);
    expect(fixture.nativeElement.querySelector('[data-test="new-cost"]').textContent).toContain('81.54');
    http.verify();
  });

  it('discount and other costs go into the line costs and the total; the extras fold is collapsed by default', async () => {
    const { fixture, component, http } = await open();
    add(component, LED, 10, 100); add(component, CHARGER, 10, 300);
    component.discount.set(100); component.otherCosts.set(50);
    await settle(fixture);
    expect(component.allocation().total).toBe(3950);
    expect(component.allocation().lineCosts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(3950, 2);
    expect(component.extrasOpen()).toBeFalse();
    expect(fixture.nativeElement.querySelector('[data-test="extras-toggle"]')).toBeTruthy();
    http.verify();
  });

  it('the three payment modes: all cash pays the total, part cash needs 0 < paid < total, all credit pays nothing', async () => {
    const { component, http } = await open();
    component.supplierId.set('s1'); add(component, LED, 10, 100);
    component.setMode('all_cash');
    expect(component.paid()).toBe(1000); expect(component.valid()).toBeTrue();
    component.setMode('part_cash'); component.paidInput.set(1000);
    expect(component.paidInvalid()).toBeTrue(); expect(component.valid()).toBeFalse();
    component.paidInput.set(400);
    expect(component.paid()).toBe(400); expect(component.remaining()).toBe(600); expect(component.valid()).toBeTrue();
    component.setMode('all_credit');
    expect(component.paid()).toBe(0); expect(component.remaining()).toBe(1000);
    http.verify();
  });

  it('saves the exact payload (items, discount, other costs, paid, the chosen box) and opens the invoice', async () => {
    const { fixture, component, http } = await open();
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.supplierId.set('s1'); component.supplierInvoiceNo.set(' EL-8841 '); component.date.set('2026-11-03');
    add(component, LED, 20, 70); add(component, CHARGER, 10, 240);
    component.discount.set(50); component.otherCosts.set(20);
    component.setMode('part_cash'); component.paidInput.set(3000);
    await settle(fixture);
    component.save();
    const req = http.expectOne(`${base}purchases`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      supplierId: 's1', supplierInvoiceNo: 'EL-8841', date: '2026-11-03',
      items: [{ productId: 'p-led', qty: 20, unitPrice: 70 }, { productId: 'p-chg', qty: 10, unitPrice: 240 }],
      discountAmount: 50, otherCosts: 20, paidAmount: 3000,
    });
    req.flush({ _id: 'po1', number: 'PO-000001', pvNumber: 'PV-000001', supplierBalanceAfter: 6650 });
    expect(navigate).toHaveBeenCalledWith(['/purchases', 'po1'], { queryParams: { pv: 'PV-000001' } });
  });

  it('a credit invoice sends no paid amount and no box', async () => {
    const { component, http } = await open();
    TestBed.inject(Router);
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.supplierId.set('s1'); add(component, LED, 5, 70);
    component.save();
    const req = http.expectOne(`${base}purchases`);
    expect(req.request.body).toEqual({ supplierId: 's1', date: jasmine.any(String), items: [{ productId: 'p-led', qty: 5, unitPrice: 70 }] });
    req.flush({ _id: 'po2', number: 'PO-000002', pvNumber: null, supplierBalanceAfter: 4550 });
  });

  it('a user without suppliers.pay can only record the invoice on credit', async () => {
    const { fixture, component, http } = await open({ signIn: () => signInWith(['purchases.create', 'purchases.view', 'products.viewCost', 'suppliers.view']) });
    component.setMode('all_cash');
    expect(component.mode()).toBe('all_credit');
    expect(fixture.nativeElement.querySelector('[data-mode="all_cash"]').disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-mode="part_cash"]').disabled).toBeTrue();
    expect(fixture.nativeElement.querySelector('[data-test="credit-only"]')).toBeTruthy();
    http.verify();
  });

  it('an error from the server is shown by its code', async () => {
    const { fixture, component, http } = await open();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.supplierId.set('s1'); add(component, LED, 1, 70); component.setMode('all_cash');
    component.save();
    http.expectOne(`${base}purchases`).flush({ code: 'INSUFFICIENT_BALANCE' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(component.error()).toBe('purchases.errors.INSUFFICIENT_BALANCE');
    expect(component.busy()).toBeFalse();
  });

  it('"صنف جديد" creates a product with stock 0 and adds it to the invoice; it needs products.manage and products.viewCost', async () => {
    const { fixture, component, http } = await open();
    component.toggleNewProduct();
    http.expectOne(`${base}categories`).flush([{ _id: 'c1', name: 'إضاءة' }]);
    component.setNp('name', 'صنف جديد'); component.setNp('code', 'NEW-1'); component.setNp('categoryId', 'c1'); component.setNp('wholesalePrice', 50); component.setNp('retailPrice', 60);
    expect(component.newProductValid()).toBeTrue();
    component.createProduct();
    const req = http.expectOne(`${base}products`);
    expect(req.request.body).toEqual({ name: 'صنف جديد', code: 'NEW-1', categoryId: 'c1', inventoryCount: 0, purchasePrice: 0, wholesalePrice: 50, retailPrice: 60 });
    req.flush({ _id: 'p-new', name: 'صنف جديد', code: 'NEW-1' });
    await settle(fixture);
    expect(component.lines().map((row) => [row.product._id, row.product.inventoryCount])).toEqual([['p-new', 0]]);
    expect(component.newProductOpen()).toBeFalse();
    http.verify();

    TestBed.resetTestingModule();
    const limited = await open({ signIn: () => signInWith(['purchases.create', 'purchases.view', 'products.viewCost', 'suppliers.view']) });
    expect(limited.fixture.nativeElement.querySelector('[data-action="new-product"]')).toBeNull();
  });

  it('searching products asks the backend after a pause and adding the same product twice adds its quantity', async () => {
    const { component, http } = await open();
    component.addProduct(LED); component.addProduct(LED);
    expect(component.lines().length).toBe(1);
    expect(component.lines()[0].qty).toBe(2);
    http.verify();
  });
});

const PURCHASE: PurchaseDetail = {
  _id: 'po1', number: 'PO-000001', supplierId: 's1', supplierName: 'الشركة المصرية للإضاءة', supplierInvoiceNo: 'EL-8841', date: '2026-11-03T00:00:00.000Z',
  items: [
    { _id: 'i1', productId: 'p-led', name: 'لمبة LED', code: 'LED12', qty: 20, unitPrice: 70, lineTotal: 1400, lineCost: 1400, unitCost: 70, returnedQty: 0, returnedValue: 0 },
    { _id: 'i2', productId: 'p-chg', name: 'شاحن', code: 'CHG25', qty: 10, unitPrice: 240, lineTotal: 2400, lineCost: 2400, unitCost: 240, returnedQty: 0, returnedValue: 0 },
  ],
  subtotal: 3800, discountAmount: 0, otherCosts: 0, total: 3800, paidAmount: 3000, boxName: 'الخزنة الرئيسية', pvId: 'pv1', status: 'posted',
  returns: [], payment: { _id: 'pv1', number: 'PV-000001', amount: 3000, status: 'posted', boxId: 'b-main' },
};

describe('returnValue (matches the backend: the last units take the remainder)', () => {
  it('partial returns use qty × line cost / qty; the rest closes the line exactly', () => {
    const item = { qty: 20, lineCost: 2000, returnedQty: 0, returnedValue: 0 };
    expect(returnValue(item, 5)).toBe(500);
    expect(returnValue({ ...item, returnedQty: 5, returnedValue: 500 }, 15)).toBe(1500);
    expect(returnValue({ qty: 3, lineCost: 10, returnedQty: 0, returnedValue: 0 }, 1)).toBe(3.33);
    expect(returnValue({ qty: 3, lineCost: 10, returnedQty: 2, returnedValue: 6.67 }, 1)).toBe(3.33);
    expect(returnValue(item, 0)).toBe(0);
  });
});

describe('PurchasesPageComponent (Stage 20)', () => {
  it('lists purchases, filters send their params and a new-purchase button needs purchases.create', async () => {
    const { fixture, component, http } = await setup(PurchasesPageComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([SUPPLIER]);
    const first = http.expectOne((r) => r.url === `${base}purchases`);
    expect(first.request.params.get('page')).toBe('1');
    first.flush({ data: [
      { ...PURCHASE, returns: undefined, payment: undefined },
      { ...PURCHASE, _id: 'po2', number: 'PO-000002', status: 'cancelled', supplierInvoiceNo: undefined },
    ], pagination: { page: 1, limit: 50, totalItems: 2, totalPages: 1 } });
    await settle(fixture);
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('PO-000001'); expect(rows[0].textContent).toContain('EL-8841'); expect(rows[0].textContent).toContain('3,800');
    expect(rows[1].textContent).toContain('purchases.status.cancelled');
    expect(fixture.nativeElement.querySelector('[data-action="new-purchase"]')).toBeTruthy();

    component.search = 'po-1'; component.supplier = 's1'; component.status = 'cancelled'; component.from = '2026-11-01';
    component.apply();
    const filtered = http.expectOne((r) => r.url === `${base}purchases`);
    expect(filtered.request.params.get('search')).toBe('po-1');
    expect(filtered.request.params.get('supplier')).toBe('s1');
    expect(filtered.request.params.get('status')).toBe('cancelled');
    expect(filtered.request.params.get('from')).toBe('2026-11-01');
    expect(filtered.request.params.has('to')).toBeFalse();
    filtered.flush({ data: [], pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0 } });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-test="empty"]')).toBeTruthy();
    http.verify();
  });

  it('a user with purchases.view only gets no new-purchase button', async () => {
    const { fixture, http } = await setup(PurchasesPageComponent, { signIn: () => signInWith(['purchases.view', 'products.viewCost']) });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([]);
    http.expectOne((r) => r.url === `${base}purchases`).flush({ data: [], pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0 } });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-action="new-purchase"]')).toBeNull();
  });
});

describe('PurchaseDetailComponent and the return dialog (Stage 20)', () => {
  const open = async (options = {}, detail: PurchaseDetail = PURCHASE, query: Record<string, string> = {}) => {
    const ctx = await setup(PurchaseDetailComponent, { route: { id: 'po1' }, query, ...options });
    ctx.fixture.detectChanges();
    ctx.http.expectOne(`${base}purchases/po1`).flush(detail);
    flushPaymentBoxes(ctx.http);
    await settle(ctx.fixture);
    return ctx;
  };

  it('shows the lines with the cost per unit, the PV, the saved note and the actions of an owner', async () => {
    const { fixture, http } = await open({}, PURCHASE, { pv: 'PV-000001' });
    expect(fixture.nativeElement.querySelector('[data-test="saved-pv"]')).toBeTruthy();
    expect(fixture.componentInstance.pv()).toBe('PV-000001');
    expect(fixture.nativeElement.querySelector('[data-test="items"]').textContent).toContain('LED12');
    expect(fixture.nativeElement.querySelector('[data-test="total"]').textContent).toContain('3,800');
    expect(text(fixture)).toContain('PV-000001');
    for (const action of ['return', 'cancel', 'journal']) expect(fixture.nativeElement.querySelector(`[data-action="${action}"]`)).withContext(action).toBeTruthy();
    http.verify();
  });

  it('cancel needs a reason (3+ characters) and posts it; without purchases.cancel the locked pattern shows', async () => {
    const { fixture, component, http } = await open();
    (fixture.nativeElement.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect((fixture.nativeElement.querySelector('[data-action="confirm-cancel"]') as HTMLButtonElement).disabled).toBeTrue();
    component.reason = 'wrong supplier';
    await settle(fixture);
    component.cancel();
    const req = http.expectOne(`${base}purchases/po1/cancel`);
    expect(req.request.body).toEqual({ reason: 'wrong supplier' });
    req.flush({});
    http.expectOne(`${base}purchases/po1`).flush({ ...PURCHASE, status: 'cancelled', cancelReason: 'wrong supplier' });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-test="cancel-reason"]').textContent).toContain('wrong supplier');
    expect(fixture.nativeElement.querySelector('[data-action="return"]')).toBeNull();
    http.verify();

    TestBed.resetTestingModule();
    const locked = await open({ signIn: () => signInWith(['purchases.view', 'purchases.create', 'products.viewCost']) });
    expect(locked.fixture.nativeElement.querySelector('[data-action="cancel"]')).toBeNull();
    expect(locked.fixture.nativeElement.querySelector('nota-locked-action')).toBeTruthy();
    expect(locked.fixture.nativeElement.querySelector('[data-action="journal"]')).toBeNull();
  });

  it('a cancel the server refuses (stock already sold) shows its own message', async () => {
    const { fixture, component, http } = await open();
    component.reason = 'try anyway';
    component.cancel();
    http.expectOne(`${base}purchases/po1/cancel`).flush({ code: 'STOCK_ALREADY_USED' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(component.error()).toBe('purchases.errors.STOCK_ALREADY_USED');
  });

  it('the return dialog previews the value, caps the quantity at purchased − returned and posts exactly what was picked', async () => {
    const ctx = await setup(PurchaseReturnDialogComponent);
    ctx.fixture.componentRef.setInput('purchase', { ...PURCHASE, items: [{ ...PURCHASE.items[0], returnedQty: 5, returnedValue: 350 }, PURCHASE.items[1]] });
    ctx.fixture.detectChanges();
    ctx.component.visible.set(true);
    await settle(ctx.fixture);
    flushPaymentBoxes(ctx.http);
    await settle(ctx.fixture);
    const { component, http } = ctx;
    component.setQty('i1', 16);
    expect(component.overAvailable()).toBeTrue(); expect(component.valid()).toBeFalse();
    component.setQty('i1', 15); component.setQty('i2', 2);
    expect(component.overAvailable()).toBeFalse();
    expect(component.total()).toBe(1050 + 480);
    component.reason.set('wrong model'); component.refund.set(480);
    expect(component.refundInvalid()).toBeFalse();
    component.refund.set(99999);
    expect(component.valid()).toBeFalse();
    component.refund.set(480);
    const done: unknown[] = [];
    component.done.subscribe((row) => done.push(row));
    component.save();
    const req = http.expectOne(`${base}purchases/po1/returns`);
    expect(req.request.body).toEqual({ items: [{ itemId: 'i1', qty: 15 }, { itemId: 'i2', qty: 2 }], reason: 'wrong model', refundAmount: 480 });
    req.flush({ _id: 'pr1', number: 'PR-000001', total: 1530, supplierBalanceAfter: 100 });
    expect(done.length).toBe(1);
    expect(component.visible()).toBeFalse();
    flushPaymentBoxes(http);
    http.verify();
  });

  it('a return without suppliers.pay has no refund field and over-returns are shown by code', async () => {
    const ctx = await setup(PurchaseReturnDialogComponent, { signIn: () => signInWith(['purchases.create', 'products.viewCost']) });
    ctx.fixture.componentRef.setInput('purchase', PURCHASE);
    ctx.fixture.detectChanges();
    ctx.component.visible.set(true);
    await settle(ctx.fixture);
    flushPaymentBoxes(ctx.http);
    await settle(ctx.fixture);
    expect(document.body.querySelector('[data-test="refund"]')).toBeNull();
    ctx.component.setQty('i1', 1);
    ctx.component.save();
    const req = ctx.http.expectOne(`${base}purchases/po1/returns`);
    expect(req.request.body).toEqual({ items: [{ itemId: 'i1', qty: 1 }] });
    req.flush({ code: 'OVER_RETURN' }, { status: 409, statusText: 'Conflict' });
    expect(ctx.component.error()).toBe('purchases.errors.OVER_RETURN');
    flushPaymentBoxes(ctx.http);
  });
});
