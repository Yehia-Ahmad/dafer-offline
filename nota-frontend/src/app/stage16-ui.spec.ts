import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { flushPaymentBoxes } from './modules/cashbox/testing/payment-boxes.testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { signInWith } from './core/auth/testing/sign-in';
import { CustomerDetailsComponent } from './modules/customer/components/customer-details/customer-details.component';
import { CustomersComponent } from './modules/customer/components/customers/customers.component';
import { CreditSalesListComponent } from './modules/products/components/credit-sales-list/credit-sales-list.component';
import { InvoiceHistoryComponent } from './modules/products/components/invoice-history/invoice-history.component';
import { ProductProfitReportComponent } from './modules/products/components/product-profit-report/product-profit-report.component';
import { ProductFormComponent } from './modules/category/components/product-form/product-form.component';
import { ProductsPageComponent } from './modules/category/components/products-page/products-page.component';
import { CatalogStateService } from './modules/layout/nav/catalog-state.service';
import { environment } from '../environments/environment';

const base = environment.api_base_url;
const commonProviders = () => [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()];

describe('Stage 16 invoice history UI', () => {
  let http: HttpTestingController;
  const rows = [
    {
      _id: 's1', number: 'INV-12', status: 'cancelled', cancellationReason: 'إدخال مكرر', sellingDate: '2026-11-01',
      totalPrice: 500, refundedAmount: 100, netTotal: 400, refundStatus: 'partial',
      items: [{ _id: 'i1', productId: 'p1', productName: 'لمبة', productQuantity: 2, productPricePerEach: 250, totalPrice: 500 }],
    },
    {
      _id: 's2', number: 'INV-13', sellingDate: '2026-11-02', totalPrice: 300, refundedAmount: 300, netTotal: 0, refundStatus: 'full',
      items: [{ _id: 'i2', productId: 'p2', productName: 'كشاف', productQuantity: 1, productPricePerEach: 300, totalPrice: 300 }],
    },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InvoiceHistoryComponent, TranslateModule.forRoot()],
      providers: commonProviders(),
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(TranslateService).setTranslation('en', {
      invoiceHistoryPage: { cancel: { cashSummary: 'Stock goes back; refund {{amount}}.' } },
    }, true);
    TestBed.inject(TranslateService).use('en');
  });

  afterEach(() => (flushPaymentBoxes(http), http.verify()));

  function render(permissions: string[] = ['sales.view', 'returns.create']) {
    signInWith(permissions);
    const fixture = TestBed.createComponent(InvoiceHistoryComponent);
    fixture.detectChanges();
    http.expectOne(`${base}categories`).flush([]);
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne((r) => r.url === `${base}sellings`).flush({ success: true, data: rows, pagination: { page: 1, limit: 10, totalItems: 2, totalPages: 1 } });
    fixture.detectChanges();
    return fixture;
  }

  it('renders the number, cancelled badge and reason; cancel is permission-locked without sales.delete', () => {
    const fixture = render();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('INV-12');
    expect(text).toContain('invoiceHistoryPage.cancel.cancelled');
    expect(text).toContain('إدخال مكرر');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="delete-locked"]')).not.toBeNull();
  });

  it('shows original, returns and net; a full return has net zero and no enabled return action', () => {
    const fixture = render();
    fixture.componentInstance.selectSelling(fixture.componentInstance.sellings[1]);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('invoiceHistoryPage.cancel.originalTotal');
    expect(text).toContain('invoiceHistoryPage.s10.refundedAmount');
    expect(text).toContain('invoiceHistoryPage.cancel.netTotal');
    const returnButton = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
      .find((button) => button.textContent?.includes('invoiceHistoryPage.actions.createReturn')) as HTMLButtonElement;
    expect(returnButton.disabled).toBeTrue();
    expect(fixture.componentInstance.selectedSelling?.netTotal).toBe(0);
  });

  it('cash cancel summary states stock restoration and the computed refund amount', () => {
    const fixture = render(['sales.view', 'sales.delete']);
    fixture.componentInstance.openDeleteDialog(fixture.componentInstance.sellings[0]);
    fixture.detectChanges();
    const summary = document.body.querySelector('[data-testid="cash-cancel-summary"]')?.textContent || '';
    expect(summary).toContain('Stock goes back');
    expect(summary).toMatch(/400|٤٠٠/);
  });
});

describe('Stage 16 product archive UI', () => {
  it('labels a sold product as archive and an unsold product as permanent delete', async () => {
    await TestBed.configureTestingModule({
      imports: [ProductFormComponent, TranslateModule.forRoot()],
      providers: [
        ...commonProviders(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'p1' })), snapshot: { params: { id: 'p1' } } } },
      ],
    }).compileComponents();
    signInWith(['products.view', 'products.manage']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ProductFormComponent);
    fixture.componentInstance.product = { _id: 'p1', name: 'قديم', soldItemCount: 2 } as any;
    fixture.componentInstance.deleteVisible = true;
    fixture.detectChanges();
    expect(document.body.querySelector('[data-testid="product-delete-kind"]')?.textContent).toContain('category.deleteProduct.archiveMessage');
    fixture.componentInstance.product = { _id: 'p2', name: 'جديد', soldItemCount: 0 } as any;
    fixture.detectChanges();
    expect(document.body.querySelector('[data-testid="product-delete-kind"]')?.textContent).toContain('category.deleteProduct.deleteMessage');
    await new Promise((resolve) => setTimeout(resolve, 110));
    http.expectOne(`${base}products/p1`).flush({ _id: 'p1', name: 'قديم', soldItemCount: 2, category: { _id: 'c1', specifications: [] } });
    (flushPaymentBoxes(http), http.verify());
  });

  it('hides archived controls without products.manage', async () => {
    await TestBed.configureTestingModule({
      imports: [ProductsPageComponent, TranslateModule.forRoot()],
      providers: [
        ...commonProviders(),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      ],
    }).compileComponents();
    signInWith(['products.view']);
    TestBed.inject(CatalogStateService).categories.set([]);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ProductsPageComponent);
    fixture.detectChanges();
    http.match(() => true).forEach((request) => request.flush(request.request.url.endsWith('products')
      ? { success: true, data: [{ _id: 'p1', name: 'قديم', isArchived: true }], pagination: { page: 1, limit: 10, totalPages: 1, hasNextPage: false } }
      : []));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).not.toContain('productsPage.showArchived');
    expect(text).not.toContain('productsPage.restore');
    (flushPaymentBoxes(http), http.verify());
  });
});

describe('Stage 16 customer statement UI', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomerDetailsComponent, TranslateModule.forRoot()],
      providers: [
        ...commonProviders(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cu1' })), snapshot: { paramMap: convertToParamMap({ id: 'cu1' }) } } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(TranslateService).setTranslation('en', {
      customerDetailsPage: { s10: { statement: { customerCredit: 'Money owed to the customer: {{amount}}' } } },
    }, true);
    TestBed.inject(TranslateService).use('en');
    signInWith(['customers.view', 'credit.view']);
  });

  afterEach(() => (flushPaymentBoxes(http), http.verify()));

  it('renders opening, invoice, payment, return, cancel and down-payment refund with debit/credit/balance', () => {
    const fixture = TestBed.createComponent(CustomerDetailsComponent);
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne(`${base}customers/cu1`).flush({ _id: 'cu1', name: 'سامي', phone: '0100', creditHistory: [], creditSummary: {} });
    http.expectOne(`${base}customers/cu1/statement`).flush({
      lines: [
        { type: 'opening', date: '2026-10-01', description: 'رصيد أول المدة', debit: 100, credit: 0, balance: 100 },
        { type: 'invoice', date: '2026-10-02', number: 'CR-1', description: 'فاتورة آجل', debit: 500, credit: 0, balance: 600 },
        { type: 'payment', date: '2026-10-03', number: 'PAY-1', description: 'دفعة', debit: 0, credit: 200, balance: 400 },
        { type: 'return', date: '2026-10-04', number: 'RET-1', description: 'مرتجع', debit: 0, credit: 100, balance: 300 },
        { type: 'cancel', date: '2026-10-05', number: 'CR-2', description: 'إلغاء فاتورة آجل', debit: 0, credit: 400, balance: -100 },
        { type: 'cancel', date: '2026-10-05', number: 'PAY-2', description: 'رد المقدم', debit: 50, credit: 0, balance: -50 },
      ],
      totals: { debit: 650, credit: 700, balance: -50 },
    });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    for (const label of ['رصيد أول المدة', 'فاتورة آجل', 'دفعة', 'مرتجع', 'إلغاء فاتورة آجل', 'رد المقدم']) expect(text).toContain(label);
    expect(text).toContain('customerDetailsPage.s10.statement.debit');
    expect(text).toContain('customerDetailsPage.s10.statement.credit');
    expect(text).toContain('customerDetailsPage.s10.statement.balance');
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="customer-credit-balance"]')?.textContent).toContain('Money owed to the customer');
  });

  it('starts with statement loading and replaces stale data with an error and retry', () => {
    const fixture = TestBed.createComponent(CustomerDetailsComponent);
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne(`${base}customers/cu1`).flush({ _id: 'cu1', name: 'سامي', phone: '0100', creditHistory: [], creditSummary: {} });
    expect(fixture.componentInstance.statementLoading).toBeTrue();
    const first = http.expectOne(`${base}customers/cu1/statement`);
    first.flush({ message: 'statement unavailable' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(fixture.componentInstance.statement.rows).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="statement-error"]')?.textContent).toContain('statement unavailable');
    fixture.componentInstance.retryStatement();
    expect(fixture.componentInstance.statementLoading).toBeTrue();
    http.expectOne(`${base}customers/cu1/statement`).flush({ lines: [], totals: { debit: 0, credit: 0, balance: 0 } });
    expect(fixture.componentInstance.statementError).toBe('');
  });
});

describe('Stage 16 labels and permission-sensitive notes', () => {
  it('credit list uses the returned label', async () => {
    await TestBed.configureTestingModule({ imports: [CreditSalesListComponent, TranslateModule.forRoot()], providers: commonProviders() }).compileComponents();
    signInWith(['credit.view']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CreditSalesListComponent);
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne((r) => r.url === `${base}credit-sales`).flush({ success: true, data: [{
      _id: 'c1', number: 'CR-1', status: 'returned', totalPrice: 100, netTotal: 0, paidAmount: 0, remainingAmount: 0, items: [], payments: [], refunds: [],
    }], pagination: { page: 1, limit: 10, totalItems: 1, totalPages: 1 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('creditSalePage.list.status.returned');
    (flushPaymentBoxes(http), http.verify());
  });

  it('credit panel shows original, returns, net, paid, remaining, and cancellation reason', async () => {
    await TestBed.configureTestingModule({ imports: [CreditSalesListComponent, TranslateModule.forRoot()], providers: commonProviders() }).compileComponents();
    signInWith(['credit.view']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CreditSalesListComponent);
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne((r) => r.url === `${base}credit-sales`).flush({ success: true, data: [{
      _id: 'c1', number: 'CR-1', status: 'cancelled', cancellationReason: 'فاتورة مكررة', totalPrice: 300,
      refundedAmount: 50, netTotal: 250, paidAmount: 100, remainingAmount: 0, items: [], payments: [], refunds: [],
    }], pagination: { page: 1, limit: 10, totalItems: 1, totalPages: 1 } });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    for (const label of ['invoiceHistoryPage.cancel.originalTotal', 'invoiceHistoryPage.s10.refundedAmount', 'invoiceHistoryPage.cancel.netTotal', 'creditSalePage.list.paid', 'creditSalePage.list.remaining', 'فاتورة مكررة']) {
      expect(text).toContain(label);
    }
    (flushPaymentBoxes(http), http.verify());
  });

  it('customer delete dialog has no stock-restore question', async () => {
    await TestBed.configureTestingModule({ imports: [CustomersComponent, TranslateModule.forRoot()], providers: commonProviders() }).compileComponents();
    signInWith(['customers.view', 'customers.manage']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CustomersComponent);
    fixture.detectChanges();
    http.expectOne(`${base}customers`).flush([{ _id: 'cu1', name: 'سامي', phone: '0100' }]);
    fixture.componentInstance.promptDelete(fixture.componentInstance.customers[0]);
    fixture.detectChanges();
    const text = document.body.textContent || '';
    expect(text).toContain('customerPage.messages.deleteConfirm');
    expect(text).not.toContain('restore stock');
    expect(text).not.toContain('استرجاع المخزون');
    (flushPaymentBoxes(http), http.verify());
  });

  it('estimated-cost note is hidden without products.viewCost and shown with it', async () => {
    await TestBed.configureTestingModule({ imports: [ProductProfitReportComponent, TranslateModule.forRoot()], providers: commonProviders() }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const render = (permissions: string[]) => {
      signInWith(permissions);
      const fixture = TestBed.createComponent(ProductProfitReportComponent);
      fixture.detectChanges();
      http.expectOne(`${base}categories`).flush([]);
      http.expectOne(`${base}products/profit-report`).flush({ data: [] });
      http.expectOne((r) => r.url === `${base}products/profit-bar`).flush({ year: 2026, months: [], totalProfit: 0 });
      fixture.componentInstance.selectedReportRow = { productId: 'p1', productName: 'x', categoryName: 'c', totalProfit: 1, lastSellingDate: null, lastSellingPrice: null, invoices: [{
        id: 'i1', invoiceNumber: 'INV-1', type: 'cash', sellingDate: null, sellingPrice: 10, purchasePrice: 5, quantity: 1, profit: 5, customerName: null, costEstimated: true,
      }] };
      fixture.componentInstance.invoiceDialogVisible = true;
      fixture.detectChanges();
      return document.body.textContent || '';
    };
    expect(render(['reports.profit'])).not.toContain('profitReportPage.dialog.costEstimated');
    expect(render(['reports.profit', 'products.viewCost'])).toContain('profitReportPage.dialog.costEstimated');
    (flushPaymentBoxes(http), http.verify());
  });
});
