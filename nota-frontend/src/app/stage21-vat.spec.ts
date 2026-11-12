import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../environments/environment';
import { signInAs } from './core/auth/testing/sign-in';
import { ROLE_PERMISSIONS } from './core/auth/testing/auth-fixtures';
import { flushPaymentBoxes, MAIN_ONLY_BOXES } from './modules/cashbox/testing/payment-boxes.testing';
import { ExpensesPageComponent } from './modules/cashbox/expenses-page.component';
import { PurchaseFormComponent } from './modules/purchases/purchase-form.component';
import { PurchaseReturnDialogComponent } from './modules/purchases/purchase-return-dialog.component';
import { journalPreview } from './modules/purchases/purchase-math';
import { LanguageService } from './modules/shared/services/translation.service';
import { VAT_14_INCLUDED, fakeVat, provideFakeVat } from './modules/shop-profile/services/vat-settings.testing';
import { ShopProfileComponent } from './modules/shop-profile/components/shop-profile/shop-profile.component';
import { SupplierFormComponent } from './modules/suppliers/supplier-form.component';
import { Supplier } from './modules/suppliers/suppliers.service';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
const ACTIVE = { ...VAT_14_INCLUDED, startDate: '2000-01-01' };

const REGISTERED: Supplier = { _id: 's1', name: 'مورد مسجل', phones: [], isActive: true, paymentTermsDays: 30, balance: 0, openingAmount: 0, vatRegistered: true };
const PLAIN: Supplier = { _id: 's2', name: 'مورد عادي', phones: [], isActive: true, balance: 0, openingAmount: 0 };
const LED = { _id: 'p-led', name: 'لمبة LED', code: 'LED12', inventoryCount: 32, purchasePrice: 70 };
const CHARGER = { _id: 'p-chg', name: 'شاحن', code: 'CHG25', inventoryCount: 13, purchasePrice: 240 };

describe('purchase form with VAT (Stage 21)', () => {
  let http: HttpTestingController;
  const open = async () => {
    await TestBed.configureTestingModule({
      imports: [PurchaseFormComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), provideFakeVat(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}) } } }],
    }).compileComponents();
    signInAs('owner', { permissions: [...ROLE_PERMISSIONS.owner, 'accounting.view'] });
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PurchaseFormComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([REGISTERED, PLAIN]);
    flushPaymentBoxes(http);
    await settle(fixture);
    return { fixture, component: fixture.componentInstance, http };
  };
  const add = (component: PurchaseFormComponent, product: typeof LED, qty: number, price: number) => {
    component.addProduct(product);
    const line = component.lines().find((row) => row.product._id === product._id)!;
    component.setLine(line.key, 'qty', qty);
    component.setLine(line.key, 'unitPrice', price);
  };
  /** 20 x 70 + 10 x 240 + 30 x 55 = 5,450. */
  const fill = (component: PurchaseFormComponent) => {
    add(component, LED, 20, 70); add(component, CHARGER, 10, 240);
    component.addProduct({ _id: 'p-out', name: 'بريزة', code: 'OUT3', inventoryCount: 6, purchasePrice: 55 });
    component.setLine(component.lines()[2].key, 'qty', 30); component.setLine(component.lines()[2].key, 'unitPrice', 55);
  };
  afterEach(() => { if (http) { flushPaymentBoxes(http); http.verify(); } });

  it('VAT off: nothing about VAT on the screen or in the body; the total is the net', async () => {
    const { fixture, component } = await open();
    component.supplierId.set('s1'); fill(component);
    await settle(fixture);
    expect(component.vatContext()).toBeNull();
    expect(component.vatAmount()).toBe(0);
    expect(component.grandTotal()).toBe(5450);
    expect(fixture.nativeElement.querySelector('[data-test="vat-block"]')).toBeNull();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.save();
    const req = http.expectOne(`${base}purchases`);
    expect(JSON.stringify(req.request.body)).not.toContain('vat');
    req.flush({ _id: 'po1', number: 'PO-000001', pvNumber: null, supplierBalanceAfter: 5450 });
  });

  it("a registered supplier: VAT 763 on 5,450 net, total 6,213, the journal posts inventory 5,450 + VAT 763 / supplier 6,213", async () => {
    const { fixture, component } = await open();
    fakeVat().settings.set(ACTIVE);
    component.supplierId.set('s1'); fill(component);
    await settle(fixture);
    expect(component.vatRegistered()).toBeTrue();
    expect(component.vatAmount()).toBe(763);
    expect(component.grandTotal()).toBe(6213);
    expect(component.allocation().total).toBe(5450);
    expect(fixture.nativeElement.querySelector('[data-test="net"]').textContent).toContain('5,450');
    expect(fixture.nativeElement.querySelector('[data-test="vat"]').textContent).toContain('763');
    expect(fixture.nativeElement.querySelector('[data-test="total"]').textContent).toContain('6,213');
    expect(component.preview()).toEqual([
      { account: 'inventory', side: 'debit', amount: 5450 }, { account: 'vat', side: 'debit', amount: 763 }, { account: 'supplier', side: 'credit', amount: 6213 },
    ]);
    // inventory never includes the recoverable VAT: the line costs (and so the average cost) stay on the net
    expect(component.allocation().lineCosts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(5450, 2);
  });

  it('a supplier that is not VAT registered: VAT 0, the whole amount is cost; the checkbox can turn it on for one invoice', async () => {
    const { fixture, component } = await open();
    fakeVat().settings.set(ACTIVE);
    component.supplierId.set('s2'); fill(component);
    await settle(fixture);
    expect(component.vatRegistered()).toBeFalse();
    expect(component.vatAmount()).toBe(0);
    expect(component.grandTotal()).toBe(5450);
    expect(component.preview().some((row) => row.account === 'vat')).toBeFalse();
    component.setVatRegistered(true);
    expect(component.vatAmount()).toBe(763);
  });

  it("the supplier's printed VAT is editable (760 -> total 6,210); the amount is validated against the invoice total", async () => {
    const { component } = await open();
    fakeVat().settings.set(ACTIVE);
    component.supplierId.set('s1'); fill(component);
    component.setVatAmount(760);
    expect(component.vatAmount()).toBe(760);
    expect(component.grandTotal()).toBe(6210);
    component.setVatAmount(6000);
    expect(component.vatInvalid()).toBeTrue();
    component.mode.set('all_credit');
    expect(component.valid()).toBeFalse();
    component.setVatAmount(null);
    expect(component.vatAmount()).toBe(763);
    expect(component.valid()).toBeTrue();
  });

  it('payment modes use the total with VAT: all cash pays 6,213; part cash must stay below it', async () => {
    const { component } = await open();
    fakeVat().settings.set(ACTIVE);
    component.supplierId.set('s1'); fill(component);
    component.setMode('all_cash');
    expect(component.paid()).toBe(6213);
    component.setMode('part_cash'); component.paidInput.set(6213);
    expect(component.paidInvalid()).toBeTrue();
    component.paidInput.set(6000);
    expect(component.paidInvalid()).toBeFalse();
    expect(component.remaining()).toBe(213);
  });

  it('the body carries vatRegistered (and the amount only when the user typed the supplier\'s)', async () => {
    const { component } = await open();
    fakeVat().settings.set(ACTIVE);
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.supplierId.set('s1'); component.date.set('2026-11-03'); add(component, LED, 5, 100);
    component.save();
    let req = http.expectOne(`${base}purchases`);
    expect(req.request.body).toEqual({ supplierId: 's1', date: '2026-11-03', items: [{ productId: 'p-led', qty: 5, unitPrice: 100 }], vatRegistered: true, expectedVat: 70 });
    req.flush({ _id: 'po1', number: 'PO-1', pvNumber: null, supplierBalanceAfter: 0 });
    component.setVatAmount(69);
    component.save();
    req = http.expectOne(`${base}purchases`);
    expect(req.request.body.vatAmount).toBe(69);
    req.flush({ _id: 'po2', number: 'PO-2', pvNumber: null, supplierBalanceAfter: 0 });
  });

  it('journalPreview: without VAT the old lines; with VAT the inventory takes the net', () => {
    expect(journalPreview(1000, 400)).toEqual([{ account: 'inventory', side: 'debit', amount: 1000 }, { account: 'box', side: 'credit', amount: 400 }, { account: 'supplier', side: 'credit', amount: 600 }]);
    expect(journalPreview(1140, 0, 140)).toEqual([{ account: 'inventory', side: 'debit', amount: 1000 }, { account: 'vat', side: 'debit', amount: 140 }, { account: 'supplier', side: 'credit', amount: 1140 }]);
  });
});

describe('purchase return with VAT (Stage 21)', () => {
  it('shows the VAT share of the return (cumulative proportion; the return that empties the invoice takes the rest)', async () => {
    await TestBed.configureTestingModule({
      imports: [PurchaseReturnDialogComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PurchaseReturnDialogComponent);
    const purchase = {
      _id: 'po1', number: 'PO-000001', supplierId: 's1', date: '2026-11-03', subtotal: 1800, discountAmount: 0, otherCosts: 0, total: 2052, netTotal: 1800, vatAmount: 252, vatRate: 14, vatRegistered: true,
      paidAmount: 0, status: 'posted', returns: [], payment: null,
      items: [
        { _id: 'i1', productId: 'p1', name: 'لمبة', code: 'L', qty: 10, unitPrice: 100, lineTotal: 1000, lineCost: 1000, unitCost: 100, returnedQty: 0, returnedValue: 0 },
        { _id: 'i2', productId: 'p2', name: 'شاحن', code: 'C', qty: 5, unitPrice: 160, lineTotal: 800, lineCost: 800, unitCost: 160, returnedQty: 0, returnedValue: 0 },
      ],
    };
    fixture.componentRef.setInput('purchase', purchase);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.visible.set(true);
    await settle(fixture);
    flushPaymentBoxes(http);
    http.match((r) => r.url === `${base}suppliers/s1`).forEach((r) => r.flush({ balance: 0 }));
    component.setQty('i1', 4);
    expect(component.total()).toBe(400);
    expect(component.vatShare()).toBe(56);
    expect(component.grossTotal()).toBe(456);
    // the return that empties the invoice takes what is left of the VAT
    component.setQty('i1', 10); component.setQty('i2', 5);
    expect(component.vatShare()).toBe(252);
    expect(component.grossTotal()).toBe(2052);
    http.verify();
  });
});

describe('expense with VAT (Stage 21)', () => {
  let http: HttpTestingController;
  const open = async () => {
    sessionStorage.removeItem('nota.paymentBox');
    await TestBed.configureTestingModule({
      imports: [ExpensesPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signInAs('owner');
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ExpensesPageComponent);
    fixture.detectChanges();
    http.expectOne(`${base}cashbox/payment-boxes`).flush(MAIN_ONLY_BOXES);
    http.expectOne(`${base}expenses/categories`).flush({ data: [{ _id: 'c523', code: '523', nameAr: 'كهرباء', nameEn: 'Utilities', isSystem: true, isActive: true, hasLines: false }] });
    http.expectOne((r) => r.url === `${base}expenses`).flush({ month: '2026-11', data: [{ _id: 'e1', number: 'EX-000001', date: '2026-11-03T00:00:00Z', accountId: 'c523', categoryName: 'كهرباء', categoryCode: '523', amount: 114, vatAmount: 14, boxId: 'box-main', boxName: 'الخزنة', status: 'posted' }],
      total: 114, count: 1, byCategory: [], previous: { month: '2026-10', total: 0, count: 0, byCategory: [] }, pagination: { page: 1, limit: 50, totalItems: 1, totalPages: 1 } });
    await settle(fixture);
    return fixture;
  };
  afterEach(() => { http.verify(); sessionStorage.removeItem('nota.paymentBox'); });

  it('refreshes the VAT settings when the screen opens (another PC may have changed them)', async () => {
    await open();
    expect(fakeVat().refreshCalls).toBe(1);
  });

  it('VAT off: no VAT field, the body is what it always was', async () => {
    const fixture = await open();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="expense-vat"]')).toBeNull();
    const component = fixture.componentInstance;
    component.category.set('c523'); component.amount.set(114);
    component.save();
    const req = http.expectOne(`${base}expenses`);
    expect(JSON.stringify(req.request.body)).not.toContain('vat');
    req.flush({ _id: 'e2' });
    http.expectOne((r) => r.url === `${base}expenses`).flush({ month: '2026-11', data: [], total: 0, count: 0, byCategory: [], previous: { month: '2026-10', total: 0, count: 0, byCategory: [] }, pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 1 } });
    flushPaymentBoxes(http);
  });

  it('VAT on: an optional "ضريبة على الفاتورة"; sent with the amount; the row shows the VAT inside; VAT must be below the total', async () => {
    const fixture = await open();
    fakeVat().settings.set(ACTIVE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-test="expense-vat"]')).toBeTruthy();
    expect(el.querySelector('[data-test="expense-row-vat"]')!.textContent).toContain('vat.expense.inside');
    const component = fixture.componentInstance;
    component.category.set('c523'); component.amount.set(114);
    component.vatAmount.set(114);
    expect(component.vatInvalid()).toBeTrue(); expect(component.canSave()).toBeFalse();
    component.vatAmount.set(14);
    expect(component.vatInvalid()).toBeFalse(); expect(component.vatNet()).toBe(100); expect(component.canSave()).toBeTrue();
    component.save();
    const req = http.expectOne(`${base}expenses`);
    expect(req.request.body.vatAmount).toBe(14);
    expect(req.request.body.amount).toBe(114);
    req.flush({ _id: 'e3' });
    http.expectOne((r) => r.url === `${base}expenses`).flush({ month: '2026-11', data: [], total: 0, count: 0, byCategory: [], previous: { month: '2026-10', total: 0, count: 0, byCategory: [] }, pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 1 } });
    flushPaymentBoxes(http);
  });
});

describe('shop profile "الضريبة" card (Stage 21)', () => {
  const url = `${base}shop-profile`;
  let http: HttpTestingController;
  let component: any;
  let fixture: ComponentFixture<ShopProfileComponent>;
  const load = async (profile: object) => {
    await TestBed.configureTestingModule({
      imports: [ShopProfileComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShopProfileComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush({ name: 'النور', address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '', ...profile });
    fixture.detectChanges();
  };
  afterEach(() => http.verify());

  it('VAT never touched: the card is there, off, and the PUT body has no vat block (a shop without VAT sends what it always sent)', async () => {
    await load({});
    expect(fixture.nativeElement.querySelector('[data-test="vat-card"]')).toBeTruthy();
    expect(component.form.value.vatEnabled).toBeFalse();
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(Object.keys(req.request.body)).not.toContain('vat');
    req.flush({ name: 'النور', address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '' });
  });

  it('turning VAT on needs the tax number: nothing is sent and the warning shows; with it, the vat block goes out', async () => {
    await load({});
    component.form.controls.vatEnabled.setValue(true);
    component.form.controls.vatEnabled.markAsDirty();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="vat-tax-required"]')).toBeTruthy();
    component.save();
    http.expectNone((r) => r.method === 'PUT');
    component.form.patchValue({ taxNumber: ' 123-456-789 ', vatRate: '14.5' });
    component.form.controls.vatIncludes.setValue(false);
    component.form.controls.vatIncludes.markAsDirty();
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(req.request.body.taxNumber).toBe('123-456-789');
    expect(req.request.body.vat).toEqual({ enabled: true, rate: 14.5, pricesIncludeVat: false });
    req.flush({ name: 'النور', address: '', phones: [], logo: null, taxNumber: '123-456-789', commercialRegister: '', invoiceFooter: '', vat: { enabled: true, rate: 14.5, pricesIncludeVat: false, startDate: '2026-11-05T00:00:00.000Z' } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="vat-start"]')!.textContent).toContain('2026-11-05');
  });

  it('the rate must be 0-100 with at most two decimals', async () => {
    await load({ taxNumber: '1', vat: { enabled: true, rate: 14, pricesIncludeVat: true, startDate: '2026-11-01T00:00:00.000Z' } });
    for (const bad of ['101', '-1', '14.123', 'abc', '']) {
      component.form.controls.vatRate.setValue(bad);
      expect(component.vatRateInvalid()).withContext(bad).toBeTrue();
    }
    for (const good of ['0', '14', '14.5', '14.25', '100']) {
      component.form.controls.vatRate.setValue(good);
      expect(component.vatRateInvalid()).withContext(good).toBeFalse();
    }
  });

  it('once VAT is in use the block is always sent (turning it off sends enabled:false)', async () => {
    await load({ taxNumber: '1', vat: { enabled: true, rate: 14, pricesIncludeVat: true, startDate: '2026-11-01T00:00:00.000Z' } });
    component.form.controls.vatEnabled.setValue(false);
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(req.request.body.vat).toEqual({ enabled: false, rate: 14, pricesIncludeVat: true });
    req.flush({ name: 'النور', address: '', phones: [], logo: null, taxNumber: '1', commercialRegister: '', invoiceFooter: '', vat: { enabled: false, rate: 14, pricesIncludeVat: true } });
  });
});

describe('supplier form VAT flag (Stage 21)', () => {
  it('a new supplier without the flag sends the old body; with it, vatRegistered: true', async () => {
    await TestBed.configureTestingModule({
      imports: [SupplierFormComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    const fixture = TestBed.createComponent(SupplierFormComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.form.patchValue({ name: 'شركة', termsChoice: 'cash' });
    expect(Object.keys(component.buildPayload())).not.toContain('vatRegistered');
    component.form.patchValue({ vatRegistered: true });
    expect(component.buildPayload().vatRegistered).toBeTrue();
  });
});
