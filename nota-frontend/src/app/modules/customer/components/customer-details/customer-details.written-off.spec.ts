import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { LanguageService } from '../../../shared/services/translation.service';
import { CustomerDetailsComponent } from './customer-details.component';
import { MAIN_ONLY_BOXES } from '../../../cashbox/testing/payment-boxes.testing';

const base = environment.api_base_url;
const MESSAGE_KEY = 'invoiceHistoryPage.cancel.blocked.writtenOff';

const invoice = (id: string, writtenOff: boolean) => ({
  _id: id, invoiceId: id, number: `CR-${id}`, customerId: 'cu1', sellingDate: '2026-10-20T00:00:00.000Z', dueDate: null, status: 'paid',
  discountAmount: 0, shippingFees: 0, totalPrice: 1000, paidAmount: 1000, remainingAmount: 0, itemCount: 1, totalQuantity: 5, notes: null, refunds: [],
  returnedPaidAmount: 0, reallocatedPaidAmount: 0,
  payments: writtenOff ? [{ _id: `${id}-w`, amount: 1000, paymentDate: '2026-10-25', note: 'قيد يدوي JE-000009', source: 'manual_entry' }] : [{ _id: `${id}-p`, amount: 1000, paymentDate: '2026-10-25', note: null }],
  items: [{ _id: `${id}-i`, productId: 'p1', productName: 'بانل', productCode: 'PNL-24', categoryName: 'لمبات', productQuantity: 5, productPricePerEach: 200, totalPrice: 1000 }],
});

/** Stage 22 review: a written-off invoice shows "الفاتورة عليها قيد دين معدوم؛ اعكس القيد الأول" in the return and cancel dialogs, before submit. */
describe('CustomerDetailsComponent: an invoice with an unreversed write-off', () => {
  let http: HttpTestingController;
  let component: CustomerDetailsComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<CustomerDetailsComponent>>;
  const text = () => document.body.textContent || '';
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomerDetailsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cu1' })), snapshot: { paramMap: convertToParamMap({ id: 'cu1' }) } } }],
    }).compileComponents();
    signInAs('owner');
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CustomerDetailsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne(`${base}customers/cu1`).flush({ _id: 'cu1', name: 'م. سامي', phone: '01001234567', createdAt: '2026-09-01T00:00:00.000Z', creditSummary: { totalInvoices: 2, remainingAmount: 0 }, creditHistory: [invoice('a', true), invoice('b', false)] });
    http.expectOne(`${base}customers/cu1/statement`).flush({ lines: [], totals: { debit: 0, credit: 0, balance: 0 } });
    await settle();
  });
  afterEach(() => {
    component.closeRefundDialog(); component.closeDeleteCreditDialog();
    http.match((request) => request.url === `${base}cashbox/payment-boxes`).forEach((request) => request.flush(MAIN_ONLY_BOXES)); // the dialogs' box picker
    http.verify();
  });

  const history = () => component.customer!.creditHistory as Array<{ writtenOff: boolean }>;

  it('the return dialog shows the message and its submit is disabled; an ordinary invoice shows neither', async () => {
    component.openRefundDialog(history()[0] as never);
    await settle();
    expect(text()).toContain(MESSAGE_KEY);
    const submit = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('customerDetailsPage.refundDialog.save')) as HTMLButtonElement;
    expect(submit.disabled).toBeTrue();
    component.closeRefundDialog();
    await settle();
    component.openRefundDialog(history()[1] as never);
    await settle();
    expect(text()).not.toContain(MESSAGE_KEY);
    expect((Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('customerDetailsPage.refundDialog.save')) as HTMLButtonElement).disabled).toBeFalse();
  });

  it('the cancel dialog shows the message and its submit stays disabled even with a reason', async () => {
    component.openDeleteCreditDialog(history()[0] as never);
    component.cancelReason = 'سبب كافي';
    await settle();
    expect(text()).toContain(MESSAGE_KEY);
    const submit = Array.from(document.querySelectorAll('button[notaButton="danger"], button')).find((button) => button.textContent?.includes('invoiceHistoryPage.cancel.action')) as HTMLButtonElement;
    expect(submit.disabled).toBeTrue();
  });
});
