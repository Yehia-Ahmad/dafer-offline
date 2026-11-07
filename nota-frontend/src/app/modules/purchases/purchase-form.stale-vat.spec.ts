import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs } from '../../core/auth/testing/sign-in';
import { ROLE_PERMISSIONS } from '../../core/auth/testing/auth-fixtures';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { LanguageService } from '../shared/services/translation.service';
import { VAT_14_INCLUDED, fakeVat, provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { Supplier } from '../suppliers/suppliers.service';
import { PurchaseFormComponent } from './purchase-form.component';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
const REGISTERED: Supplier = { _id: 's1', name: 'مورد مسجل', phones: [], isActive: true, paymentTermsDays: 30, balance: 0, openingAmount: 0, vatRegistered: true };
const LED = { _id: 'p-led', name: 'لمبة LED', code: 'LED12', inventoryCount: 32, purchasePrice: 70 };

/**
 * Stage 21 review: the purchase form refreshes the VAT settings when it opens, sends the VAT it showed as expectedVat, and on
 * 409 VAT_CHANGED takes the server's settings, shows the new VAT and waits for the user to save again.
 */
describe('purchase form stale VAT settings (Stage 21 review)', () => {
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
    http.expectOne((r) => r.url === `${base}suppliers`).flush([REGISTERED]);
    flushPaymentBoxes(http);
    await settle(fixture);
    return { fixture, component: fixture.componentInstance };
  };
  /** 10 x 100 = 1,000 net. */
  const fill = (component: PurchaseFormComponent) => {
    component.supplierId.set('s1');
    component.addProduct(LED);
    const line = component.lines()[0];
    component.setLine(line.key, 'qty', 10);
    component.setLine(line.key, 'unitPrice', 100);
  };
  afterEach(() => { flushPaymentBoxes(http); http.verify(); });

  it('refreshes the VAT settings when the screen opens', async () => {
    await open();
    expect(fakeVat().refreshCalls).toBe(1);
  });

  it('sends the VAT it showed as expectedVat (0 with VAT off, 140 on 1,000 net at 14%)', async () => {
    const { fixture, component } = await open();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fill(component);
    await settle(fixture);
    component.save();
    const off = http.expectOne(`${base}purchases`);
    expect(off.request.body.expectedVat).toBe(0);
    off.flush({ _id: 'po1', number: 'PO-000001', pvNumber: null, supplierBalanceAfter: 1000 });

    fakeVat().settings.set({ ...VAT_14_INCLUDED, startDate: '2000-01-01' });
    await settle(fixture);
    component.save();
    const on = http.expectOne(`${base}purchases`);
    expect(on.request.body.expectedVat).toBe(140);
    on.flush({ _id: 'po2', number: 'PO-000002', pvNumber: null, supplierBalanceAfter: 2140 });
  });

  it('409 VAT_CHANGED: takes the server\'s VAT block, shows the new VAT, nothing is saved; saving again sends the new expectedVat', async () => {
    const { fixture, component } = await open();
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fill(component);
    await settle(fixture);
    expect(component.vatAmount()).toBe(0);
    component.save();
    http.expectOne(`${base}purchases`).flush(
      { code: 'VAT_CHANGED', expected: 0, current: 140, vat: { ...VAT_14_INCLUDED, startDate: '2000-01-01' }, message: 'x' },
      { status: 409, statusText: 'Conflict' }
    );
    await settle(fixture);
    expect(fakeVat().appliedVat.length).toBe(1);
    expect(component.vatAmount()).toBe(140);                      // the form now shows the server's VAT
    expect(component.vatChanged()).toEqual({ expected: 0, current: 140 });
    expect(component.busy()).toBeFalse();
    expect(component.error()).toBe('');
    expect(fixture.nativeElement.querySelector('[data-test="vat-changed"]')).not.toBeNull();
    http.expectNone(`${base}purchases`);

    component.save();
    const retry = http.expectOne(`${base}purchases`);
    expect(retry.request.body.expectedVat).toBe(140);
    expect(component.vatChanged()).toBeNull();
    retry.flush({ _id: 'po3', number: 'PO-000003', pvNumber: null, supplierBalanceAfter: 1140 });
  });

  it('a unit price with more than two decimals blocks saving and says why', async () => {
    const { fixture, component } = await open();
    fill(component);
    component.setLine(component.lines()[0].key, 'unitPrice', 10.005);
    await settle(fixture);
    expect(component.priceDecimalsInvalid()).toBeTrue();
    expect(component.valid()).toBeFalse();
    expect(fixture.nativeElement.querySelector('[data-test="price-decimals"]')).not.toBeNull();
    component.setLine(component.lines()[0].key, 'unitPrice', 10.5);
    await settle(fixture);
    expect(component.priceDecimalsInvalid()).toBeFalse();
    expect(component.valid()).toBeTrue();
  });
});
