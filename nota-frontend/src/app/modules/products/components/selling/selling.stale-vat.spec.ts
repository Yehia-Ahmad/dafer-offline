import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { LanguageService } from '../../../shared/services/translation.service';
import { VAT_14_EXCLUDED, fakeVat, provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { SellingComponent } from './selling.component';

/**
 * Stage 21 review: another PC changed the VAT settings after this one signed in. The POS refreshes the settings when it opens,
 * sends the total the cashier saw, and on 409 TOTAL_CHANGED takes the server's settings, shows the new total and asks again.
 */
describe('SellingComponent stale VAT settings (Stage 21 review)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<SellingComponent>;
  let component: SellingComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const product = (id: string, name: string, code: string, price: number) => ({
    _id: id, name, code, wholesalePrice: price, retailPrice: price, discountPercentage: 0, priceAfterDiscount: price, inventoryCount: 50, category: { _id: 'c1', name: 'لمبات' },
  });
  const pick = (index: number, query: string, result: object) => {
    component.onSearchInputChange(index, input(query));
    http.expectOne((r) => r.url === `${base}products/search`).flush([result]);
    component.onNativeOptionSelect(index, component.getInvoiceItemState(index).productOptions[0]);
  };
  /** 4 x 35 + 2 x 65, discount 20: 250 with VAT off, 285 with prices excluding 14% VAT. */
  const fill = () => {
    pick(0, 'A', product('p1', 'لمبة', 'A35', 35));
    component.getInvoiceItem(0).get('quantity')!.setValue(4);
    component.addInvoiceItem(false);
    pick(1, 'B', product('p2', 'شاحن', 'B65', 65));
    component.getInvoiceItem(1).get('quantity')!.setValue(2);
    component.sellingForm.patchValue({ customerName: 'زبون', customerPhone: '01000000000', discountAmount: 20 });
    fixture.detectChanges();
  };
  const post = () => http.expectOne(`${base}sellings`);
  const changed = { code: 'TOTAL_CHANGED', expected: 250, current: 285, vat: { ...VAT_14_EXCLUDED, startDate: '2000-01-01' }, message: 'x' };

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

  it('refreshes the VAT settings when the screen opens', () => {
    expect(fakeVat().refreshCalls).toBe(1);
  });

  it('sends the total the cashier saw as expectedTotal: VAT off 250', () => {
    fill();
    component.saveSelling();
    const request = post();
    expect(request.request.body.expectedTotal).toBe(250);
    request.flush({ _id: 's1' }, { status: 201, statusText: 'Created' });
    expect(component.successDialogVisible).toBeTrue();
  });

  it('sends the total the cashier saw as expectedTotal: prices excluding VAT 285', () => {
    fakeVat().settings.set({ ...VAT_14_EXCLUDED, startDate: '2000-01-01' });
    fill();
    component.saveSelling();
    const request = post();
    expect(request.request.body.expectedTotal).toBe(285);
    request.flush({ _id: 's2' }, { status: 201, statusText: 'Created' });
  });

  it('409 TOTAL_CHANGED: takes the server\'s VAT block, shows the new total in a dialog, nothing is saved yet', () => {
    fill();
    component.saveSelling();
    expect(component.invoiceGrandTotal).toBe(250);
    post().flush(changed, { status: 409, statusText: 'Conflict' });
    expect(fakeVat().appliedVat.length).toBe(1);
    expect(fakeVat().appliedVat[0]?.pricesIncludeVat).toBeFalse();
    expect(component.invoiceGrandTotal).toBe(285);          // the screen follows the new settings
    expect(component.totalChangedVisible).toBeTrue();
    expect(component.totalChanged).toEqual({ expected: 250, current: 285 });
    expect(component.isSaving).toBeFalse();
    expect(component.successDialogVisible).toBeFalse();
    fixture.detectChanges();
    expect(document.body.querySelector('[data-test="total-changed"]')).not.toBeNull();
    http.expectNone(`${base}sellings`);
  });

  it('confirming sends the same invoice again with the new total; it is saved', () => {
    fill();
    component.saveSelling();
    post().flush(changed, { status: 409, statusText: 'Conflict' });
    component.confirmTotalChanged();
    const retry = post();
    expect(retry.request.body.expectedTotal).toBe(285);
    expect(retry.request.body.items).toEqual([{ productId: 'p1', quantity: 4, price: 35 }, { productId: 'p2', quantity: 2, price: 65 }]);
    expect(retry.request.body.discountAmount).toBe(20);
    retry.flush({ _id: 's3' }, { status: 201, statusText: 'Created' });
    expect(component.totalChangedVisible).toBeFalse();
    expect(component.successDialogVisible).toBeTrue();
  });

  it('cancelling the dialog sends nothing more and keeps the invoice for review', () => {
    fill();
    component.saveSelling();
    post().flush(changed, { status: 409, statusText: 'Conflict' });
    component.cancelTotalChanged();
    expect(component.totalChangedVisible).toBeFalse();
    http.expectNone(`${base}sellings`);
    expect(component.invoiceItems.length).toBe(2);
    expect(component.invoiceGrandTotal).toBe(285);
  });

  it('a unit price with more than two decimals is refused before anything is sent', () => {
    fill();
    component.getInvoiceItem(1).get('priceType')!.setValue('custom');
    component.getInvoiceItem(1).get('price')!.setValue(10.005);
    component.saveSelling();
    http.expectNone(`${base}sellings`);
    expect(component.saveError).toBe('vat.priceDecimals');
    expect(component.getInvoiceItem(1).get('price')!.hasError('decimals')).toBeTrue();
    component.getInvoiceItem(1).get('price')!.setValue(10.5);
    expect(component.getInvoiceItem(1).get('price')!.valid).toBeTrue();
    expect(el().querySelector('.pos__price')).not.toBeNull();
  });
});
