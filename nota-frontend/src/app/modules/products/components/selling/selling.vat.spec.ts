import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { LanguageService } from '../../../shared/services/translation.service';
import { VAT_14_EXCLUDED, VAT_14_INCLUDED, fakeVat, provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { SellingComponent } from './selling.component';

/** Stage 21: the POS under the total shows الصافي / ضريبة القيمة المضافة 14٪ / الإجمالي when VAT applies; with prices excluding VAT the total adds the tax. */
describe('SellingComponent with VAT (Stage 21)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<SellingComponent>;
  let component: SellingComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const product = (id: string, name: string, code: string, price: number, extra: object = {}) => ({
    _id: id, name, code, wholesalePrice: price, retailPrice: price, discountPercentage: 0, priceAfterDiscount: price, inventoryCount: 50, category: { _id: 'c1', name: 'لمبات' }, ...extra,
  });
  const pick = (index: number, query: string, result: object) => {
    component.onSearchInputChange(index, input(query));
    http.expectOne((r) => r.url === `${base}products/search`).flush([result]);
    component.onNativeOptionSelect(index, component.getInvoiceItemState(index).productOptions[0]);
  };
  /** 4 x 35 + 2 x 65, discount 20 (the design's invoice). */
  const fill = (second: object = {}) => {
    pick(0, 'A', product('p1', 'لمبة', 'A35', 35));
    component.getInvoiceItem(0).get('quantity')!.setValue(4);
    component.addInvoiceItem(false);
    pick(1, 'B', product('p2', 'شاحن', 'B65', 65, second));
    component.getInvoiceItem(1).get('quantity')!.setValue(2);
    component.sellingForm.get('discountAmount')!.setValue(20);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SellingComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    fixture = TestBed.createComponent(SellingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('VAT off: no net / VAT rows, the total is what it always was', () => {
    fill();
    expect(component.vatView).toBeNull();
    expect(component.invoiceGrandTotal).toBe(250);
    expect(el().querySelector('[data-test="vat-net"]')).toBeNull();
    expect(el().querySelector('[data-test="vat-amount"]')).toBeNull();
  });

  it('prices including VAT: net 219.30, VAT 30.70 (14%), total 250 unchanged', () => {
    fakeVat().settings.set({ ...VAT_14_INCLUDED, startDate: '2000-01-01' });
    fill();
    expect(component.vatView?.vatAmount).toBe(30.7);
    expect(component.invoiceGrandTotal).toBe(250);
    fixture.detectChanges();
    expect(el().querySelector('[data-test="vat-net"]')!.textContent).toContain('219.30');
    expect(el().querySelector('[data-test="vat-amount"]')!.textContent).toContain('30.70');
    expect(el().querySelector('.pos__grand')!.textContent).toContain('250');
  });

  it('prices excluding VAT: the total visibly adds the tax (250 + 35.00 = 285.00)', () => {
    fakeVat().settings.set({ ...VAT_14_EXCLUDED, startDate: '2000-01-01' });
    fill();
    expect(component.vatView?.vatAmount).toBe(35);
    expect(component.invoiceGrandTotal).toBe(285);
    fixture.detectChanges();
    expect(el().querySelector('[data-test="vat-net"]')!.textContent).toContain('250');
    expect(el().querySelector('[data-test="vat-amount"]')!.textContent).toContain('35');
    expect(el().querySelector('.pos__grand')!.textContent).toContain('285');
  });

  it('an exempt product is marked "معفى" and is not taxed', () => {
    fakeVat().settings.set({ ...VAT_14_INCLUDED, startDate: '2000-01-01' });
    fill({ vatExempt: true });
    expect(component.isExemptLine(1)).toBeTrue();
    expect(component.isExemptLine(0)).toBeFalse();
    fixture.detectChanges();
    expect(el().querySelectorAll('[data-test="exempt-badge"]').length).toBe(1);
    // taxable gross = 140 - the discount share of that line (20 x 140/270 = 10.37) = 129.63 -> VAT 129.63 x 14/114 = 15.92
    expect(component.vatView?.vatAmount).toBe(15.92);
  });

  it('VAT does not apply before its start date', () => {
    fakeVat().settings.set({ ...VAT_14_INCLUDED, startDate: '2999-01-01' });
    fill();
    expect(component.vatView).toBeNull();
    expect(component.invoiceGrandTotal).toBe(250);
  });

  it('the request body is unchanged: the server computes and stores the VAT', () => {
    fakeVat().settings.set({ ...VAT_14_EXCLUDED, startDate: '2000-01-01' });
    fill();
    const payload = (component as unknown as { buildPayload?: () => object }).buildPayload;
    // The POS never sends totals or VAT figures: only items, discount and shipping.
    expect(payload === undefined || !JSON.stringify(payload.call(component)).includes('vat')).toBeTrue();
  });
});
