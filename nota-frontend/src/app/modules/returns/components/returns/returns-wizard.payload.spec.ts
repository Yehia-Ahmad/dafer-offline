import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { ReturnsComponent } from './returns.component';

/**
 * Stage 10 new-return wizard: invoice search uses the existing list endpoints, and the POST /returns bodies are
 * the ones the invoice-history (cash) and customer page (credit) dialogs send.
 */
describe('ReturnsComponent new-return wizard (Stage 10)', () => {
  const base = environment.api_base_url;
  let component: ReturnsComponent;
  let http: HttpTestingController;
  const params = (req: TestRequest) =>
    Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
  const flushLog = () => {
    http.expectOne((r) => r.url === `${base}returns`).flush({ success: true, data: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false } });
    http.expectOne((r) => r.url === `${base}returns/summary`).flush({ totalCashReturns: 0, totalCreditReturns: 0, totalReturnedAmount: 0, totalReturnedItems: 0 });
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReturnsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(ReturnsComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(ReturnsComponent).componentInstance;
    component.ngOnInit();
    flushLog();
    component.openWizard();
  });

  afterEach(() => http.verify());

  it('cash: GET sellings by name → pick → POST returns with the invoice-history body', () => {
    component.wizardQuery = ' زبون ';
    component.searchWizardInvoices();
    const search = http.expectOne((r) => r.url === `${base}sellings`);
    expect(params(search)).toEqual({ customerName: 'زبون', page: '1', limit: '10' });
    search.flush({ success: true, data: [{
      _id: 's1', invoiceId: 's1', customerName: 'زبون', customerPhone: '0100', sellingDate: '2026-11-03', totalPrice: 300,
      items: [{ productId: 'p1', productName: 'لمبة', productQuantity: 3, productPricePerEach: 60 }, { productId: 'p2', productName: 'مشترك', productQuantity: 1, productPricePerEach: 120 }],
      refunds: [{ items: [{ productId: 'p1', quantity: 1 }] }],
    }], pagination: {} });
    expect(component.wizardResults.length).toBe(1);

    component.pickWizardInvoice(component.wizardResults[0]);
    expect(component.wizardStep).toBe(2);
    expect(component.wizardLines[0].returnedBefore).toBe(1);
    component.stepWizardQuantity(component.wizardLines[0], 1);
    component.stepWizardQuantity(component.wizardLines[0], 1);
    component.wizardLines[0].reason = ' كسر ';
    expect(component.wizardEstimatedAmount).toBe(120);
    component.goToWizardStep(3);
    component.wizardDate = new Date(Date.UTC(2026, 10, 4, 12));
    component.wizardNote = ' عيب ';
    component.confirmWizardReturn();

    const post = http.expectOne(`${base}returns`);
    expect(post.request.method).toBe('POST');
    expect(JSON.stringify(post.request.body)).toBe(JSON.stringify({
      returnType: 'cash', invoiceId: 's1', returnDate: '2026-11-04', note: 'عيب', items: [{ productId: 'p1', quantity: 2, returnReason: 'كسر' }],
    }));
    post.flush({});
    flushLog();
    expect(component.view).toBe('log');
  });

  it('credit: GET credit-sales by phone → POST returns with the customer-page body (refundDate, note undefined)', () => {
    component.setWizardType('credit');
    component.wizardQuery = '0122 555';
    component.searchWizardInvoices();
    const search = http.expectOne((r) => r.url === `${base}credit-sales`);
    expect(params(search)).toEqual({ customerPhone: '0122 555', page: '1', limit: '10' });
    search.flush({ success: true, data: [{
      _id: 'cs1', invoiceId: 'cs1', customerName: 'محمد', customerPhone: '01225550199', sellingDate: '2026-10-15', status: 'partially_paid',
      totalPrice: 2800, paidAmount: 800, remainingAmount: 2000, refunds: [],
      items: [{ _id: 'i1', productId: 'p9', productName: 'كشاف طوارئ', productQuantity: 4, productPricePerEach: 275, totalPrice: 1100 }],
    }], pagination: {} });

    component.pickWizardInvoice(component.wizardResults[0]);
    component.wizardLines[0].quantity = 9; // capped at the sold quantity
    component.goToWizardStep(3);
    component.wizardDate = new Date(2026, 10, 4);
    component.confirmWizardReturn();

    const post = http.expectOne(`${base}returns`);
    expect(JSON.stringify(post.request.body)).toBe(JSON.stringify({
      returnType: 'credit', invoiceId: 'cs1', refundDate: '2026-11-04', items: [{ productId: 'p9', quantity: 4 }],
    }));
    expect('note' in post.request.body).toBeTrue();
    post.flush({ message: 'تعذر' }, { status: 400, statusText: 'Bad Request' });
    expect(component.wizardSaveError).toBe('تعذر');
    expect(component.view).toBe('wizard');
  });

  it('no POST without selected quantities; empty search sends nothing', () => {
    component.searchWizardInvoices();
    http.expectNone((r) => r.url === `${base}sellings`);
    component.confirmWizardReturn();
    http.expectNone(`${base}returns`);
  });
});
