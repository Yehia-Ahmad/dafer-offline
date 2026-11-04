import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { InvoiceHistoryComponent } from './invoice-history.component';

/**
 * Stage 10 payload safety: every /invoice-history request built from sample input, asserting the exact URL,
 * params and body (key order included). Template-free so it runs unchanged before and after the redesign.
 */
describe('InvoiceHistoryComponent payloads (Stage 10 safety)', () => {
  const base = environment.api_base_url;
  let component: InvoiceHistoryComponent;
  let http: HttpTestingController;

  const params = (req: TestRequest) =>
    Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));

  const selling = {
    _id: 's1', invoiceId: 's1', customerName: 'زبون نقدي', customerPhone: '01001234567', sellingDate: '2026-11-03T10:00:00.000Z',
    itemCount: 2, totalQuantity: 4, discountAmount: 0, shippingFees: 0, totalPrice: 300, refundStatus: 'none', refunds: [],
    items: [
      { _id: 'i1', productId: 'p1', productName: 'لمبة', productCode: 'LED-18', productQuantity: 3, productPricePerEach: 60, totalPrice: 180 },
      { _id: 'i2', productId: 'p2', productName: 'مشترك', productCode: 'EXT-5', productQuantity: 1, productPricePerEach: 120, totalPrice: 120 },
    ],
  };
  const page = (data: unknown[], pageNo = 1, totalPages = 2) => ({
    success: true, data, pagination: { page: pageNo, limit: 10, totalItems: 12, totalPages, hasNextPage: pageNo < totalPages, hasPrevPage: pageNo > 1 },
  });

  const expectSellings = (expected: Record<string, string>, body = page([selling])) => {
    const req = http.expectOne((r) => r.url === `${base}sellings` && r.method === 'GET');
    expect(params(req)).toEqual(expected);
    req.flush(body);
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InvoiceHistoryComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(InvoiceHistoryComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(InvoiceHistoryComponent).componentInstance;
    component.ngOnInit();

    const categories = http.expectOne(`${base}categories`);
    expect(categories.request.method).toBe('GET');
    categories.flush([{ _id: 'c1', name: 'لمبات' }]);
    http.expectOne(`${base}shop-profile`).flush({});
    expectSellings({ page: '1', limit: '10' });
  });

  afterEach(() => http.verify());

  it('filters: category → GET products?categoryId; apply sends every filter + page/limit', () => {
    component.onCategoryFilterChange('c1');
    const products = http.expectOne((r) => r.url === `${base}products`);
    expect(products.request.method).toBe('GET');
    expect(params(products)).toEqual({ categoryId: 'c1' });
    products.flush({ success: true, data: [{ _id: 'p1', name: 'لمبة' }] });

    component.filterProductId = 'p1';
    component.filterCustomerName = '  سامي ';
    component.filterCustomerPhone = ' 0100 ';
    component.filterSellingDate = new Date(Date.UTC(2026, 10, 3, 12));
    component.applyFilters();
    expectSellings({
      categoryId: 'c1', productId: 'p1', customerName: 'سامي', customerPhone: '0100', sellingDate: '2026-11-03', page: '1', limit: '10',
    });
  });

  it('reset clears every filter', () => {
    component.filterCustomerName = 'x';
    component.resetFilters();
    expectSellings({ page: '1', limit: '10' });
  });

  it('next page keeps the filters and asks for page 2', () => {
    component.filterCustomerName = 'سامي';
    component.applyFilters();
    expectSellings({ customerName: 'سامي', page: '1', limit: '10' });
    (component as any).loadSellings(2, false);
    expectSellings({ customerName: 'سامي', page: '2', limit: '10' }, page([selling], 2));
  });

  it('cash return: exact POST returns body (only lines with quantity; reason/note only when filled)', () => {
    component.openReturnDialog(component.sellings[0]);
    component.cashReturnDate = new Date(Date.UTC(2026, 10, 4, 12));
    component.cashReturnNote = '  عيب  ';
    component.cashReturnItems[0].quantity = 2;
    component.cashReturnItems[0].returnReason = ' كسر ';
    component.createCashReturn();
    const req = http.expectOne(`${base}returns`);
    expect(req.request.method).toBe('POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      returnType: 'cash', invoiceId: 's1', returnDate: '2026-11-04', note: 'عيب',
      items: [{ productId: 'p1', quantity: 2, returnReason: 'كسر' }],
    }));
    req.flush({});
    expectSellings({ page: '1', limit: '10' });
  });

  it('cash return without note/reason; quantity capped at the available amount', () => {
    component.openReturnDialog(component.sellings[0]);
    component.cashReturnDate = new Date(Date.UTC(2026, 10, 4, 12));
    component.cashReturnItems[1].quantity = 9;
    component.createCashReturn();
    const req = http.expectOne(`${base}returns`);
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      returnType: 'cash', invoiceId: 's1', returnDate: '2026-11-04', items: [{ productId: 'p2', quantity: 1 }],
    }));
    req.flush({ message: 'x' }, { status: 400, statusText: 'Bad Request' });
    expect(component.returnError).toBe('x');
  });

  it('delete: DELETE sellings/:id and the row is removed', () => {
    component.openDeleteDialog(component.sellings[0]);
    component.deleteSelling();
    const req = http.expectOne(`${base}sellings/s1`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toBeNull();
    req.flush({ message: 'ok' });
    expect(component.sellings.length).toBe(0);
  });
});
