import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { CustomerDetailsComponent } from './customer-details.component';
import { signInAs } from '../../../../core/auth/testing/sign-in';

/** Stage 11: the per-invoice "إضافة دفعة" button is back on each open invoice card (real template). */
describe('CustomerDetailsComponent invoice payment button (Stage 11)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<CustomerDetailsComponent>;
  let component: CustomerDetailsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  const invoice = (id: string, sellingDate: string, remainingAmount: number) => ({
    _id: id, invoiceId: id, customerId: 'cu1', sellingDate, dueDate: null, status: remainingAmount ? 'partially_paid' : 'paid',
    discountAmount: 0, shippingFees: 0, totalPrice: 1000, paidAmount: 1000 - remainingAmount, remainingAmount,
    itemCount: 1, totalQuantity: 5, notes: null, refunds: [], returnedPaidAmount: 0, reallocatedPaidAmount: 0,
    payments: [{ _id: `${id}-pay`, amount: 1000 - remainingAmount, paymentDate: sellingDate, note: null }],
    items: [{ _id: `${id}-i`, productId: 'p1', productName: 'بانل', productCode: 'PNL-24', categoryName: 'لمبات', productQuantity: 5, productPricePerEach: 200, totalPrice: 1000 }],
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomerDetailsComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cu1' })), snapshot: { paramMap: convertToParamMap({ id: 'cu1' }) } } },
      ],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    fixture = TestBed.createComponent(CustomerDetailsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.match(`${base}shop-profile`).forEach((r) => r.flush({}));
    http.expectOne(`${base}customers/cu1`).flush({
      _id: 'cu1', name: 'م. سامي', phone: '01001234567', createdAt: '2026-09-01T00:00:00.000Z',
      creditSummary: { totalInvoices: 2, remainingAmount: 600 },
      creditHistory: [invoice('cs2', '2026-10-20T00:00:00.000Z', 600), invoice('cs1', '2026-10-01T00:00:00.000Z', 0)],
    });
    component.setTab('invoices');
    fixture.detectChanges();
  });

  it('shows the button only on open invoices; it opens the payment dialog for that invoice and posts the same body', () => {
    const buttons = el().querySelectorAll<HTMLButtonElement>('[data-action="invoice-payment"]');
    expect(buttons.length).toBe(1);
    buttons[0].click();
    expect(component.paymentDialogVisible).toBeTrue();
    expect(component.paymentDialogMode).toBe('invoice');
    expect(component.selectedInvoiceForPayment?.id).toBe('cs2');

    component.paymentForm.patchValue({ amount: 250, paymentDate: new Date(2026, 10, 4), note: '' });
    component.savePayment();
    const req = http.expectOne(`${base}credit-sales/cs2/payments`);
    expect(req.request.method).toBe('POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ amount: 250, paymentDate: '2026-11-04' }));
  });
});
