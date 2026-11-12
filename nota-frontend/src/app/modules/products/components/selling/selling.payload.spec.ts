import { TestBed } from '@angular/core/testing';
import { lockRefreshSpy } from '../../../../test-setup.spec';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { SellingComponent } from './selling.component';

/**
 * Stage 9 payload safety: builds every /selling request from sample input and asserts the exact
 * URL, params and body (including key order). Template-free on purpose, so the same spec runs
 * against the screen before and after the redesign.
 */
describe('SellingComponent payloads (Stage 9 safety)', () => {
  const base = environment.api_base_url;
  let component: SellingComponent;
  let http: HttpTestingController;

  const input = (value: string) => ({ target: { value } }) as unknown as Event;
  const product = (id: string, name: string, code: string, wholesalePrice: number, retailPrice: number) => ({
    _id: id, name, code, wholesalePrice, retailPrice, discountPercentage: 0, priceAfterDiscount: retailPrice,
    inventoryCount: 10, category: { _id: 'c1', name: 'لمبات' },
  });

  const searchAndPick = (index: number, query: string, result: object) => {
    component.onSearchInputChange(index, input(query));
    const req = http.expectOne((r) => r.url === `${base}products/search`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys()).toEqual(['q']);
    expect(req.request.params.get('q')).toBe(query);
    req.flush([result]);
    component.onNativeOptionSelect(index, component.getInvoiceItemState(index).productOptions[0]);
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

  /** Two lines: wholesale 60 × 3, custom 150 × 1; discount 15; shipping 20. */
  const fillStandardInvoice = () => {
    pickCustomer();
    searchAndPick(0, 'LED', product('p1', 'لمبة LED ١٨ وات', 'LED-18', 60, 75));
    component.getInvoiceItem(0).get('quantity')!.setValue(3);
    component.addInvoiceItem(false);
    searchAndPick(1, 'EXT', product('p2', 'مشترك ٥ مخارج', 'EXT-5', 120, 140));
    component.getInvoiceItem(1).get('priceType')!.setValue('custom');
    component.getInvoiceItem(1).get('price')!.setValue(150);
    component.sellingForm.get('sellingDate')!.setValue(new Date(2026, 10, 4));
    component.sellingForm.get('discountAmount')!.setValue(15);
    component.sellingForm.get('shippingFees')!.setValue(20);
  };

  const expectedBody = (confirm: boolean) => ({
    customerName: 'م. سامي',
    customerPhone: '01001234567',
    sellingDate: '2026-11-04',
    discountAmount: 15,
    discountPercentage: 4.55,
    shippingFees: 20,
    confirmInsufficientInventory: confirm,
    // Stage 21 review: the total the cashier saw (330 - 15 + 20); the server compares it with its own.
    expectedTotal: 335,
    items: [
      { productId: 'p1', quantity: 3, price: 60 },
      { productId: 'p2', quantity: 1, price: 150 },
    ],
  });

  const expectSellingPost = (): TestRequest => {
    const req = http.expectOne(`${base}sellings`);
    expect(req.request.method).toBe('POST');
    expect(req.request.params.keys()).toEqual([]);
    return req;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SellingComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    })
      .overrideComponent(SellingComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(SellingComponent).componentInstance;
    component.ngOnInit();
  });

  afterEach(() => http.verify());

  it('re-reads the lock date when it opens (Stage 22 review)', () => {
    expect(lockRefreshSpy()).toHaveBeenCalled();
  });

  it('POST sellings: exact body for customer + wholesale line + custom-price line + discount + shipping', () => {
    fillStandardInvoice();
    component.saveSelling();
    const req = expectSellingPost();
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify(expectedBody(false)));
    req.flush({ _id: 's1' }, { status: 201, statusText: 'Created' });
    expect(component.successDialogVisible).toBeTrue();
  });

  it('discount larger than the subtotal is bounded to the subtotal (100%)', () => {
    fillStandardInvoice();
    component.sellingForm.get('discountAmount')!.setValue(1000);
    component.saveSelling();
    const req = expectSellingPost();
    expect(req.request.body.discountAmount).toBe(330);
    expect(req.request.body.discountPercentage).toBe(100);
    req.flush({});
  });

  it('retail price type sends the retail price', () => {
    fillStandardInvoice();
    component.getInvoiceItem(0).get('priceType')!.setValue('retailPrice');
    component.saveSelling();
    const req = expectSellingPost();
    expect(req.request.body.items[0]).toEqual({ productId: 'p1', quantity: 3, price: 75 });
    req.flush({});
  });

  it('409 INSUFFICIENT_INVENTORY → confirm resends the same body with confirmInsufficientInventory: true', () => {
    fillStandardInvoice();
    component.saveSelling();
    expectSellingPost().flush(
      {
        code: 'INSUFFICIENT_INVENTORY', requiresConfirmation: true,
        shortages: [{ productId: 'p1', productName: 'لمبة LED ١٨ وات', requestedQuantity: 3, availableQuantity: 1, missingQuantity: 2 }],
      },
      { status: 409, statusText: 'Conflict' }
    );
    expect(component.inventoryConfirmationVisible).toBeTrue();
    expect(component.inventoryShortages.length).toBe(1);

    component.confirmInsufficientInventory();
    const retry = expectSellingPost();
    expect(JSON.stringify(retry.request.body)).toBe(JSON.stringify(expectedBody(true)));
    retry.flush({});
  });

  it('409 → cancel sends nothing more', () => {
    fillStandardInvoice();
    component.saveSelling();
    expectSellingPost().flush(
      { code: 'INSUFFICIENT_INVENTORY', requiresConfirmation: true, shortages: [{ productId: 'p1', requestedQuantity: 3, availableQuantity: 1, missingQuantity: 2 }] },
      { status: 409, statusText: 'Conflict' }
    );
    component.cancelInsufficientInventory();
    expect(component.inventoryConfirmationVisible).toBeFalse();
    http.expectNone(`${base}sellings`);
  });

  it('"price below purchase price" (400) shows the backend message in the error dialog', () => {
    fillStandardInvoice();
    component.saveSelling();
    const message = 'سعر البيع لا يمكن أن يكون أقل من سعر الشراء للمنتج مشترك ٥ مخارج';
    expectSellingPost().flush({ message }, { status: 400, statusText: 'Bad Request' });
    expect(component.saveError).toBe(message);
    expect(component.errorDialogVisible).toBeTrue();
  });

  it('no request when the customer name is missing', () => {
    searchAndPick(0, 'LED', product('p1', 'لمبة', 'LED-18', 60, 75));
    component.saveSelling();
    http.expectNone(`${base}sellings`);
  });

  it('typed customer without a phone sends an empty phone string', () => {
    searchAndPick(0, 'LED', product('p1', 'لمبة', 'LED-18', 60, 75));
    component.sellingForm.patchValue({ customerName: '  زبون نقدي  ', sellingDate: new Date(2026, 10, 4) });
    component.saveSelling();
    const req = expectSellingPost();
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      customerName: 'زبون نقدي', customerPhone: '', sellingDate: '2026-11-04', discountAmount: 0, discountPercentage: 0,
      shippingFees: 0, confirmInsufficientInventory: false, expectedTotal: 60, items: [{ productId: 'p1', quantity: 1, price: 60 }],
    }));
    req.flush({});
  });
});
