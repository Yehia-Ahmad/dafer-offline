import { TestBed } from '@angular/core/testing';
import { lockRefreshSpy } from '../../../../test-setup.spec';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { CreditSalesListComponent } from './credit-sales-list.component';
import { LockDateService } from '../../../../core/accounting-lock/lock-date.service';

/** Stage 10: /credit-sales list — GET /credit-sales params and the payment POST (same body as the customer page). */
describe('CreditSalesListComponent payloads (Stage 10)', () => {
  const base = environment.api_base_url;
  let component: CreditSalesListComponent;
  let http: HttpTestingController;
  const params = (req: TestRequest) =>
    Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
  const invoice = (id: string, remainingAmount: number, dueDate: string | null = null) => ({
    _id: id, invoiceId: id, customerId: 'cu1', customerName: 'م. سامي', customerPhone: '01001234567', sellingDate: '2026-10-20T00:00:00.000Z', dueDate,
    status: remainingAmount ? 'partially_paid' : 'paid', totalPrice: 2100, paidAmount: 2100 - remainingAmount, remainingAmount, discountAmount: 0, shippingFees: 0,
    itemCount: 1, totalQuantity: 3, payments: [{ _id: 'p', amount: 2100 - remainingAmount, paymentDate: '2026-10-20', note: null }], refunds: [],
    items: [{ _id: 'i', productId: 'p1', productName: 'كشاف', productCode: 'EM-01', productQuantity: 3, productPricePerEach: 700, totalPrice: 2100 }],
  });
  const flushList = (expected: Record<string, string>, data = [invoice('cs1', 1600, '2026-01-01'), invoice('cs2', 0)]) => {
    const req = http.expectOne((r) => r.url === `${base}credit-sales` && r.method === 'GET');
    expect(params(req)).toEqual(expected);
    req.flush({ success: true, data, pagination: { page: Number(expected['page']), limit: 10, totalItems: 23, totalPages: 3, hasNextPage: true, hasPrevPage: false } });
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CreditSalesListComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(CreditSalesListComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(CreditSalesListComponent).componentInstance;
    component.ngOnInit();
    http.expectOne(`${base}shop-profile`).flush({});
    flushList({ page: '1', limit: '10' });
  });

  afterEach(() => http.verify());

  it('re-reads the lock date when it opens (Stage 22 review)', () => {
    expect(lockRefreshSpy()).toHaveBeenCalled();
  });

  it('loads, selects the first invoice, KPIs; overdue = due date passed with money remaining', () => {
    expect(component.rows.length).toBe(2);
    expect(component.selected?.id).toBe('cs1');
    expect(component.pagination.totalItems).toBe(23);
    expect(component.pageRemaining).toBe(1600);
    expect(component.isOverdue(component.rows[0])).toBeTrue();
    expect(component.isOverdue(component.rows[1])).toBeFalse();
  });

  it('search: name → customerName, digits → customerPhone; status pill; pages', () => {
    component.query = '  سامي ';
    component.search();
    flushList({ customerName: 'سامي', page: '1', limit: '10' });
    component.query = '0100 123';
    component.search();
    flushList({ customerPhone: '0100 123', page: '1', limit: '10' });
    component.setStatus('partially_paid');
    flushList({ customerPhone: '0100 123', status: 'partially_paid', page: '1', limit: '10' });
    component.setStatus('returned');
    flushList({ customerPhone: '0100 123', status: 'returned', page: '1', limit: '10' });
    component.goToPage(2);
    flushList({ customerPhone: '0100 123', status: 'returned', page: '2', limit: '10' });
    component.clearSearch();
    flushList({ status: 'returned', page: '1', limit: '10' });
  });

  it('payment: POST credit-sales/:id/payments {amount, paymentDate, note}, then the page reloads', () => {
    component.paymentForm.patchValue({ amount: 600, paymentDate: new Date(2026, 10, 3), note: '  دفعة تانية ' });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs1/payments`);
    expect(req.request.method).toBe('POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ amount: 600, paymentDate: '2026-11-03', note: 'دفعة تانية' }));
    req.flush({});
    flushList({ page: '1', limit: '10' });
    expect(component.paymentSaved).toBeTrue();
  });

  it('a receipt dated inside a closed period sends nothing; on the first open day it does (Stage 22 review)', () => {
    TestBed.inject(LockDateService).set('2026-10-31');
    component.paymentForm.patchValue({ amount: 100, paymentDate: new Date(2026, 9, 15) });
    component.savePayment();
    http.expectNone((r) => r.url.includes('/payments'));
    component.paymentForm.patchValue({ paymentDate: new Date(2026, 10, 1) });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs1/payments`);
    expect(req.request.body.paymentDate).toBe('2026-11-01');
    req.flush({});
    flushList({ page: '1', limit: '10' });
  });

  it('payment without note → note undefined (dropped); no request without an amount or on a paid invoice', () => {
    component.savePayment();
    http.expectNone((r) => r.url.includes('/payments'));

    component.paymentForm.patchValue({ amount: 100, paymentDate: new Date(2026, 10, 3) });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs1/payments`);
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ amount: 100, paymentDate: '2026-11-03' }));
    req.flush({ message: 'x' }, { status: 400, statusText: 'Bad Request' });
    expect(component.paymentError).toBe('x');

    component.select(component.rows[1]);
    component.paymentForm.patchValue({ amount: 100 });
    component.savePayment();
    http.expectNone((r) => r.url.includes('/payments'));
  });
});
