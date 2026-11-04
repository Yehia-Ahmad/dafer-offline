import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { CreditSalesComponent } from './credit-sales.component';

/**
 * Stage 9 payload safety: builds every /credit-sales request from sample input and asserts the exact
 * URL, params and body (including key order). Template-free on purpose, so the same spec runs
 * against the screen before and after the redesign.
 */
describe('CreditSalesComponent payloads (Stage 9 safety)', () => {
  const base = environment.api_base_url;
  let component: CreditSalesComponent;
  let http: HttpTestingController;

  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const product = (id: string, name: string, code: string, wholesalePrice: number, retailPrice: number | null) => ({
    _id: id, name, code, wholesalePrice, retailPrice, inventoryCount: 10, category: { _id: 'c1', name: 'لمبات' },
  });

  const searchAndPick = (index: number, query: string, result: object) => {
    component.onSearchInputChange(index, input(query));
    const req = http.expectOne((r) => r.url === `${base}products/search`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys()).toEqual(['q']);
    expect(req.request.params.get('q')).toBe(query);
    req.flush([result]);
    component.onNativeOptionSelect(index, component.getLineItemState(index).productOptions[0]);
  };

  const pickCustomer = () => {
    component.onCustomerSearchInputChange(input('سامي'));
    const req = http.expectOne((r) => r.url === `${base}customers`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys()).toEqual(['search']);
    expect(req.request.params.get('search')).toBe('سامي');
    req.flush({ data: { customers: [{ _id: 'cu1', name: 'م. سامي', phone: '01001234567' }] } });
    component.onCustomerOptionSelect(component.customerOptions[0]);
  };

  /** Panel 320 × 5 (retail) + flood light 240 × 2 (retail); discount 40. */
  const fillItems = () => {
    searchAndPick(0, 'PNL', product('p1', 'بانل سقف ٢٤ وات', 'PNL-24', 300, 320));
    component.lineItemControls[0].get('quantity')!.setValue(5);
    component.addLineItem();
    searchAndPick(1, 'FL', product('p2', 'كشاف خارجي ٥٠ وات', 'FL-50', 200, 240));
    component.lineItemControls[1].get('quantity')!.setValue(2);
    component.creditSaleForm.patchValue({ sellingDate: new Date(2026, 10, 4), discountAmount: 40 });
  };

  const expectCreditPost = (): TestRequest => {
    const req = http.expectOne(`${base}credit-sales`);
    expect(req.request.method).toBe('POST');
    expect(req.request.params.keys()).toEqual([]);
    return req;
  };

  const items = [
    { productId: 'p1', quantity: 5, price: 320 },
    { productId: 'p2', quantity: 2, price: 240 },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CreditSalesComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(CreditSalesComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(CreditSalesComponent).componentInstance;
    component.ngOnInit();
  });

  afterEach(() => http.verify());

  it('POST credit-sales with a selected customer sends customerId (no name/phone) and no initialPaidAmount', () => {
    pickCustomer();
    fillItems();
    component.saveCreditSale();
    const req = expectCreditPost();
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      sellingDate: '2026-11-04', discountAmount: 40, discountPercentage: 1.92, shippingFees: 0,
      initialPaidAmount: undefined, items, customerId: 'cu1',
    }));
    expect('initialPaidAmount' in req.request.body).toBeTrue();
    expect(req.request.body.initialPaidAmount).toBeUndefined();
    req.flush({ _id: 'cs1' }, { status: 201, statusText: 'Created' });
    expect(component.successDialogVisible).toBeTrue();
  });

  it('POST credit-sales for a new customer sends name + phone, shipping and the down payment', () => {
    component.creditSaleForm.patchValue({ customerName: ' ورشة النور ', customerPhone: ' 01119876543 ' });
    fillItems();
    component.creditSaleForm.patchValue({ shippingFees: 30, downPayment: 500 });
    component.saveCreditSale();
    const req = expectCreditPost();
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      sellingDate: '2026-11-04', discountAmount: 40, discountPercentage: 1.92, shippingFees: 30,
      initialPaidAmount: 500, items, customerName: 'ورشة النور', customerPhone: '01119876543',
    }));
    req.flush({});
  });

  it('editing the picked customer name drops customerId and sends name + phone', () => {
    pickCustomer();
    component.creditSaleForm.get('customerName')!.setValue('م. سامي للمقاولات');
    component.clearSelectedCustomerIfEdited();
    fillItems();
    component.saveCreditSale();
    const req = expectCreditPost();
    expect(req.request.body.customerId).toBeUndefined();
    expect(req.request.body.customerName).toBe('م. سامي للمقاولات');
    expect(req.request.body.customerPhone).toBe('01001234567');
    req.flush({});
  });

  it('fractional quantity is floored and an edited unit price is sent', () => {
    pickCustomer();
    fillItems();
    component.lineItemControls[0].get('quantity')!.setValue(2.7);
    component.lineItemControls[1].get('price')!.setValue(255.5);
    component.saveCreditSale();
    const req = expectCreditPost();
    expect(req.request.body.items).toEqual([
      { productId: 'p1', quantity: 2, price: 320 },
      { productId: 'p2', quantity: 2, price: 255.5 },
    ]);
    req.flush({});
  });

  it('no request when the down payment exceeds the total', () => {
    pickCustomer();
    fillItems();
    component.creditSaleForm.patchValue({ downPayment: 999999 });
    component.saveCreditSale();
    expect(component.isDownPaymentExceeded()).toBeTrue();
    http.expectNone(`${base}credit-sales`);
  });

  it('no request when the customer phone is missing', () => {
    component.creditSaleForm.patchValue({ customerName: 'ورشة النور' });
    fillItems();
    component.saveCreditSale();
    http.expectNone(`${base}credit-sales`);
  });

  it('backend error message is shown in the error dialog', () => {
    pickCustomer();
    fillItems();
    component.saveCreditSale();
    expectCreditPost().flush({ message: 'سعر البيع لا يمكن أن يكون أقل من سعر الشراء' }, { status: 400, statusText: 'Bad Request' });
    expect(component.saveError).toBe('سعر البيع لا يمكن أن يكون أقل من سعر الشراء');
    expect(component.errorDialogVisible).toBeTrue();
  });
  // ---------- Stage 10 (after-only): optional due date + note, retailPrice fallback ----------

  it('Stage 10: due date and note are appended only when filled', () => {
    pickCustomer();
    fillItems();
    component.creditSaleForm.patchValue({ dueDate: new Date(2026, 11, 3), notes: '  موقع عمارة الجلاء ' });
    component.saveCreditSale();
    const req = expectCreditPost();
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      sellingDate: '2026-11-04', discountAmount: 40, discountPercentage: 1.92, shippingFees: 0,
      initialPaidAmount: undefined, items, customerId: 'cu1', dueDate: '2026-12-03', notes: 'موقع عمارة الجلاء',
    }));
    req.flush({});
  });

  it('Stage 10: a blank note and no due date leave the body as before', () => {
    pickCustomer();
    fillItems();
    component.creditSaleForm.patchValue({ dueDate: null, notes: '   ' });
    component.saveCreditSale();
    const req = expectCreditPost();
    expect('dueDate' in req.request.body).toBeFalse();
    expect('notes' in req.request.body).toBeFalse();
    req.flush({});
  });

  it('Stage 10: a product without a retail price falls back to the wholesale price', () => {
    pickCustomer();
    searchAndPick(0, 'FL', product('p2', 'كشاف خارجي ٥٠ وات', 'FL-50', 200, null));
    expect(component.lineItemControls[0].get('price')!.value).toBe(200);
    component.creditSaleForm.patchValue({ sellingDate: new Date(2026, 10, 4) });
    component.saveCreditSale();
    const req = expectCreditPost();
    expect(req.request.body.items).toEqual([{ productId: 'p2', quantity: 1, price: 200 }]);
    req.flush({});
  });
});
