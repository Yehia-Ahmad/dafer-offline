import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { VAT_14_EXCLUDED, VAT_14_INCLUDED, fakeVat, provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { CreditSalesComponent } from './credit-sales.component';

/** Stage 21: the credit sale form shows الصافي / الضريبة / الإجمالي with VAT; with prices excluding VAT the receivable adds the tax. */
describe('CreditSalesComponent with VAT (Stage 21)', () => {
  const base = environment.api_base_url;
  let component: CreditSalesComponent;
  let http: HttpTestingController;
  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const product = (id: string, name: string, code: string, price: number, extra: object = {}) => ({
    _id: id, name, code, wholesalePrice: price, retailPrice: price, inventoryCount: 50, category: { _id: 'c1', name: 'لمبات' }, ...extra,
  });
  const pick = (index: number, query: string, result: object) => {
    component.onSearchInputChange(index, input(query));
    http.expectOne((r) => r.url === `${base}products/search`).flush([result]);
    component.onNativeOptionSelect(index, component.getLineItemState(index).productOptions[0]);
  };
  const fill = (second: object = {}) => {
    pick(0, 'A', product('p1', 'لمبة', 'A35', 35));
    component.lineItemControls[0].get('quantity')!.setValue(4);
    component.addLineItem();
    pick(1, 'B', product('p2', 'شاحن', 'B65', 65, second));
    component.lineItemControls[1].get('quantity')!.setValue(2);
    component.creditSaleForm.patchValue({ sellingDate: new Date(2026, 10, 4), discountAmount: 20 });
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CreditSalesComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    })
      .overrideComponent(CreditSalesComponent, { set: { template: '', imports: [] } })
      .compileComponents();
    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(CreditSalesComponent).componentInstance;
    component.ngOnInit();
  });

  afterEach(() => http.verify());

  it('VAT off: no VAT view, the receivable is 250', () => {
    fill();
    expect(component.vatView).toBeNull();
    expect(component.totalReceivable).toBe(250);
  });

  it('prices including VAT: net 219.30 + VAT 30.70 = 250', () => {
    fakeVat().settings.set({ ...VAT_14_INCLUDED, startDate: '2000-01-01' });
    fill();
    expect(component.vatView?.vatAmount).toBe(30.7);
    expect(component.vatView?.netAmount).toBe(219.3);
    expect(component.totalReceivable).toBe(250);
  });

  it('prices excluding VAT: the receivable is 285.00 and the down payment is checked against it', () => {
    fakeVat().settings.set({ ...VAT_14_EXCLUDED, startDate: '2000-01-01' });
    fill();
    expect(component.vatView?.vatAmount).toBe(35);
    expect(component.totalReceivable).toBe(285);
    component.creditSaleForm.patchValue({ downPayment: 100 });
    expect(component.financedAmount).toBe(185);
  });

  it('exempt products are marked and left out of the taxable amount; the body has no VAT figures', () => {
    fakeVat().settings.set({ ...VAT_14_INCLUDED, startDate: '2000-01-01' });
    fill({ vatExempt: true });
    expect(component.isExemptLine(1)).toBeTrue();
    expect(component.vatView?.vatAmount).toBe(15.92);
  });
});
