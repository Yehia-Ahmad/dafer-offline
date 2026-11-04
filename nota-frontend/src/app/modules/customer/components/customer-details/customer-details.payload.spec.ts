import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { CustomerDetailsComponent } from './customer-details.component';

/** Stage 10 payload safety for /customers/:id. Template-free so it runs unchanged before and after the redesign. */
describe('CustomerDetailsComponent payloads (Stage 10 safety)', () => {
  const base = environment.api_base_url;
  let component: CustomerDetailsComponent;
  let http: HttpTestingController;

  const invoice = (id: string, sellingDate: string, remainingAmount: number) => ({
    _id: id, invoiceId: id, customerId: 'cu1', sellingDate, dueDate: null, status: remainingAmount ? 'partially_paid' : 'paid',
    discountAmount: 0, shippingFees: 0, totalPrice: 1000, paidAmount: 1000 - remainingAmount, remainingAmount,
    itemCount: 1, totalQuantity: 5, notes: null, refunds: [], returnedPaidAmount: 0, reallocatedPaidAmount: 0,
    payments: [{ _id: `${id}-pay`, amount: 1000 - remainingAmount, paymentDate: sellingDate, note: null }],
    items: [{ _id: `${id}-i`, productId: 'p1', productName: 'بانل', productCode: 'PNL-24', categoryName: 'لمبات', productQuantity: 5, productPricePerEach: 200, totalPrice: 1000 }],
  });
  const customer = {
    _id: 'cu1', name: 'م. سامي', phone: '01001234567', createdAt: '2026-09-01T00:00:00.000Z',
    lastCreditSaleDate: '2026-10-20', lastCashSaleDate: null, lastCreditSalePaymentDate: '2026-10-20',
    creditSummary: { totalInvoices: 2, remainingAmount: 900 },
    creditHistory: [invoice('cs2', '2026-10-20T00:00:00.000Z', 600), invoice('cs1', '2026-10-01T00:00:00.000Z', 300)],
  };
  const flushCustomer = () => {
    const req = http.expectOne(`${base}customers/cu1`);
    expect(req.request.method).toBe('GET');
    req.flush(customer);
  };
  const history = () => component.customer!.creditHistory as any[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomerDetailsComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cu1' })), snapshot: { paramMap: convertToParamMap({ id: 'cu1' }) } } },
      ],
    })
      .overrideComponent(CustomerDetailsComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(CustomerDetailsComponent).componentInstance;
    component.ngOnInit();
    http.expectOne(`${base}shop-profile`).flush({});
    flushCustomer();
  });

  afterEach(() => http.verify());

  it('invoice payment: POST credit-sales/:id/payments {amount, paymentDate, note}', () => {
    component.openPaymentDialog(history()[0]);
    component.paymentForm.patchValue({ amount: 250, paymentDate: new Date(2026, 10, 4), note: '  دفعة تانية ' });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs2/payments`);
    expect(req.request.method).toBe('POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ amount: 250, paymentDate: '2026-11-04', note: 'دفعة تانية' }));
    req.flush({});
    flushCustomer();
  });

  it('empty note is sent as undefined (dropped from the JSON)', () => {
    component.openPaymentDialog(history()[1]);
    component.paymentForm.patchValue({ amount: 100, paymentDate: new Date(2026, 10, 4), note: '  ' });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs1/payments`);
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ amount: 100, paymentDate: '2026-11-04' }));
    expect('note' in req.request.body).toBeTrue();
    req.flush({});
    flushCustomer();
  });

  it('customer payment: last invoice (default) and first invoice targets', () => {
    component.openCustomerPaymentDialog();
    component.paymentForm.patchValue({ amount: 50, paymentDate: new Date(2026, 10, 4) });
    component.savePayment();
    http.expectOne(`${base}credit-sales/cs1/payments`).flush({});
    flushCustomer();

    component.openCustomerPaymentDialog();
    component.setPaymentTarget('first', true);
    component.paymentForm.patchValue({ amount: 50, paymentDate: new Date(2026, 10, 4) });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs2/payments`);
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ amount: 50, paymentDate: '2026-11-04' }));
    req.flush({});
    flushCustomer();
  });

  it('no payment request without an amount', () => {
    component.openPaymentDialog(history()[0]);
    component.savePayment();
    http.expectNone((r) => r.url.includes('/payments'));
  });

  it('credit refund: POST returns {returnType, invoiceId, refundDate, note, items}', () => {
    component.openRefundDialog(history()[0]);
    component.refundForm.patchValue({ refundDate: new Date(2026, 10, 4), note: ' عيب ' });
    component.refundItems.at(0).get('quantity')!.setValue(2);
    component.saveRefund();
    const req = http.expectOne(`${base}returns`);
    expect(req.request.method).toBe('POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({
      returnType: 'credit', invoiceId: 'cs2', refundDate: '2026-11-04', note: 'عيب', items: [{ productId: 'p1', quantity: 2 }],
    }));
    req.flush({});
    flushCustomer();
  });

  it('no refund request with zero quantities or above the max', () => {
    component.openRefundDialog(history()[0]);
    component.saveRefund();
    component.refundItems.at(0).get('quantity')!.setValue(9);
    component.saveRefund();
    http.expectNone(`${base}returns`);
  });

  it('delete credit invoice: DELETE credit-sales/:id, then reload', () => {
    component.openDeleteCreditDialog(history()[1]);
    component.deleteCreditInvoice();
    const req = http.expectOne(`${base}credit-sales/cs1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({});
    flushCustomer();
  });
});
