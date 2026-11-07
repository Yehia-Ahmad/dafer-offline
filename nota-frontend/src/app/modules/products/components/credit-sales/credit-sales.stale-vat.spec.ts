import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { VAT_14_EXCLUDED, fakeVat, provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { CreditSalesComponent } from './credit-sales.component';

/**
 * Stage 21 review: the credit form refreshes the VAT settings when it opens, sends the total it showed, and on 409 TOTAL_CHANGED
 * takes the server's settings and keeps the review dialog open with the new total so the user confirms again.
 */
describe('CreditSalesComponent stale VAT settings (Stage 21 review)', () => {
  const base = environment.api_base_url;
  let component: CreditSalesComponent;
  let http: HttpTestingController;
  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const product = (id: string, name: string, code: string, price: number) => ({
    _id: id, name, code, wholesalePrice: price, retailPrice: price, inventoryCount: 50, category: { _id: 'c1', name: 'لمبات' },
  });
  const pick = (index: number, query: string, result: object) => {
    component.onSearchInputChange(index, input(query));
    http.expectOne((r) => r.url === `${base}products/search`).flush([result]);
    component.onNativeOptionSelect(index, component.getLineItemState(index).productOptions[0]);
  };
  /** 4 x 35 + 2 x 65, discount 20: 250 with VAT off, 285 with prices excluding 14% VAT. */
  const fill = () => {
    pick(0, 'A', product('p1', 'لمبة', 'A35', 35));
    component.lineItemControls[0].get('quantity')!.setValue(4);
    component.addLineItem();
    pick(1, 'B', product('p2', 'شاحن', 'B65', 65));
    component.lineItemControls[1].get('quantity')!.setValue(2);
    component.creditSaleForm.patchValue({ customerName: 'ورشة', customerPhone: '01000000000', sellingDate: new Date(2026, 10, 4), discountAmount: 20 });
  };
  const post = () => http.expectOne(`${base}credit-sales`);
  const changed = { code: 'TOTAL_CHANGED', expected: 250, current: 285, vat: { ...VAT_14_EXCLUDED, startDate: '2000-01-01' }, message: 'x' };

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

  it('refreshes the VAT settings when the screen opens', () => {
    expect(fakeVat().refreshCalls).toBe(1);
  });

  it('sends the receivable it showed as expectedTotal (VAT off 250)', () => {
    fill();
    component.saveCreditSale();
    const request = post();
    expect(request.request.body.expectedTotal).toBe(250);
    request.flush({ _id: 'cs1' }, { status: 201, statusText: 'Created' });
    expect(component.successDialogVisible).toBeTrue();
  });

  it('409 TOTAL_CHANGED: takes the server\'s VAT block, keeps the review open with the new total; confirming saves with it', () => {
    fill();
    component.reviewDialogVisible = true;
    component.saveCreditSale();
    expect(component.totalReceivable).toBe(250);
    post().flush(changed, { status: 409, statusText: 'Conflict' });
    expect(fakeVat().appliedVat.length).toBe(1);
    expect(component.totalReceivable).toBe(285);
    expect(component.totalChangedNotice).toEqual({ expected: 250, current: 285 });
    expect(component.reviewDialogVisible).toBeTrue();
    expect(component.errorDialogVisible).toBeFalse();
    expect(component.isSaving).toBeFalse();
    http.expectNone(`${base}credit-sales`);

    component.saveCreditSale();
    const retry = post();
    expect(retry.request.body.expectedTotal).toBe(285);
    expect(retry.request.body.items).toEqual([{ productId: 'p1', quantity: 4, price: 35 }, { productId: 'p2', quantity: 2, price: 65 }]);
    retry.flush({ _id: 'cs2' }, { status: 201, statusText: 'Created' });
    expect(component.successDialogVisible).toBeTrue();
  });

  it('a unit price with more than two decimals is refused before the review opens', () => {
    fill();
    component.lineItemControls[1].get('price')!.setValue(10.005);
    expect(component.lineItemControls[1].get('price')!.hasError('decimals')).toBeTrue();
    component.openReviewDialog();
    expect(component.reviewDialogVisible).toBeFalse();
    expect(component.saveError).toBe('vat.priceDecimals');
    http.expectNone(`${base}credit-sales`);
  });
});
