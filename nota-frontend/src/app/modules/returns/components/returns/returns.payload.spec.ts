import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatDialog } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { NEVER } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { ReturnsComponent } from './returns.component';
import { signInAs } from '../../../../core/auth/testing/sign-in';

/** Stage 10 payload safety for the returns log. Template-free so it runs unchanged before and after the redesign. */
describe('ReturnsComponent payloads (Stage 10 safety)', () => {
  const base = environment.api_base_url;
  let component: ReturnsComponent;
  let http: HttpTestingController;

  const params = (req: TestRequest) =>
    Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
  const log = { _id: 'r1', returnType: 'cash', invoiceId: 's1', invoiceNumber: 'INV-1', customerName: 'زبون', customerPhone: '0100',
    returnDate: '2026-11-03', note: '', items: [], subtotalReturnedAmount: 60, discountAmount: 0, shippingFees: 0, finalReturnedAmount: 60, createdAt: '' };

  const expectLoad = (list: Record<string, string>, summary: Record<string, string>) => {
    const listReq = http.expectOne((r) => r.url === `${base}returns`);
    expect(listReq.request.method).toBe('GET');
    expect(params(listReq)).toEqual(list);
    const summaryReq = http.expectOne((r) => r.url === `${base}returns/summary`);
    expect(summaryReq.request.method).toBe('GET');
    expect(params(summaryReq)).toEqual(summary);
    listReq.flush({ success: true, data: [log], pagination: { page: Number(list['page']), limit: Number(list['limit']), totalItems: 30, totalPages: 3, hasNextPage: true, hasPrevPage: false } });
    summaryReq.flush({ totalCashReturns: 1, totalCreditReturns: 0, totalReturnedAmount: 60, totalReturnedItems: 1 });
  };

  beforeEach(async () => {
    const dialogStub = { open: () => ({ afterClosed: () => NEVER, close: () => undefined }), closeAll: () => undefined };
    await TestBed.configureTestingModule({
      imports: [ReturnsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), { provide: MatDialog, useValue: dialogStub }],
    })
      .overrideComponent(ReturnsComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    component = TestBed.createComponent(ReturnsComponent).componentInstance;
    component.ngOnInit();
    expectLoad({ page: '1', limit: '10' }, {});
  });

  afterEach(() => http.verify());

  it('search sends every filter to the list (+page/limit) and the same filters to the summary', () => {
    component.filtersForm.patchValue({
      returnType: 'credit', customerName: ' سامي ', customerPhone: ' 0100 ', productCode: ' LED ', invoiceId: ' 64b000000000000000000001 ',
      dateFrom: new Date(2026, 9, 1), dateTo: new Date(2026, 10, 3),
    });
    component.search();
    const filters = {
      returnType: 'credit', customerName: 'سامي', customerPhone: '0100', productCode: 'LED', invoiceId: '64b000000000000000000001',
      dateFrom: '2026-10-01', dateTo: '2026-11-03',
    };
    expectLoad({ ...filters, page: '1', limit: '10' }, filters);
  });

  it('page change and page-size change', () => {
    component.onPageChange({ pageIndex: 1, pageSize: 10, length: 30 });
    expectLoad({ page: '2', limit: '10' }, {});
    component.onPageChange({ pageIndex: 1, pageSize: 25, length: 30 });
    expectLoad({ page: '1', limit: '25' }, {});
  });

  it('reset clears the filters', () => {
    component.filtersForm.patchValue({ customerName: 'x' });
    component.resetFilters();
    expectLoad({ page: '1', limit: '10' }, {});
  });

  it('details: GET returns/:id', () => {
    component.viewDetails(component.returns[0]);
    const req = http.expectOne(`${base}returns/r1`);
    expect(req.request.method).toBe('GET');
    req.flush({ success: true, data: { ...log, note: 'n' } });
    expect(component.selectedReturn?.note).toBe('n');
  });

  it('invalid date range sends nothing', () => {
    component.filtersForm.patchValue({ dateFrom: new Date(2026, 10, 5), dateTo: new Date(2026, 10, 1) });
    component.search();
    http.expectNone((r) => r.url.startsWith(`${base}returns`));
  });
});
